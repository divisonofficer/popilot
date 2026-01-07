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
import type { ToolDefinition, ToolResult, FileAttachment } from '../types.js';
import { contentToDataUrl } from '../types.js';

// Threshold for file attachment (chars) - files larger than this get uploaded
const FILE_ATTACHMENT_THRESHOLD = 2000;

export interface ToolExecutorConfig {
  workspaceDir: string;
  timeout?: number;
}

export interface TextEdit {
  startLine: number;
  endLine?: number;
  newText: string;
  /**
   * Operation mode:
   * - 'insert': Insert newText BEFORE startLine, delete nothing (endLine is ignored)
   * - 'replace': Replace lines from startLine to endLine (inclusive) with newText
   * - Default: 'replace' if endLine >= startLine, 'insert' if endLine < startLine or endLine is omitted
   */
  mode?: 'insert' | 'replace';
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
    'file.find',
    'file.applyTextEdits',
    'find_files',
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
      let fileAttachment: FileAttachment | undefined;

      switch (toolName) {
        case 'read_file':
        case 'file.read': {
          const readResult = await this.execReadFile(args);
          result = readResult.result;
          fileAttachment = readResult.fileAttachment;
          break;
        }
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
        case 'file.find':
        case 'find_files':
          result = this.execFindFiles(args);
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
        fileAttachment,
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
   * Try to auto-correct filepath if file doesn't exist.
   * Returns corrected path if exactly one match found, null otherwise.
   */
  private tryAutoCorrectPath(filepath: string): { corrected: string; originalPath: string } | null {
    const resolved = this.resolvePath(filepath);

    // If file exists, no correction needed
    if (fs.existsSync(resolved)) {
      return null;
    }

    // Find similar files
    const similarFiles = this.findSimilarFiles(filepath);

    // Auto-correct only if exactly one match
    if (similarFiles.length === 1) {
      return {
        corrected: similarFiles[0],
        originalPath: filepath,
      };
    }

    return null;
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
   * Returns result string and optional file attachment for large files.
   */
  private async execReadFile(args: Record<string, unknown>): Promise<{ result: string; fileAttachment?: FileAttachment }> {
    const inputPath = String(args.filepath ?? '');

    // Validate filepath first
    const pathValidation = this.validateFilePath(inputPath);
    if (!pathValidation.valid) {
      return {
        result: `[Error] Invalid filepath: ${pathValidation.error}\n\nTip: Use find_files tool first to get the exact file path, then use that path here.`,
      };
    }

    // Try auto-correction if file doesn't exist
    const autoCorrect = this.tryAutoCorrectPath(inputPath);
    const filepath = autoCorrect ? this.resolvePath(autoCorrect.corrected) : this.resolvePath(inputPath);
    const correctionNote = autoCorrect
      ? `[Auto-corrected] ${autoCorrect.originalPath} -> ${autoCorrect.corrected}\n`
      : '';

    try {
      const content = await fs.promises.readFile(filepath, 'utf-8');
      const sha256 = crypto.createHash('sha256').update(content).digest('hex');
      const lines = content.split('\n');
      const filename = path.basename(filepath);

      // Check if file is large enough to warrant attachment
      if (content.length >= FILE_ATTACHMENT_THRESHOLD) {
        // Large file: create attachment and return metadata
        const fileId = `file_${Date.now()}`;
        const fileAttachment: FileAttachment = {
          id: fileId,
          name: filename,
          url: contentToDataUrl(content, filename),
        };

        // Include line numbers in the content for the attachment
        const numberedContent = lines.map((line, i) => `${String(i + 1).padStart(String(lines.length).length, ' ')}| ${line}`).join('\n');
        fileAttachment.url = contentToDataUrl(numberedContent, filename);

        const result = `${correctionNote}[file.read SUCCESS] ${filepath}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SHA256: ${sha256}
Total lines: ${lines.length}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📎 FILE UPLOADED: ${filename} (${content.length} chars)

The COMPLETE file content has been uploaded as an attachment.
You have access to the FULL content - do NOT summarize or say "file is too long".

Use SHA256 above for file.applyTextEdits when modifying this file.

Preview (first 20 lines):
${lines.slice(0, 20).map((line, i) => `${String(i + 1).padStart(4, ' ')}| ${line}`).join('\n')}${lines.length > 20 ? '\n...' : ''}`;

        return { result, fileAttachment };
      }

      // Small file: include full content inline
      return {
        result: `${correctionNote}SHA256: ${sha256}\nLines: ${lines.length}\n\n${content}`,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { result: this.buildFileNotFoundError(filepath) };
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
   * Fuzzy match score calculator (VS Code Ctrl+P style)
   */
  private fuzzyMatch(query: string, target: string): { score: number; indices: number[] } | null {
    const queryLower = query.toLowerCase();
    const targetLower = target.toLowerCase();

    // Exact match
    if (targetLower === queryLower) {
      return { score: 1000, indices: Array.from({ length: target.length }, (_, i) => i) };
    }

    // Contains as substring
    const substringIdx = targetLower.indexOf(queryLower);
    if (substringIdx !== -1) {
      const indices = Array.from({ length: query.length }, (_, i) => substringIdx + i);
      return { score: substringIdx === 0 ? 500 : 200, indices };
    }

    // Fuzzy match - characters in order
    const indices: number[] = [];
    let queryIdx = 0;
    let lastMatchIdx = -1;
    let score = 0;
    let consecutiveBonus = 0;

    for (let i = 0; i < targetLower.length && queryIdx < queryLower.length; i++) {
      if (targetLower[i] === queryLower[queryIdx]) {
        indices.push(i);
        if (lastMatchIdx === i - 1) {
          consecutiveBonus += 10;
        } else {
          consecutiveBonus = 0;
        }
        // Word boundary bonus
        const prevChar = target[i - 1];
        if (i === 0 || prevChar === '/' || prevChar === '-' || prevChar === '_' || prevChar === '.') {
          score += 5;
        }
        score += 1 + consecutiveBonus;
        lastMatchIdx = i;
        queryIdx++;
      }
    }

    if (queryIdx !== queryLower.length) return null;

    // Penalty for spread-out matches
    if (indices.length > 1) {
      score -= Math.max(0, indices[indices.length - 1] - indices[0] - indices.length);
    }
    // Depth penalty
    score -= (target.match(/\//g) || []).length * 2;

    return { score, indices };
  }

  /**
   * Collect all files recursively (sync)
   */
  private collectFilesSync(dir: string, baseDir: string, maxDepth: number, depth: number = 0): string[] {
    const skipDirs = new Set(['node_modules', '.git', '.turbo', 'dist', 'build', '.next', '__pycache__', '.popilot_log', '.cache', 'coverage']);
    const files: string[] = [];

    if (depth > maxDepth) return files;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!skipDirs.has(entry.name)) {
            files.push(...this.collectFilesSync(path.join(dir, entry.name), baseDir, maxDepth, depth + 1));
          }
        } else {
          files.push(path.relative(baseDir, path.join(dir, entry.name)));
        }
      }
    } catch {
      // Ignore permission errors
    }

    return files;
  }

  /**
   * Find files using fuzzy matching (VS Code Ctrl+P style)
   */
  private execFindFiles(args: Record<string, unknown>): string {
    const query = String(args.query ?? args.pattern ?? args.name ?? '');
    const dirpath = args.dirpath ? this.resolvePath(String(args.dirpath)) : this.workspaceDir;
    const maxResults = Math.min(Number(args.maxResults) || 20, 50);

    if (!query) {
      return `[Error] query is required. Examples:
- "apptsx" → finds App.tsx
- "reqtrans" → finds request-transformer.ts
- "pkgjson" → finds package.json`;
    }

    try {
      // Collect all files
      const allFiles = this.collectFilesSync(dirpath, dirpath, 10);

      // Match and score
      const matches: { path: string; score: number }[] = [];
      for (const filePath of allFiles) {
        const filename = path.basename(filePath);
        const filenameMatch = this.fuzzyMatch(query, filename);
        const pathMatch = this.fuzzyMatch(query, filePath);

        const match = filenameMatch && pathMatch
          ? (filenameMatch.score >= pathMatch.score ? filenameMatch : pathMatch)
          : (filenameMatch || pathMatch);

        if (match) {
          const finalScore = filenameMatch ? match.score + 100 : match.score;
          matches.push({ path: filePath, score: finalScore });
        }
      }

      // Sort by score and limit
      matches.sort((a, b) => b.score - a.score);
      const topMatches = matches.slice(0, maxResults);

      if (topMatches.length === 0) {
        return `No files found matching: "${query}"

Tips:
- Try shorter query (e.g., "app" instead of "application")
- Use key characters (e.g., "rt" for "request-transformer")
- Include extension (e.g., "apptsx" for App.tsx)`;
      }

      return `Found ${topMatches.length} file(s) matching "${query}":\n${topMatches.map(m => `  - ${m.path}`).join('\n')}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return `[Error] Directory not found: ${dirpath}`;
      }
      return `[Error] Find failed: ${error instanceof Error ? error.message : String(error)}`;
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
   * Detect abbreviated/placeholder content that would corrupt files.
   * Returns error message if abbreviated content detected, null otherwise.
   */
  private detectAbbreviatedContent(content: string): string | null {
    // Patterns that indicate abbreviated/summarized content
    const abbreviationPatterns = [
      // Korean abbreviations
      { pattern: /\(생략\)/g, desc: '(생략)' },
      { pattern: /기존\s*(코드|내용|부분)\s*(유지|그대로)/g, desc: '기존 코드 유지' },
      { pattern: /아래로\s*교체/g, desc: '아래로 교체' },
      { pattern: /위와\s*동일/g, desc: '위와 동일' },
      { pattern: /나머지\s*(동일|유지)/g, desc: '나머지 동일' },

      // English abbreviations
      { pattern: /\.\.\.\s*(existing|rest|omitted|unchanged)/gi, desc: '... existing/omitted' },
      { pattern: /\/\*\s*\.\.\.\s*\*\//g, desc: '/* ... */' },
      { pattern: /\/\/\s*\.\.\./g, desc: '// ...' },
      { pattern: /\(omitted\)/gi, desc: '(omitted)' },
      { pattern: /\(rest of file\)/gi, desc: '(rest of file)' },
      { pattern: /\(unchanged\)/gi, desc: '(unchanged)' },
      { pattern: /\/\*\s*(rest|remaining)\s*(of\s*)?(file|code)\s*(unchanged|same|here)?\s*\*\//gi, desc: '/* rest of file */' },
      { pattern: /\/\/\s*(rest|remaining)\s*(of\s*)?(file|code)\s*(unchanged|same|here)?/gi, desc: '// rest of file' },

      // Placeholder patterns in comments
      { pattern: /\/\*[\s\S]{0,20}\.{3}[\s\S]{0,50}\*\//g, desc: '/* ... */' },
    ];

    for (const { pattern, desc } of abbreviationPatterns) {
      if (pattern.test(content)) {
        return `[Error] Detected abbreviated content pattern: "${desc}"

edit_file requires the COMPLETE file content, not abbreviated or summarized content.
This would corrupt the file by replacing real code with placeholder text.

To fix:
1. Use file.read to get the FULL current file content
2. Modify the content (add/remove/change lines as needed)
3. Call edit_file with the COMPLETE modified content (every line!)

NEVER use placeholders like "// ... existing code ..." or "(생략)" - include ALL code!`;
      }
    }

    // Additional check: if content is suspiciously short for a code file
    // (less than 10 lines and contains comment-like placeholder)
    const lines = content.split('\n');
    if (lines.length < 10) {
      const hasOnlyComments = lines.every(line =>
        line.trim() === '' ||
        line.trim().startsWith('//') ||
        line.trim().startsWith('/*') ||
        line.trim().startsWith('*')
      );
      if (hasOnlyComments && content.includes('...')) {
        return `[Error] Content appears to be abbreviated (only ${lines.length} lines, mostly comments with "...")

edit_file requires the COMPLETE file content. Please:
1. Use file.read to get the full file
2. Include ALL existing code
3. Only modify the specific parts you need to change`;
      }
    }

    return null;
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

    // Check for abbreviated content before writing
    const abbreviationError = this.detectAbbreviatedContent(content);
    if (abbreviationError) {
      return abbreviationError;
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
   * Validate filepath is not obviously invalid.
   */
  private validateFilePath(filepath: string): { valid: boolean; error?: string } {
    // Check for empty path
    if (!filepath || filepath.trim() === '') {
      return { valid: false, error: 'filepath is empty' };
    }

    // Check for Korean/CJK characters (likely placeholder text)
    const koreanPattern = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uD7B0-\uD7FF]/;
    if (koreanPattern.test(filepath)) {
      return {
        valid: false,
        error: `filepath contains Korean text: "${filepath}". Use find_files to get the exact path first!`
      };
    }

    // Check for Chinese/Japanese characters
    const cjkPattern = /[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]/;
    if (cjkPattern.test(filepath)) {
      return {
        valid: false,
        error: `filepath contains CJK characters: "${filepath}". Use find_files to get the exact path first!`
      };
    }

    // Check for placeholder patterns
    const placeholderPatterns = [
      /^\(.*\)$/,           // Just parentheses like "(exact path)"
      /정확한/,              // Korean "exact"
      /파일.*경로/,          // Korean "file path"
      /입력/,               // Korean "input"
      /<.*>/,               // Angle brackets like "<filepath>"
      /\[.*path.*\]/i,      // Brackets with "path"
      /your.*file/i,        // "your file"
      /example/i,           // "example"
      /placeholder/i,       // "placeholder"
    ];

    for (const pattern of placeholderPatterns) {
      if (pattern.test(filepath)) {
        return {
          valid: false,
          error: `filepath looks like a placeholder: "${filepath}". Use find_files to get the exact path!`
        };
      }
    }

    return { valid: true };
  }

  /**
   * Validate edit object structure.
   */
  private validateEdit(edit: unknown, index: number): { valid: boolean; error?: string } {
    if (typeof edit !== 'object' || edit === null) {
      return { valid: false, error: `Edit ${index}: not an object` };
    }

    const e = edit as Record<string, unknown>;

    // Check for startLine
    if (e.startLine === undefined && e.range === undefined) {
      return { valid: false, error: `Edit ${index}: missing startLine (got: ${JSON.stringify(edit)})` };
    }

    // If using range format, convert to our format
    if (e.range && typeof e.range === 'object') {
      const range = e.range as Record<string, unknown>;
      if (range.start && typeof range.start === 'object') {
        const start = range.start as Record<string, unknown>;
        if (typeof start.line === 'number') {
          (edit as TextEdit).startLine = (start.line as number) + 1; // Convert 0-indexed to 1-indexed
        }
      }
      if (range.end && typeof range.end === 'object') {
        const end = range.end as Record<string, unknown>;
        if (typeof end.line === 'number') {
          (edit as TextEdit).endLine = (end.line as number) + 1;
        }
      }
    }

    // Check newText exists
    if (e.newText === undefined) {
      return { valid: false, error: `Edit ${index}: missing newText (got: ${JSON.stringify(edit)})` };
    }

    return { valid: true };
  }

  /**
   * Validate syntax after file edit.
   * Checks for common issues like unbalanced brackets, quotes, comments.
   */
  private validateSyntax(content: string, filepath: string): string[] {
    const warnings: string[] = [];
    const ext = path.extname(filepath).toLowerCase();

    // Only validate code files
    const codeExtensions = ['.ts', '.tsx', '.js', '.jsx', '.json', '.py', '.java', '.c', '.cpp', '.h', '.go', '.rs'];
    if (!codeExtensions.includes(ext)) {
      return warnings;
    }

    // Check bracket balance
    const brackets: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
    const stack: Array<{ char: string; line: number }> = [];
    const lines = content.split('\n');

    let inString = false;
    let stringChar = '';
    let inBlockComment = false;
    let inLineComment = false;

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const line = lines[lineNum];
      inLineComment = false;

      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        const nextChar = line[i + 1];
        const prevChar = line[i - 1];

        // Handle block comments
        if (!inString && char === '/' && nextChar === '*') {
          inBlockComment = true;
          i++;
          continue;
        }
        if (inBlockComment && char === '*' && nextChar === '/') {
          inBlockComment = false;
          i++;
          continue;
        }
        if (inBlockComment) continue;

        // Handle line comments
        if (!inString && char === '/' && nextChar === '/') {
          inLineComment = true;
          break;
        }
        if (!inString && char === '#' && (ext === '.py' || ext === '.sh')) {
          inLineComment = true;
          break;
        }
        if (inLineComment) continue;

        // Handle strings
        if ((char === '"' || char === "'" || char === '`') && prevChar !== '\\') {
          if (!inString) {
            inString = true;
            stringChar = char;
          } else if (char === stringChar) {
            inString = false;
            stringChar = '';
          }
          continue;
        }
        if (inString) continue;

        // Track brackets
        if (brackets[char]) {
          stack.push({ char, line: lineNum + 1 });
        } else if (Object.values(brackets).includes(char)) {
          const expected = Object.entries(brackets).find(([, v]) => v === char)?.[0];
          if (stack.length === 0) {
            warnings.push(`- Line ${lineNum + 1}: Unexpected closing '${char}' without matching opening bracket`);
          } else if (stack[stack.length - 1].char !== expected) {
            const last = stack.pop()!;
            warnings.push(`- Line ${lineNum + 1}: Mismatched brackets - expected '${brackets[last.char]}' (opened at line ${last.line}), got '${char}'`);
          } else {
            stack.pop();
          }
        }
      }
    }

    // Report unclosed brackets
    for (const unclosed of stack) {
      warnings.push(`- Line ${unclosed.line}: Unclosed '${unclosed.char}' - missing '${brackets[unclosed.char]}'`);
    }

    // Check for unclosed strings (simple heuristic)
    if (inString) {
      warnings.push(`- Unclosed string (started with '${stringChar}')`);
    }

    // Check for unclosed block comment
    if (inBlockComment) {
      warnings.push(`- Unclosed block comment (/* without */)`);
    }

    return warnings;
  }

  /**
   * Apply text edits to file (atomic operation).
   *
   * Edit semantics:
   * - startLine: First line to be affected (1-indexed, inclusive)
   * - endLine: Last line to be replaced (1-indexed, inclusive)
   * - For REPLACE: startLine <= endLine (replaces lines startLine through endLine)
   * - For INSERT: endLine < startLine OR endLine = startLine - 1 (inserts before startLine, deletes nothing)
   * - If endLine is omitted: defaults to startLine (replaces single line)
   */
  private async execApplyEdits(args: Record<string, unknown>): Promise<string> {
    // Debug logging
    console.log('[applyTextEdits] ========== START ==========');
    console.log('[applyTextEdits] Raw args:', JSON.stringify(args, null, 2));

    const inputPath = String(args.filepath ?? '');

    // Validate filepath first
    const pathValidation = this.validateFilePath(inputPath);
    if (!pathValidation.valid) {
      return `[Error] Invalid filepath: ${pathValidation.error}\n\nTip: Use find_files tool first to get the exact file path, then use that path here.`;
    }

    // Try auto-correction if file doesn't exist
    const autoCorrect = this.tryAutoCorrectPath(inputPath);
    const filepath = autoCorrect ? this.resolvePath(autoCorrect.corrected) : this.resolvePath(inputPath);
    const correctionNote = autoCorrect
      ? `[Auto-corrected] ${autoCorrect.originalPath} -> ${autoCorrect.corrected}\n`
      : '';

    const expectedSha = String(args.expectedSha256 ?? '');
    let edits = args.edits as TextEdit[] | string | undefined;

    console.log('[applyTextEdits] filepath:', inputPath);
    console.log('[applyTextEdits] expectedSha:', expectedSha);
    console.log('[applyTextEdits] edits type:', typeof edits);
    console.log('[applyTextEdits] edits value:', JSON.stringify(edits, null, 2));

    // Check if edits is missing entirely
    if (edits === undefined || edits === null) {
      return '[Error] edits parameter is missing. Required format: edits: [{ startLine: 1, endLine: 2, newText: "..." }]';
    }

    // Parse edits if string
    if (typeof edits === 'string') {
      const editsStr = edits;
      if (editsStr.trim() === '') {
        return '[Error] edits is an empty string. Required format: edits: [{ startLine: 1, endLine: 2, newText: "..." }]';
      }
      try {
        edits = JSON.parse(editsStr);
      } catch (e) {
        return `[Error] Invalid edits JSON: ${e instanceof Error ? e.message : String(e)}\nReceived: ${editsStr.slice(0, 200)}`;
      }
    }

    if (!Array.isArray(edits)) {
      return `[Error] edits must be an array, got ${typeof edits}: ${JSON.stringify(edits).slice(0, 200)}`;
    }

    if (edits.length === 0) {
      return '[Error] edits array is empty. Provide at least one edit: { startLine: 1, endLine: 2, newText: "..." }';
    }

    // Validate each edit
    for (let i = 0; i < edits.length; i++) {
      const editValidation = this.validateEdit(edits[i], i);
      if (!editValidation.valid) {
        return `[Error] ${editValidation.error}`;
      }
    }

    console.log('[applyTextEdits] Validated edits:', JSON.stringify(edits, null, 2));

    try {
      const content = await fs.promises.readFile(filepath, 'utf-8');
      const currentSha = crypto.createHash('sha256').update(content).digest('hex');

      if (expectedSha && currentSha !== expectedSha) {
        return `[Error] SHA256 mismatch! Expected: ${expectedSha.slice(0, 16)}..., Got: ${currentSha.slice(0, 16)}...\nFile was modified. Please re-read and retry.`;
      }

      const lines = content.split('\n');

      // Sort edits by startLine descending to apply from bottom to top
      const sortedEdits = [...edits].sort((a, b) => (b.startLine ?? 0) - (a.startLine ?? 0));

      // Track edit ranges for context display
      const editRanges: Array<{ start: number; end: number; newLineCount: number }> = [];

      for (const edit of sortedEdits) {
        const startLine1 = edit.startLine ?? 1;  // 1-indexed
        const endLine1 = edit.endLine;  // 1-indexed, may be undefined
        const start = startLine1 - 1; // Convert to 0-indexed
        const newText = edit.newText ?? '';
        const explicitMode = (edit as TextEdit).mode;

        // Determine operation mode
        // - Explicit 'insert': always insert, delete nothing
        // - Explicit 'replace': always replace
        // - No mode + endLine exists: REPLACE (including single-line: startLine === endLine)
        // - No mode + no endLine: INSERT
        let isInsertMode: boolean;
        if (explicitMode === 'insert') {
          isInsertMode = true;
        } else if (explicitMode === 'replace') {
          isInsertMode = false;
        } else if (endLine1 !== undefined) {
          // endLine exists → REPLACE mode (single-line replace allowed: startLine === endLine)
          isInsertMode = false;
        } else {
          // No endLine → INSERT mode
          isInsertMode = true;
        }

        // Calculate delete count
        let deleteCount: number;
        if (isInsertMode) {
          deleteCount = 0;
        } else {
          // REPLACE: delete from startLine to endLine inclusive
          deleteCount = (endLine1 ?? startLine1) - startLine1 + 1;
        }

        console.log(`[applyTextEdits] Processing edit:`);
        console.log(`  - startLine (1-indexed): ${startLine1}`);
        console.log(`  - endLine (1-indexed): ${endLine1 ?? '(not provided)'}`);
        console.log(`  - mode: ${explicitMode ?? '(auto)'} -> ${isInsertMode ? 'INSERT' : 'REPLACE'}`);
        console.log(`  - start (0-indexed): ${start}`);
        console.log(`  - deleteCount: ${deleteCount}`);
        console.log(`  - newText lines: ${newText ? newText.split('\n').length : 0}`);
        console.log(`  - file total lines: ${lines.length}`);

        // Validate range
        if (start < 0 || start > lines.length) {
          return `[Error] Invalid startLine: ${startLine1}, file has ${lines.length} lines`;
        }
        if (deleteCount > 0 && start + deleteCount > lines.length) {
          return `[Error] Invalid range: lines ${startLine1}-${endLine1}, file only has ${lines.length} lines`;
        }

        // Show what will be deleted (for debugging)
        if (deleteCount > 0) {
          console.log(`  - Lines to delete (${startLine1}-${endLine1}):`);
          for (let i = 0; i < deleteCount && start + i < lines.length; i++) {
            const lineContent = lines[start + i];
            console.log(`    ${startLine1 + i}: ${lineContent.slice(0, 80)}${lineContent.length > 80 ? '...' : ''}`);
          }
        } else {
          console.log(`  - INSERT mode: no lines will be deleted`);
        }

        // Replace/Insert lines
        const newLines = newText ? newText.trimEnd().split('\n') : [];
        editRanges.push({ start, end: start + deleteCount, newLineCount: newLines.length });
        lines.splice(start, deleteCount, ...newLines);

        console.log(`  - After splice: file now has ${lines.length} lines`);
      }

      // Write back
      const newContent = lines.join('\n');
      await fs.promises.writeFile(filepath, newContent, 'utf-8');

      const newSha = crypto.createHash('sha256').update(newContent).digest('hex');

      // Validate syntax after edit
      const syntaxWarnings = this.validateSyntax(newContent, filepath);

      // Show context around edited lines (first edit only for brevity)
      let contextPreview = '';
      if (editRanges.length > 0) {
        // Get the first edit's location (after all edits applied)
        const firstEdit = editRanges[editRanges.length - 1]; // Last in sorted = first in original
        const contextStart = Math.max(0, firstEdit.start - 3);
        const contextEnd = Math.min(lines.length, firstEdit.start + firstEdit.newLineCount + 3);
        const contextLines = lines.slice(contextStart, contextEnd);

        contextPreview = '\n\n[Modified section preview]:\n';
        contextLines.forEach((line, i) => {
          const lineNum = contextStart + i + 1;
          const marker = (lineNum > firstEdit.start && lineNum <= firstEdit.start + firstEdit.newLineCount) ? '>' : ' ';
          contextPreview += `${marker} ${lineNum}: ${line.slice(0, 120)}${line.length > 120 ? '...' : ''}\n`;
        });
      }

      // Build result message
      let result = `${correctionNote}Successfully applied ${edits.length} edit(s) to ${filepath}\nNew SHA256: ${newSha}`;

      if (syntaxWarnings.length > 0) {
        result += '\n\n[!!! SYNTAX WARNINGS - Please verify and fix if needed !!!]\n';
        result += syntaxWarnings.join('\n');
      }

      result += contextPreview;
      result += '\n\n[Tip] Use file.read to verify the full file if needed.';

      return result;
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
        name: 'find_files',
        description: 'Find files by name pattern (glob-style). Use instead of run_terminal_command with find.',
        parameters: {
          pattern: {
            type: 'string',
            description: 'File name pattern (e.g., "*.tsx", "App.tsx", "*test*")',
            required: true,
          },
          dirpath: {
            type: 'string',
            description: 'Directory to search in (default: workspace root)',
            required: false,
          },
          maxResults: {
            type: 'number',
            description: 'Maximum number of results (default: 20, max: 50)',
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
        description: 'Apply specific text edits to a file (atomic operation). For INSERT: set startLine only or endLine <= startLine. For REPLACE: set endLine > startLine.',
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
            description: 'Array of edits: { startLine (1-indexed), endLine? (1-indexed), newText, mode? ("insert"|"replace") }. INSERT (no deletion): omit endLine or set endLine <= startLine. REPLACE (delete then insert): set endLine > startLine.',
            required: true,
          },
        },
        requiresConfirmation: true,
        riskLevel: 'medium',
      },
    ];
  }
}
