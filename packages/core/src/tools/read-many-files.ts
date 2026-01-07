/**
 * Read Many Files Tool for Popilot
 * Reads multiple files matching glob patterns in a single call.
 *
 * Inspired by gemini-cli's read_many_files implementation.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { glob } from 'glob';

export interface ReadManyFilesArgs {
  /** Glob patterns to include */
  include: string[];
  /** Glob patterns to exclude (default: node_modules, .git, etc.) */
  exclude?: string[];
  /** Maximum number of files to read (default: 10, max: 20) */
  maxFiles?: number;
  /** Maximum total characters across all files (default: 100000) */
  maxTotalChars?: number;
}

export interface FileReadResult {
  path: string;
  content: string;
  lines: number;
  chars: number;
  truncated: boolean;
  error?: string;
}

export interface ReadManyFilesResult {
  files: FileReadResult[];
  totalFiles: number;
  matchedFiles: number;
  truncatedFiles: number;
  skippedFiles: number;
  totalChars: number;
}

// Default patterns to exclude
const DEFAULT_EXCLUDES = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.turbo/**',
  '**/.next/**',
  '**/__pycache__/**',
  '**/.venv/**',
  '**/venv/**',
  '**/*.lock',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/.popilot_log/**',
  '**/coverage/**',
  '**/.cache/**',
];

// Binary file extensions to skip
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.exe', '.dll', '.so', '.dylib',
  '.woff', '.woff2', '.ttf', '.eot',
  '.mp3', '.mp4', '.wav', '.avi', '.mov',
  '.bin', '.dat',
]);

// Max chars per individual file
const MAX_CHARS_PER_FILE = 50000;

/**
 * Check if a file is likely binary based on extension.
 */
function isBinaryFile(filepath: string): boolean {
  const ext = path.extname(filepath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Read multiple files matching glob patterns.
 */
export async function readManyFiles(
  workspaceDir: string,
  args: ReadManyFilesArgs
): Promise<ReadManyFilesResult> {
  const include = args.include || [];
  const exclude = [...DEFAULT_EXCLUDES, ...(args.exclude || [])];
  const maxFiles = Math.min(args.maxFiles ?? 10, 20);
  const maxTotalChars = args.maxTotalChars ?? 100000;

  if (include.length === 0) {
    return {
      files: [],
      totalFiles: 0,
      matchedFiles: 0,
      truncatedFiles: 0,
      skippedFiles: 0,
      totalChars: 0,
    };
  }

  // Collect matching files using glob
  const allMatches: string[] = [];

  for (const pattern of include) {
    try {
      const matches = await glob(pattern, {
        cwd: workspaceDir,
        ignore: exclude,
        nodir: true,
        absolute: false,
      });
      allMatches.push(...matches);
    } catch {
      // Skip invalid patterns
    }
  }

  // Deduplicate and sort by path length (shorter paths first - usually more important)
  const uniqueMatches = [...new Set(allMatches)].sort((a, b) => a.length - b.length);
  const matchedCount = uniqueMatches.length;

  // Filter out binary files
  const textFiles = uniqueMatches.filter(f => !isBinaryFile(f));
  const skippedBinary = uniqueMatches.length - textFiles.length;

  // Limit to maxFiles
  const limitedFiles = textFiles.slice(0, maxFiles);
  const skippedByLimit = textFiles.length - limitedFiles.length;

  // Read files in parallel
  const results = await Promise.allSettled(
    limitedFiles.map(async (relativePath): Promise<FileReadResult> => {
      const fullPath = path.join(workspaceDir, relativePath);

      try {
        const stats = await fs.promises.stat(fullPath);

        // Skip very large files (> 1MB)
        if (stats.size > 1024 * 1024) {
          return {
            path: relativePath,
            content: '',
            lines: 0,
            chars: 0,
            truncated: true,
            error: 'File too large (> 1MB)',
          };
        }

        const content = await fs.promises.readFile(fullPath, 'utf-8');
        const lines = content.split('\n').length;
        let truncated = false;
        let finalContent = content;

        // Truncate if exceeds per-file limit
        if (content.length > MAX_CHARS_PER_FILE) {
          finalContent = content.slice(0, MAX_CHARS_PER_FILE) + '\n\n... [truncated]';
          truncated = true;
        }

        return {
          path: relativePath,
          content: finalContent,
          lines,
          chars: finalContent.length,
          truncated,
        };
      } catch (error) {
        return {
          path: relativePath,
          content: '',
          lines: 0,
          chars: 0,
          truncated: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })
  );

  // Process results, respecting total char limit
  const files: FileReadResult[] = [];
  let totalChars = 0;
  let truncatedByTotalLimit = 0;

  for (const result of results) {
    if (result.status === 'fulfilled') {
      const file = result.value;

      // Check total char budget
      if (totalChars + file.chars > maxTotalChars && !file.error) {
        // Try to fit partial content
        const remainingBudget = maxTotalChars - totalChars;
        if (remainingBudget > 500) {
          file.content = file.content.slice(0, remainingBudget) + '\n\n... [truncated by total limit]';
          file.chars = file.content.length;
          file.truncated = true;
          files.push(file);
          totalChars += file.chars;
          truncatedByTotalLimit++;
        }
        break; // Stop adding more files
      }

      files.push(file);
      totalChars += file.chars;
    }
  }

  const truncatedCount = files.filter(f => f.truncated).length;
  const skippedCount = skippedBinary + skippedByLimit;

  return {
    files,
    totalFiles: files.length,
    matchedFiles: matchedCount,
    truncatedFiles: truncatedCount,
    skippedFiles: skippedCount,
    totalChars,
  };
}

/**
 * Format read_many_files result as readable output string.
 */
export function formatReadManyFilesResult(result: ReadManyFilesResult): string {
  if (result.files.length === 0) {
    return `[read_many_files] No files found matching the patterns.

Tips:
- Check if the glob patterns are correct (e.g., "src/**/*.ts")
- Patterns are relative to workspace root
- Binary files and node_modules are excluded by default`;
  }

  const lines: string[] = [];

  lines.push(`[read_many_files] Read ${result.totalFiles} file(s)`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`Matched: ${result.matchedFiles} | Read: ${result.totalFiles} | Skipped: ${result.skippedFiles} | Truncated: ${result.truncatedFiles}`);
  lines.push(`Total chars: ${result.totalChars.toLocaleString()}`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push('');

  for (const file of result.files) {
    lines.push(`\n${'='.repeat(60)}`);
    lines.push(`FILE: ${file.path}`);
    lines.push(`   Lines: ${file.lines} | Chars: ${file.chars}${file.truncated ? ' [TRUNCATED]' : ''}`);
    lines.push(`${'-'.repeat(60)}`);

    if (file.error) {
      lines.push(`[Error] ${file.error}`);
    } else {
      // Add line numbers to content
      const contentLines = file.content.split('\n');
      const paddingWidth = String(contentLines.length).length;
      const numberedLines = contentLines.map((line, i) =>
        `${String(i + 1).padStart(paddingWidth, ' ')}| ${line}`
      );
      lines.push(numberedLines.join('\n'));
    }
  }

  lines.push(`\n${'='.repeat(60)}`);
  lines.push('[Tip] Use file.read for full content of specific files');

  return lines.join('\n');
}
