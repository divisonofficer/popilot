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
  /** Custom field for file attachment (base64 data URL) */
  _fileAttachment?: {
    id: string;
    name: string;
    url: string;  // data:mimetype;base64,... format
  };
  [key: string]: unknown;
}

// Threshold for file attachment (chars) - files larger than this get uploaded
const FILE_ATTACHMENT_THRESHOLD = 2000;

/**
 * Convert content to base64 data URL.
 */
function contentToDataUrl(content: string, filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const mimeTypes: Record<string, string> = {
    ts: 'text/typescript',
    tsx: 'text/typescript',
    js: 'text/javascript',
    jsx: 'text/javascript',
    json: 'application/json',
    md: 'text/markdown',
    py: 'text/x-python',
    rs: 'text/x-rust',
    go: 'text/x-go',
    java: 'text/x-java',
    cpp: 'text/x-c++',
    c: 'text/x-c',
    h: 'text/x-c',
    css: 'text/css',
    html: 'text/html',
    xml: 'text/xml',
    yaml: 'text/yaml',
    yml: 'text/yaml',
    sh: 'text/x-shellscript',
    txt: 'text/plain',
  };
  const mimeType = mimeTypes[ext] ?? 'text/plain';
  const base64 = Buffer.from(content, 'utf-8').toString('base64');
  return `data:${mimeType};base64,${base64}`;
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

    // Check if file is large enough to warrant attachment
    const isLargeFile = formattedContent.length >= FILE_ATTACHMENT_THRESHOLD;
    const filename = filepath.split('/').pop() ?? 'file.txt';

    if (isLargeFile) {
      // Large file: include metadata in text, full content as attachment
      const fileId = `file_${Date.now()}`;

      // Build metadata-only response (no content in text)
      const metadataResponse = {
        sha256,
        totalLines,
        rangeStart: startLine,
        rangeEnd: endLine,
        filePath: filepath,
        // Include only first few lines as preview
        preview: formattedContent.slice(0, 500) + (formattedContent.length > 500 ? '...' : ''),
        _uploadedAs: filename,
      };

      return {
        content: [
          {
            type: 'text',
            text: `[file.read SUCCESS] ${filepath}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SHA256: ${sha256}
Total lines: ${totalLines} (showing lines ${startLine}-${endLine})
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📎 FILE UPLOADED: ${filename} (${formattedContent.length} chars)

The COMPLETE file content has been uploaded as an attachment.
You have access to the FULL content - do NOT summarize or say "file is too long".

Use SHA256 above for file.applyTextEdits when modifying this file.

Preview (first 500 chars):
${metadataResponse.preview}`,
          },
        ],
        // Custom field for file attachment - will be processed by App.tsx
        _fileAttachment: {
          id: fileId,
          name: filename,
          url: contentToDataUrl(formattedContent, filename),
        },
      };
    }

    // Small file: include full content in response
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
