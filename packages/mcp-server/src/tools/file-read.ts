/**
 * file.read - Enhanced file reading with SHA256 and range support
 * Returns file content with checksum for precondition verification
 */

import * as fs from 'node:fs/promises';
import { computeSha256 } from '../core/sha256.js';

export interface FileReadArgs {
  filepath: string;
  startLine?: number;
  endLine?: number;
  includeLineNumbers?: boolean;
}

export interface FileReadResponse {
  sha256: string;
  totalLines: number;
  rangeStart: number;
  rangeEnd: number;
  filePath: string;
  content: string;
}

export interface MCPToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * Tool definition for MCP registration
 */
export const fileReadTool = {
  name: 'file.read',
  description:
    'Read file contents with SHA256 checksum and optional line range. Use this before file.applyTextEdits to get the expectedSha256 for atomic operations.',
  inputSchema: {
    type: 'object',
    properties: {
      filepath: {
        type: 'string',
        description: 'Path to the file (relative to workspace or absolute)',
      },
      startLine: {
        type: 'integer',
        minimum: 1,
        description: '1-indexed start line (inclusive). Omit to read from beginning.',
      },
      endLine: {
        type: 'integer',
        minimum: 1,
        description: '1-indexed end line (inclusive). Omit to read to end of file.',
      },
      includeLineNumbers: {
        type: 'boolean',
        default: true,
        description: "Include line numbers in output (format: 'NNN| content')",
      },
    },
    required: ['filepath'],
  },
};

/**
 * Execute file.read tool
 */
export async function executeFileRead(
  resolvePath: (filepath: string) => string,
  args: FileReadArgs
): Promise<MCPToolResult> {
  try {
    const filepath = resolvePath(args.filepath);
    const includeLineNumbers = args.includeLineNumbers !== false;

    // Read full file content
    const fullContent = await fs.readFile(filepath, 'utf-8');
    const sha256 = computeSha256(fullContent);
    const allLines = fullContent.split('\n');
    const totalLines = allLines.length;

    // Determine range
    const startLine = Math.max(1, args.startLine || 1);
    const endLine = Math.min(totalLines, args.endLine || totalLines);

    // Extract requested range
    const rangeLines = allLines.slice(startLine - 1, endLine);

    // Format output
    let formattedContent: string;
    if (includeLineNumbers) {
      const maxLineNumWidth = String(endLine).length;
      formattedContent = rangeLines
        .map((line, idx) => {
          const lineNum = String(startLine + idx).padStart(maxLineNumWidth, ' ');
          return `${lineNum}| ${line}`;
        })
        .join('\n');
    } else {
      formattedContent = rangeLines.join('\n');
    }

    // Build response object
    const response: FileReadResponse = {
      sha256,
      totalLines,
      rangeStart: startLine,
      rangeEnd: endLine,
      filePath: filepath,
      content: formattedContent,
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'FILE_NOT_FOUND',
              message: `File not found: ${args.filepath}`,
              recovery: 'Check file path or create file first',
            }),
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: 'READ_ERROR',
            message: error instanceof Error ? error.message : String(error),
          }),
        },
      ],
      isError: true,
    };
  }
}
