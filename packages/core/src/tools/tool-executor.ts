/**
 * Tool Executor for Popilot
 * Executes MCP-style tools directly
 *
 * TypeScript port of continuedev/src/transform/tool_call_filter.py (MCPToolExecutor)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn, execSync } from 'node:child_process';
import type { ToolDefinition, ToolResult } from '../types.js';

export interface ToolExecutorConfig {
  workspaceDir: string;
  timeout?: number;
}

export interface TextEdit {
  startLine: number;
  endLine: number;
  newText: string;
}

/**
 * Executes MCP-style tools directly.
 */
export class ToolExecutor {
  private workspaceDir: string;
  private timeout: number;

  // Tools that we handle directly
  static readonly SUPPORTED_TOOLS = new Set([
    'file.read',
    'file.search',
    'file.applyTextEdits',
    'create_new_file',
    'edit_file',
    'read_file',
    'run_terminal_command',
    'list_directory',
    'tree',
  ]);

  constructor(config: ToolExecutorConfig) {
    this.workspaceDir = config.workspaceDir;
    this.timeout = config.timeout ?? 60000;
  }

  /**
   * Check if tool is supported.
   */
  isSupported(toolName: string): boolean {
    return ToolExecutor.SUPPORTED_TOOLS.has(toolName);
  }

  /**
   * Execute a tool and return result.
   */
  async execute(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    const callId = crypto.randomUUID();

    try {
      let result: string;

      switch (toolName) {
        case 'read_file':
        case 'file.read':
          result = await this.execReadFile(args);
          break;
        case 'run_terminal_command':
          result = await this.execTerminalCommand(args);
          break;
        case 'list_directory':
          result = await this.execListDirectory(args);
          break;
        case 'tree':
          result = await this.execTree(args);
          break;
        case 'create_new_file':
          result = await this.execCreateFile(args);
          break;
        case 'edit_file':
          result = await this.execEditFile(args);
          break;
        case 'file.search':
          result = await this.execFileSearch(args);
          break;
        case 'file.applyTextEdits':
          result = await this.execApplyEdits(args);
          break;
        default:
          result = `[Error] Unknown tool: ${toolName}`;
      }

      return {
        callId,
        name: toolName,
        result,
        success: !result.startsWith('[Error]'),
      };
    } catch (error) {
      return {
        callId,
        name: toolName,
        result: `[Error] ${error instanceof Error ? error.message : String(error)}`,
        success: false,
      };
    }
  }

  /**
   * Resolve filepath relative to workspace.
   */
  private resolvePath(filepath: string): string {
    if (!filepath) {
      throw new Error('filepath is required');
    }
    if (path.isAbsolute(filepath)) {
      return filepath;
    }
    return path.join(this.workspaceDir, filepath);
  }

