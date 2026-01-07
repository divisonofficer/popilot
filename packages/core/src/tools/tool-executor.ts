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
import { getMimeType } from '../client/file-uploader.js';

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

  // 재시도 횟수 제한 - 같은 작업 반복 방지
  private recentToolCalls: Map<string, { count: number; lastArgs: string; timestamp: number }> = new Map();
  private readonly MAX_RETRIES = 3;
  private readonly CALL_TRACKING_WINDOW_MS = 60000; // 1분 내 동일 작업 추적

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
    // Git tools
    'git.status',
    'git.diff',
    'git.log',
    'git.restore',
    'git.show',
    // Verification tools
    'run_lint',
    'run_typecheck',
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
   * Generate a key for tracking similar tool calls.
   * For file operations, key includes filepath; for others, uses args summary.
   */
  private generateCallKey(toolName: string, args: Record<string, unknown>): string {
    // For file operations, track by tool + filepath
    const filepath = args.filepath ?? args.path ?? '';
    if (filepath && typeof filepath === 'string') {
      return `${toolName}:${filepath}`;
    }
    // For other tools, use first 150 chars of stringified args
    return `${toolName}:${JSON.stringify(args).slice(0, 150)}`;
  }

  /**
   * Check if this tool call is being repeated too many times.
   * Returns error message if limit exceeded, null otherwise.
   */
  private checkRetryLimit(toolName: string, args: Record<string, unknown>): string | null {
    const now = Date.now();
    const callKey = this.generateCallKey(toolName, args);

    // Clean up old entries
    for (const [key, value] of this.recentToolCalls.entries()) {
      if (now - value.timestamp > this.CALL_TRACKING_WINDOW_MS) {
        this.recentToolCalls.delete(key);
      }
    }

    // Check current call
    const recent = this.recentToolCalls.get(callKey);
    if (recent && recent.count >= this.MAX_RETRIES) {
      return `[ERROR] 같은 작업을 ${this.MAX_RETRIES}회 반복 시도했습니다.

도구: ${toolName}
대상: ${args.filepath ?? args.path ?? '(unknown)'}

이 작업이 계속 실패하는 이유를 분석하고 다른 방법을 시도하세요:
1. 파일을 다시 읽어 현재 상태 확인
2. 에러 메시지를 주의 깊게 분석
3. 다른 접근 방법 고려

[!] 새로운 접근 방법을 시도하면 카운터가 리셋됩니다.`;
    }

    // Update counter
    this.recentToolCalls.set(callKey, {
      count: (recent?.count ?? 0) + 1,
      lastArgs: JSON.stringify(args).slice(0, 500),
      timestamp: now,
    });

    return null;
  }

  /**
   * Reset retry counter for a specific tool call (call after success).
   */
  private resetRetryCounter(toolName: string, args: Record<string, unknown>): void {
    const callKey = this.generateCallKey(toolName, args);
    this.recentToolCalls.delete(callKey);
  }

  /**
   * Execute a tool and return result.
   */
  async execute(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    const callId = crypto.randomUUID();

    // 재시도 제한 체크 (file.applyTextEdits, edit_file 등 수정 도구에 적용)
    const modifyingTools = ['file.applyTextEdits', 'edit_file', 'create_new_file'];
    if (modifyingTools.includes(toolName)) {
      const retryError = this.checkRetryLimit(toolName, args);
      if (retryError) {
        return {
          callId,
          name: toolName,
          result: retryError,
          success: false,
        };
      }
    }

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
        // Git tools
        case 'git.status':
          result = await this.execGitStatus(args);
          break;
        case 'git.diff':
          result = await this.execGitDiff(args);
          break;
        case 'git.log':
          result = await this.execGitLog(args);
          break;
        case 'git.restore':
          result = await this.execGitRestore(args);
          break;
        case 'git.show':
          result = await this.execGitShow(args);
          break;
        // Verification tools
        case 'run_lint':
          result = await this.execRunLint(args);
          break;
        case 'run_typecheck':
          result = await this.execRunTypecheck(args);
          break;
        default:
          result = `[Error] Unknown tool: ${toolName}`;
      }

      const success = !result.startsWith('[Error]') && !result.startsWith('[ERROR]');

      // 성공 시 재시도 카운터 리셋
      if (success && modifyingTools.includes(toolName)) {
        this.resetRetryCounter(toolName, args);
      }

      return {
        callId,
        name: toolName,
        result,
        success,
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
        // Large file: create attachment with pending content for upload
        // Include line numbers in the content for the attachment
        const numberedContent = lines.map((line, i) => `${String(i + 1).padStart(String(lines.length).length, ' ')}| ${line}`).join('\n');

        const fileAttachment: FileAttachment = {
          id: `pending_${Date.now()}`,  // Temporary ID, will be replaced after upload
          name: filename,
          _pendingContent: numberedContent,  // Raw content to be uploaded
          _pendingMimeType: getMimeType(filename),
        };

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
        // JSON 파싱 오류 시 더 명확한 안내 제공
        const errMsg = e instanceof Error ? e.message : String(e);
        return `[ERROR] JSON 형식 오류

문제: ${errMsg}

받은 값 (처음 200자):
${editsStr.slice(0, 200)}

올바른 형식 예시:
{
  "filepath": "path/to/file.ts",
  "expectedSha256": "abc123...",
  "edits": [
    {
      "startLine": 10,      // 숫자로 입력! (따옴표 없이)
      "endLine": 15,        // 숫자로 입력! (따옴표 없이)
      "newText": "새 코드"  // 문자열로 입력
    }
  ]
}

주의:
- (라인번호) 같은 플레이스홀더 사용 금지!
- startLine, endLine은 반드시 숫자 타입
- 줄 번호는 1부터 시작 (0이 아님)`;
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

      // 중복 콘텐츠 감지 - 같은 내용 반복 추가 방지
      for (const edit of edits) {
        if (edit.newText && edit.newText.length > 50) {
          // 추가하려는 내용의 첫 200자를 정규화하여 비교
          const newTextSample = edit.newText.trim().slice(0, 200);
          if (content.includes(newTextSample)) {
            return `[WARNING] 추가하려는 내용이 이미 파일에 존재합니다!

파일: ${filepath}
감지된 중복: "${newTextSample.slice(0, 80)}..."

현재 파일을 다시 읽어서 상태를 확인하세요:
1. file.read 도구로 파일 다시 읽기
2. 이미 추가된 내용인지 확인
3. 필요한 경우에만 수정 진행

[!] 중복 추가를 방지하기 위해 편집이 취소되었습니다.`;
          }
        }
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

  // =============================================================================
  // Git Tools Implementation
  // =============================================================================

  /**
   * Run a git command and return output.
   */
  private async runGitCommand(args: string[]): Promise<string> {
    return new Promise((resolve) => {
      const child = spawn('git', args, {
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
        if (code !== 0 && stderr) {
          resolve(`[Error] ${stderr.trim()}`);
        } else {
          resolve(stdout.trim() || '(no output)');
        }
      });

      child.on('error', (error) => {
        resolve(`[Error] ${error.message}`);
      });
    });
  }

  /**
   * git.status - Show changed files (staged/unstaged/untracked)
   * Args: paths (optional array)
   */
  private async execGitStatus(args: Record<string, unknown>): Promise<string> {
    const gitArgs = ['status', '--porcelain', '-uall'];

    // Add specific paths if provided
    const paths = args.paths as string[] | undefined;
    if (paths && Array.isArray(paths) && paths.length > 0) {
      gitArgs.push('--', ...paths);
    }

    const porcelainOutput = await this.runGitCommand(gitArgs);

    if (porcelainOutput.startsWith('[Error]')) {
      return porcelainOutput;
    }

    if (!porcelainOutput || porcelainOutput === '(no output)') {
      return '[git.status] Working tree clean - no changes detected.';
    }

    // Parse porcelain output into readable format
    const lines = porcelainOutput.split('\n').filter(Boolean);
    const staged: string[] = [];
    const unstaged: string[] = [];
    const untracked: string[] = [];

    for (const line of lines) {
      const index = line[0];
      const worktree = line[1];
      const filepath = line.slice(3);

      if (index === '?') {
        untracked.push(filepath);
      } else {
        if (index !== ' ' && index !== '?') {
          staged.push(`[${index}] ${filepath}`);
        }
        if (worktree !== ' ' && worktree !== '?') {
          unstaged.push(`[${worktree}] ${filepath}`);
        }
      }
    }

    let result = '[git.status] Repository status:\n';
    result += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

    if (staged.length > 0) {
      result += `\n📦 Staged (${staged.length}):\n`;
      result += staged.map(f => `  ${f}`).join('\n') + '\n';
    }

    if (unstaged.length > 0) {
      result += `\n📝 Modified (${unstaged.length}):\n`;
      result += unstaged.map(f => `  ${f}`).join('\n') + '\n';
    }

    if (untracked.length > 0) {
      result += `\n❓ Untracked (${untracked.length}):\n`;
      result += untracked.map(f => `  ${f}`).join('\n') + '\n';
    }

    result += '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
    result += '\n[Tip] Use git.diff to see exact changes, git.restore to undo.';

    return result;
  }

  /**
   * git.diff - Show exact changes in files
   * Args: filepath (optional), staged (boolean), ref (optional), contextLines (number)
   */
  private async execGitDiff(args: Record<string, unknown>): Promise<string> {
    const gitArgs = ['diff'];

    // Staged changes
    const staged = args.staged as boolean | undefined;
    if (staged) {
      gitArgs.push('--cached');
    }

    // Reference (commit or branch)
    const ref = args.ref as string | undefined;
    if (ref) {
      gitArgs.push(ref);
    }

    // Context lines
    const contextLines = args.contextLines as number | undefined;
    if (contextLines !== undefined && contextLines >= 0) {
      gitArgs.push(`-U${contextLines}`);
    }

    // Specific file
    const filepath = args.filepath as string | undefined;
    if (filepath) {
      gitArgs.push('--', this.resolvePath(filepath));
    }

    const output = await this.runGitCommand(gitArgs);

    if (output.startsWith('[Error]')) {
      return output;
    }

    if (!output || output === '(no output)') {
      const target = staged ? 'staged' : 'unstaged';
      const fileNote = filepath ? ` for ${filepath}` : '';
      return `[git.diff] No ${target} changes${fileNote}.`;
    }

    // Add header
    const target = staged ? 'Staged' : 'Unstaged';
    const fileNote = filepath ? ` - ${filepath}` : '';
    let result = `[git.diff] ${target} changes${fileNote}:\n`;
    result += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    result += output;

    return result;
  }

  /**
   * git.log - Show recent commit history
   * Args: count (default: 10), filepath (optional), oneline (boolean)
   */
  private async execGitLog(args: Record<string, unknown>): Promise<string> {
    const gitArgs = ['log'];

    // Number of commits
    const count = (args.count as number) || 10;
    gitArgs.push(`-n`, String(count));

    // Format
    const oneline = args.oneline as boolean | undefined;
    if (oneline) {
      gitArgs.push('--oneline');
    } else {
      gitArgs.push('--format=%h %s (%an, %ar)');
    }

    // Specific file
    const filepath = args.filepath as string | undefined;
    if (filepath) {
      gitArgs.push('--', this.resolvePath(filepath));
    }

    const output = await this.runGitCommand(gitArgs);

    if (output.startsWith('[Error]')) {
      return output;
    }

    if (!output || output === '(no output)') {
      return '[git.log] No commits found.';
    }

    const fileNote = filepath ? ` for ${filepath}` : '';
    let result = `[git.log] Recent ${count} commits${fileNote}:\n`;
    result += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    result += output;

    return result;
  }

  /**
   * git.restore - Restore file to previous state (UNDO changes)
   * Args: filepath (required), staged (boolean), source (optional ref)
   */
  private async execGitRestore(args: Record<string, unknown>): Promise<string> {
    const filepath = args.filepath as string | undefined;
    if (!filepath) {
      return '[Error] filepath is required for git.restore';
    }

    const gitArgs = ['restore'];

    // Restore staged changes
    const staged = args.staged as boolean | undefined;
    if (staged) {
      gitArgs.push('--staged');
    }

    // Source ref (commit/branch to restore from)
    const source = args.source as string | undefined;
    if (source) {
      gitArgs.push('--source', source);
    }

    // Target file
    gitArgs.push('--', this.resolvePath(filepath));

    const output = await this.runGitCommand(gitArgs);

    if (output.startsWith('[Error]')) {
      return output;
    }

    const target = staged ? 'staged' : 'working tree';
    return `[git.restore] Successfully restored ${filepath} in ${target}.`;
  }

  /**
   * git.show - Show details of a specific commit
   * Args: ref (required), filepath (optional), stat (boolean)
   */
  private async execGitShow(args: Record<string, unknown>): Promise<string> {
    const ref = args.ref as string | undefined;
    if (!ref) {
      return '[Error] ref is required for git.show (e.g., "HEAD", "abc1234", "main")';
    }

    const gitArgs = ['show', ref];

    // Show only stat (file list with changes summary)
    const stat = args.stat as boolean | undefined;
    if (stat) {
      gitArgs.push('--stat');
    }

    // Specific file
    const filepath = args.filepath as string | undefined;
    if (filepath) {
      gitArgs.push('--', this.resolvePath(filepath));
    }

    const output = await this.runGitCommand(gitArgs);

    if (output.startsWith('[Error]')) {
      return output;
    }

    let result = `[git.show] Commit ${ref}:\n`;
    result += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    result += output;

    return result;
  }

  // ========================================
  // Verification Tools (Lint/Typecheck)
  // ========================================

  /**
   * Execute ESLint for code quality checking.
   * Supports TypeScript, JavaScript, React files.
   */
  private async execRunLint(args: Record<string, unknown>): Promise<string> {
    // Optional: specific files/directories to lint
    const paths = args.paths as string[] | undefined;
    const fix = args.fix as boolean | undefined;

    // Detect project type and available linting tools
    const hasEslintConfig = this.fileExists('.eslintrc.js') ||
                            this.fileExists('.eslintrc.json') ||
                            this.fileExists('.eslintrc.yml') ||
                            this.fileExists('eslint.config.js') ||
                            this.fileExists('eslint.config.mjs');

    const hasBiomeConfig = this.fileExists('biome.json') ||
                           this.fileExists('biome.jsonc');

    let command: string;
    let linter: string;

    if (hasEslintConfig) {
      linter = 'ESLint';
      const eslintArgs = ['eslint'];
      if (paths && paths.length > 0) {
        eslintArgs.push(...paths.map(p => this.resolvePath(p)));
      } else {
        eslintArgs.push('.');
      }
      eslintArgs.push('--ext', '.ts,.tsx,.js,.jsx');
      eslintArgs.push('--format', 'stylish');
      if (fix) {
        eslintArgs.push('--fix');
      }
      // Don't fail on lint errors, just report them
      eslintArgs.push('--max-warnings', '9999');
      command = `npx ${eslintArgs.join(' ')}`;
    } else if (hasBiomeConfig) {
      linter = 'Biome';
      const biomeArgs = ['biome', 'lint'];
      if (paths && paths.length > 0) {
        biomeArgs.push(...paths.map(p => this.resolvePath(p)));
      } else {
        biomeArgs.push('.');
      }
      if (fix) {
        biomeArgs.push('--apply');
      }
      command = `npx ${biomeArgs.join(' ')}`;
    } else {
      return `[Error] No linter configuration found.

Please ensure you have one of the following:
- ESLint: .eslintrc.js, .eslintrc.json, eslint.config.js
- Biome: biome.json

To set up ESLint:
  npx eslint --init

To set up Biome:
  npx @biomejs/biome init`;
    }

    try {
      const { stdout, stderr } = await this.runCommandWithOutput(command);
      const output = (stdout + '\n' + stderr).trim();

      if (!output || output.length < 10) {
        return `[run_lint] ✅ ${linter}: No issues found!

Checked: ${paths?.join(', ') || 'entire project'}`;
      }

      // Parse output to count errors/warnings
      const errorCount = (output.match(/\d+ errors?/gi) || []).length > 0
        ? output.match(/(\d+) errors?/i)?.[1] || '0'
        : '0';
      const warningCount = (output.match(/\d+ warnings?/gi) || []).length > 0
        ? output.match(/(\d+) warnings?/i)?.[1] || '0'
        : '0';

      let result = `[run_lint] ${linter} Results:\n`;
      result += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
      result += output;
      result += '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
      result += `Summary: ${errorCount} error(s), ${warningCount} warning(s)`;

      if (fix) {
        result += '\n[!] Auto-fix was applied. Review changes with git.diff';
      }

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      // Lint errors are often returned as non-zero exit, but output is still useful
      if (errorMsg.includes('Command failed')) {
        const output = (error as { stdout?: string; stderr?: string }).stdout ||
                       (error as { stdout?: string; stderr?: string }).stderr || '';
        if (output) {
          let result = `[run_lint] ${linter} found issues:\n`;
          result += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
          result += output;
          return result;
        }
      }
      return `[Error] Lint failed: ${errorMsg}`;
    }
  }

  /**
   * Execute TypeScript type checking (tsc --noEmit).
   */
  private async execRunTypecheck(args: Record<string, unknown>): Promise<string> {
    const projectRoot = args.projectRoot as string | undefined;

    // Find tsconfig.json
    const tsconfigPath = projectRoot
      ? path.join(this.resolvePath(projectRoot), 'tsconfig.json')
      : path.join(this.workspaceDir, 'tsconfig.json');

    if (!fs.existsSync(tsconfigPath)) {
      return `[Error] tsconfig.json not found at: ${tsconfigPath}

Please ensure:
1. You have a tsconfig.json in your project root
2. Or specify projectRoot parameter pointing to the directory with tsconfig.json`;
    }

    const tscArgs = ['tsc', '--noEmit'];
    if (projectRoot) {
      tscArgs.push('--project', this.resolvePath(projectRoot));
    }

    const command = `npx ${tscArgs.join(' ')}`;

    try {
      const { stdout, stderr } = await this.runCommandWithOutput(command);
      const output = (stdout + '\n' + stderr).trim();

      if (!output || output.length < 10) {
        return `[run_typecheck] ✅ TypeScript: No type errors found!

Config: ${tsconfigPath}`;
      }

      // Parse TypeScript errors
      const errorMatches = output.match(/error TS\d+:/gi) || [];
      const errorCount = errorMatches.length;

      let result = `[run_typecheck] TypeScript Results:\n`;
      result += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
      result += output;
      result += '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
      result += `Summary: ${errorCount} type error(s)`;

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      // Type errors cause non-zero exit, but output is still useful
      if (errorMsg.includes('Command failed')) {
        const output = (error as { stdout?: string; stderr?: string }).stdout ||
                       (error as { stdout?: string; stderr?: string }).stderr || '';
        if (output) {
          // Parse error count
          const errorMatches = output.match(/error TS\d+:/gi) || [];
          const errorCount = errorMatches.length;

          let result = `[run_typecheck] TypeScript found ${errorCount} type error(s):\n`;
          result += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
          result += output;
          return result;
        }
      }
      return `[Error] Type check failed: ${errorMsg}`;
    }
  }

  /**
   * Helper: Check if a file exists in workspace.
   */
  private fileExists(relativePath: string): boolean {
    return fs.existsSync(path.join(this.workspaceDir, relativePath));
  }

  /**
   * Helper: Run command and capture stdout/stderr.
   */
  private async runCommandWithOutput(command: string): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn('sh', ['-c', command], {
        cwd: this.workspaceDir,
        timeout: this.timeout,
        env: { ...process.env, FORCE_COLOR: '0' },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          // Still resolve with output for lint/typecheck tools
          // They return non-zero when issues are found
          const error = new Error(`Command failed with code ${code}`) as Error & { stdout: string; stderr: string };
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        }
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });
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
      // Verification tools
      {
        name: 'run_lint',
        description: 'Run ESLint or Biome to check code quality. Supports TypeScript, JavaScript, React files.',
        parameters: {
          paths: {
            type: 'array',
            description: 'Optional: specific files or directories to lint (default: entire project)',
            required: false,
          },
          fix: {
            type: 'boolean',
            description: 'Whether to auto-fix issues (default: false)',
            required: false,
          },
        },
        requiresConfirmation: false,
        riskLevel: 'low',
      },
      {
        name: 'run_typecheck',
        description: 'Run TypeScript type checking (tsc --noEmit) to find type errors.',
        parameters: {
          projectRoot: {
            type: 'string',
            description: 'Optional: directory containing tsconfig.json (default: workspace root)',
            required: false,
          },
        },
        requiresConfirmation: false,
        riskLevel: 'low',
      },
    ];
  }
}
