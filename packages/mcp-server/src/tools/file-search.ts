/**
 * file.search - Regex search with context for finding edit locations
 * Helps model identify exact line numbers before applying edits
 */

import * as fs from 'node:fs/promises';
import { computeSha256 } from '../core/sha256.js';
import type { MCPToolResult } from './file-read.js';

export interface FileSearchArgs {
  filepath: string;
  pattern: string;
  flags?: string;
  contextLines?: number;
  maxMatches?: number;
}

export interface SearchMatch {
  lineNumber: number;
  column: number;
  matchText: string;
  line: string;
  contextBefore: string[];
  contextAfter: string[];
}

export interface FileSearchResponse {
  matches: SearchMatch[];
  totalMatches: number;
  sha256: string;
  truncated: boolean;
  filePath: string;
}

/**
 * Tool definition for MCP registration
 */
export const fileSearchTool = {
  name: 'file.search',
  description:
    'Search for patterns in a file using regex. Returns line numbers and context for each match. Use this to find exact edit locations before using file.applyTextEdits.',
  inputSchema: {
    type: 'object',
    properties: {
      filepath: {
        type: 'string',
        description: 'Path to the file to search',
      },
      pattern: {
        type: 'string',
        description: 'JavaScript regex pattern to search for',
      },
      flags: {
        type: 'string',
        default: 'g',
        description: 'Regex flags (g, i, m, etc.)',
      },
      contextLines: {
        type: 'integer',
        default: 2,
        minimum: 0,
        maximum: 10,
        description: 'Number of context lines before and after each match',
      },
      maxMatches: {
        type: 'integer',
        default: 50,
        minimum: 1,
        maximum: 200,
        description: 'Maximum number of matches to return',
      },
    },
    required: ['filepath', 'pattern'],
  },
};

/**
 * Execute file.search tool
 */
export async function executeFileSearch(
  resolvePath: (filepath: string) => string,
  args: FileSearchArgs
): Promise<MCPToolResult> {
  try {
    const filepath = resolvePath(args.filepath);
    const flags = args.flags || 'g';
    const contextLines = args.contextLines ?? 2;
    const maxMatches = args.maxMatches || 50;

    // Read file
    const content = await fs.readFile(filepath, 'utf-8');
    const sha256 = computeSha256(content);
    const lines = content.split('\n');

    // Create regex
    let regex: RegExp;
    try {
      regex = new RegExp(args.pattern, flags);
    } catch (e) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'INVALID_REGEX',
              message: `Invalid regex pattern: ${e instanceof Error ? e.message : String(e)}`,
              recovery: 'Fix regex syntax',
            }),
          },
        ],
        isError: true,
      };
    }

    // Find matches
    const matches: SearchMatch[] = [];
    let totalMatches = 0;

    // Search line by line for line-based results
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      const searchFlags = flags.includes('g') ? flags : flags + 'g';
      const lineMatches = [...line.matchAll(new RegExp(args.pattern, searchFlags))];

      for (const match of lineMatches) {
        totalMatches++;

        if (matches.length < maxMatches) {
          // Get context lines
          const contextBefore: string[] = [];
          const contextAfter: string[] = [];

          for (let i = Math.max(0, lineIdx - contextLines); i < lineIdx; i++) {
            contextBefore.push(`${i + 1}| ${lines[i]}`);
          }

          for (let i = lineIdx + 1; i <= Math.min(lines.length - 1, lineIdx + contextLines); i++) {
            contextAfter.push(`${i + 1}| ${lines[i]}`);
          }

          matches.push({
            lineNumber: lineIdx + 1, // 1-indexed
            column: match.index ?? 0, // 0-indexed
            matchText: match[0],
            line: line,
            contextBefore,
            contextAfter,
          });
        }
      }
    }

    const response: FileSearchResponse = {
      matches,
      totalMatches,
      sha256,
      truncated: totalMatches > maxMatches,
      filePath: filepath,
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
            error: 'SEARCH_ERROR',
            message: error instanceof Error ? error.message : String(error),
          }),
        },
      ],
      isError: true,
    };
  }
}