  /**
   * Find similar files when file not found.
   * Extracts filename and searches for it in workspace.
   */
  private findSimilarFiles(filepath: string): string[] {
    const filename = path.basename(filepath);
    const nameWithoutExt = path.basename(filename, path.extname(filename));

    try {
      // Use find command to search for files with same name
      // Exclude node_modules, .git, dist, .turbo directories
      const findCmd = `find . -type f -name "${filename}" \\
        -not -path "*/node_modules/*" \\
        -not -path "*/.git/*" \\
        -not -path "*/dist/*" \\
        -not -path "*/.turbo/*" \\
        2>/dev/null | head -5`;

      const result = execSync(findCmd, {
        cwd: this.workspaceDir,
        encoding: 'utf-8',
        timeout: 5000,
      });

      const matches = result.trim().split('\n').filter(Boolean).map(f => f.replace(/^\.\//, ''));

      // If no exact matches, try partial name match
      if (matches.length === 0 && nameWithoutExt.length > 3) {
        const partialCmd = `find . -type f -name "*${nameWithoutExt}*" \\
          -not -path "*/node_modules/*" \\
          -not -path "*/.git/*" \\
          -not -path "*/dist/*" \\
          -not -path "*/.turbo/*" \\
          2>/dev/null | head -5`;

        const partialResult = execSync(partialCmd, {
          cwd: this.workspaceDir,
          encoding: 'utf-8',
          timeout: 5000,
        });

        return partialResult.trim().split('\n').filter(Boolean).map(f => f.replace(/^\.\//, ''));
      }

      return matches;
    } catch {
      return [];
    }
  }

  /**
   * Build file not found error with suggestions.
   */
  private buildFileNotFoundError(filepath: string): string {
    const similarFiles = this.findSimilarFiles(filepath);

    let error = `[Error] File not found: ${filepath}`;

    if (similarFiles.length > 0) {
      error += `\n\n[Suggestion] Did you mean one of these files?\n`;
      error += similarFiles.map(f => `  - ${f}`).join('\n');
      error += `\n\nPlease retry with the correct path.`;
    }

    return error;
  }

  /**
   * Read file contents.
   */
  private async execReadFile(args: Record<string, unknown>): Promise<string> {
    const filepath = this.resolvePath(String(args.filepath ?? ''));

    try {
      const content = await fs.promises.readFile(filepath, 'utf-8');
      const sha256 = crypto.createHash('sha256').update(content).digest('hex');
      const lines = content.split('\n');
      return `SHA256: ${sha256}\nLines: ${lines.length}\n\n${content}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return this.buildFileNotFoundError(filepath);
      }
      throw error;
    }
  }

  /**
   * Execute terminal command.
   */
  private async execTerminalCommand(args: Record<string, unknown>): Promise<string> {
    const command = String(args.command ?? '');
    if (!command) {
      return '[Error] command is required';
    }

    return new Promise((resolve) => {
      const child = spawn('sh', ['-c', command], {
        cwd: this.workspaceDir,
        timeout: this.timeout,
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        let output = '';
        if (stdout) output += stdout;
        if (stderr) output += `\n[stderr]\n${stderr}`;
        resolve(output.trim() || '(no output)');
      });

      child.on('error', (error) => {
        resolve(`[Error] ${error.message}`);
      });

      // Timeout handling
      setTimeout(() => {
        child.kill();
        resolve('[Error] Command timed out');
      }, this.timeout);
    });
  }

  /**
   * List directory contents.
   */
  private async execListDirectory(args: Record<string, unknown>): Promise<string> {
    const dirpath = args.dirpath ? this.resolvePath(String(args.dirpath)) : this.workspaceDir;

    try {
      const entries = await fs.promises.readdir(dirpath, { withFileTypes: true });
      const formatted = entries
        .map((entry) => {
          const prefix = entry.isDirectory() ? '[DIR]' : '[FILE]';
          return `${prefix} ${entry.name}`;
        })
        .sort();

      return formatted.length > 0 ? formatted.join('\n') : '(empty directory)';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return `[Error] Directory not found: ${dirpath}`;
      }
      throw error;
    }
  }

  /**
   * Show directory tree structure recursively.
   */
  private async execTree(args: Record<string, unknown>): Promise<string> {
    const dirpath = args.dirpath ? this.resolvePath(String(args.dirpath)) : this.workspaceDir;
    const maxDepth = (args.depth as number) || 3;

    // Directories to skip
    const skipDirs = new Set(['node_modules', '.git', '.turbo', 'dist', 'build', '.next', '__pycache__', '.popilot_log']);

    const buildTree = async (dir: string, prefix: string, depth: number): Promise<string[]> => {
      if (depth > maxDepth) return [];

      const lines: string[] = [];
      try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        // Sort: directories first, then files
        entries.sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });

        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          const isLast = i === entries.length - 1;
          // Use simple ASCII connectors to avoid JSON parsing issues on backend
          const connector = '- ';
          const newPrefix = prefix + '  ';

          if (entry.isDirectory()) {
            if (skipDirs.has(entry.name)) {
              lines.push(`${prefix}${connector}${entry.name}/ (skipped)`);
            } else {
              lines.push(`${prefix}${connector}${entry.name}/`);
              const subTree = await buildTree(path.join(dir, entry.name), newPrefix, depth + 1);
              lines.push(...subTree);
            }
          } else {
            lines.push(`${prefix}${connector}${entry.name}`);
          }
        }
      } catch {
        lines.push(`${prefix}(error reading directory)`);
      }
      return lines;
    };

    try {
      const rootName = path.basename(dirpath) || dirpath;
      const tree = await buildTree(dirpath, '', 1);
      return [`${rootName}/`, ...tree].join('\n') || '(empty directory)';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return `[Error] Directory not found: ${dirpath}`;
      }
      throw error;
    }
  }

  /**
   * Create a new file.
   */
  private async execCreateFile(args: Record<string, unknown>): Promise<string> {
    const filepath = this.resolvePath(String(args.filepath ?? ''));
    const content = String(args.content ?? args.contents ?? '');

    try {
      await fs.promises.mkdir(path.dirname(filepath), { recursive: true });
      await fs.promises.writeFile(filepath, content, 'utf-8');
      return `Successfully created file: ${filepath}`;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Edit an existing file.
   */
  private async execEditFile(args: Record<string, unknown>): Promise<string> {
    const filepath = this.resolvePath(String(args.filepath ?? ''));
    const content = String(args.content ?? args.contents ?? '');

    try {
      await fs.promises.access(filepath);
    } catch {
      return this.buildFileNotFoundError(filepath);
    }

    try {
      await fs.promises.writeFile(filepath, content, 'utf-8');
      return `Successfully edited file: ${filepath}`;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Search for pattern in file.
   */
  private async execFileSearch(args: Record<string, unknown>): Promise<string> {
    const filepath = this.resolvePath(String(args.filepath ?? ''));
    const pattern = String(args.pattern ?? '');

    if (!pattern) {
      return '[Error] pattern is required';
    }

    try {
      const content = await fs.promises.readFile(filepath, 'utf-8');
      const sha256 = crypto.createHash('sha256').update(content).digest('hex');
      const lines = content.split('\n');
      const regex = new RegExp(pattern);

      const matches: string[] = [];
      lines.forEach((line, i) => {
        if (regex.test(line)) {
          matches.push(`Line ${i + 1}: ${line.trimEnd()}`);
        }
      });

      if (matches.length === 0) {
        return `No matches found for pattern: ${pattern}\nSHA256: ${sha256}`;
      }

      return `Found ${matches.length} matches:\n${matches.slice(0, 50).join('\n')}\n\nSHA256: ${sha256}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return this.buildFileNotFoundError(filepath);
      }
      throw error;
    }
  }

  /**
   * Apply text edits to file (atomic operation).
   */
  private async execApplyEdits(args: Record<string, unknown>): Promise<string> {
    const filepath = this.resolvePath(String(args.filepath ?? ''));
    const expectedSha = String(args.expectedSha256 ?? '');
    let edits = args.edits as TextEdit[] | string;

    // Parse edits if string
    if (typeof edits === 'string') {
      try {
        edits = JSON.parse(edits);
      } catch {
        return '[Error] Invalid edits JSON';
      }
    }

    if (!Array.isArray(edits) || edits.length === 0) {
      return '[Error] edits is required';
    }

    try {
      const content = await fs.promises.readFile(filepath, 'utf-8');
      const currentSha = crypto.createHash('sha256').update(content).digest('hex');

      if (expectedSha && currentSha !== expectedSha) {
        return `[Error] SHA256 mismatch! Expected: ${expectedSha.slice(0, 16)}..., Got: ${currentSha.slice(0, 16)}...\nFile was modified. Please re-read and retry.`;
      }

      const lines = content.split('\n');

      // Sort edits by startLine descending to apply from bottom to top
      const sortedEdits = [...edits].sort((a, b) => (b.startLine ?? 0) - (a.startLine ?? 0));

      for (const edit of sortedEdits) {
        const start = (edit.startLine ?? 1) - 1; // Convert to 0-indexed
        const end = edit.endLine ?? start + 1;
        const newText = edit.newText ?? '';

        // Validate range
        if (start < 0 || end > lines.length) {
          return `[Error] Invalid range: ${start + 1}-${end}, file has ${lines.length} lines`;
        }

        // Replace lines
        const newLines = newText ? newText.trimEnd().split('\n') : [];
        lines.splice(start, end - start, ...newLines);
      }

      // Write back
      const newContent = lines.join('\n');
      await fs.promises.writeFile(filepath, newContent, 'utf-8');

      const newSha = crypto.createHash('sha256').update(newContent).digest('hex');
      return `Successfully applied ${edits.length} edit(s) to ${filepath}\nNew SHA256: ${newSha}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return this.buildFileNotFoundError(filepath);
      }
      throw error;
    }
  }

  /**
   * Get tool definitions for all supported tools.
   */
  static getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'read_file',
        description: 'Read the contents of a file',
        parameters: {
          filepath: {
            type: 'string',
            description: 'Path to the file to read',
            required: true,
          },
        },
        requiresConfirmation: false,
        riskLevel: 'low',
      },
      {
        name: 'run_terminal_command',
        description: 'Execute a shell command',
        parameters: {
          command: {
            type: 'string',
            description: 'Command to execute',
            required: true,
          },
        },
        requiresConfirmation: true,
        riskLevel: 'high',
      },
      {
        name: 'list_directory',
        description: 'List contents of a directory',
        parameters: {
          dirpath: {
            type: 'string',
            description: 'Path to the directory',
            required: false,
          },
        },
        requiresConfirmation: false,
        riskLevel: 'low',
      },
      {
        name: 'create_new_file',
        description: 'Create a new file with specified content',
        parameters: {
          filepath: {
            type: 'string',
            description: 'Path for the new file',
            required: true,
          },
          content: {
            type: 'string',
            description: 'Content to write to the file',
            required: true,
          },
        },
        requiresConfirmation: true,
        riskLevel: 'medium',
      },
      {
        name: 'edit_file',
        description: 'Replace the entire content of an existing file',
        parameters: {
          filepath: {
            type: 'string',
            description: 'Path to the file to edit',
            required: true,
          },
          content: {
            type: 'string',
            description: 'New content for the file',
            required: true,
          },
        },
        requiresConfirmation: true,
        riskLevel: 'medium',
      },
      {
        name: 'file.applyTextEdits',
        description: 'Apply specific text edits to a file (atomic operation)',
        parameters: {
          filepath: {
            type: 'string',
            description: 'Path to the file',
            required: true,
          },
          expectedSha256: {
            type: 'string',
            description: 'Expected SHA256 hash of the file before editing',
            required: true,
          },
          edits: {
            type: 'array',
            description: 'Array of edits with startLine, endLine, and newText',
            required: true,
          },
        },
        requiresConfirmation: true,
        riskLevel: 'medium',
      },
    ];
  }
}
