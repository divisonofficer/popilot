/**
 * file.applyTextEdits - Core multi-hunk targeted edit tool
 * Applies multiple range-based edits atomically with safety guards
 */

import * as fs from 'node:fs/promises';
import { computeSha256, verifySha256 } from '../core/sha256.js';
import { atomicWrite } from '../core/atomic-writer.js';
import {
  validateEdits,
  applyEdits,
  checkResultGuards,
  generateDiffPreview,
  type TextEdit,
} from '../core/edit-validator.js';
import type { MCPToolResult } from './file-read.js';

export interface FileApplyEditsArgs {
  filepath: string;
  expectedSha256: string;
  edits: TextEdit[];
  dryRun?: boolean;
  createBackup?: boolean;
}

/**
 * Tool definition for MCP registration
 */
export const fileApplyEditsTool = {
  name: 'file.applyTextEdits',
  description: `Apply multiple targeted text edits to a file atomically. All edits must be non-overlapping and valid.

IMPORTANT WORKFLOW:
1. First use file.read or file.search to get the current sha256
2. Include expectedSha256 to prevent race conditions
3. Keep edits small and targeted (max 80 lines per edit)
4. Do NOT attempt to replace the entire file with a single edit

If any validation fails, the entire operation is rolled back with no changes.`,
  inputSchema: {
    type: 'object',
    properties: {
      filepath: {
        type: 'string',
        description: 'Path to the file to edit',
      },
      expectedSha256: {
        type: 'string',
        description:
          'Expected SHA256 of the file before editing. Get this from file.read or file.search. Operation fails if mismatch (prevents race conditions).',
      },
      edits: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        description: 'List of edits to apply. Applied after sorting by startLine.',
        items: {
          type: 'object',
          properties: {
            startLine: {
              type: 'integer',
              minimum: 1,
              description: '1-indexed start line (inclusive)',
            },
            endLine: {
              type: 'integer',
              minimum: 1,
              description: '1-indexed end line (inclusive). Same as startLine for single-line edit.',
            },
            newText: {
              type: 'string',
              description:
                'Replacement text. Can be empty for deletion. Include trailing newline if replacing whole lines.',
            },
            anchor: {
              type: 'object',
              description: 'Optional: expected text at edit location for extra validation',
              properties: {
                expectedText: {
                  type: 'string',
                  description: 'Expected text (substring match by default)',
                },
                strict: {
                  type: 'boolean',
                  default: false,
                  description: 'If true, requires exact match instead of substring',
                },
              },
            },
          },
          required: ['startLine', 'endLine', 'newText'],
        },
      },
      dryRun: {
        type: 'boolean',
        default: false,
        description: 'If true, validate and return preview without applying changes',
      },
      createBackup: {
        type: 'boolean',
        default: false,
        description: 'If true, create a .bak backup before applying changes',
      },
    },
    required: ['filepath', 'expectedSha256', 'edits'],
  },
};

/**
 * Create standardized error response
 */
function createErrorResponse(code: string, message: string, recovery: string): MCPToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            error: code,
            message,
            recovery,
          },
          null,
          2
        ),
      },
    ],
    isError: true,
  };
}

/**
 * Execute file.applyTextEdits tool
 */
export async function executeFileApplyEdits(
  resolvePath: (filepath: string) => string,
  args: FileApplyEditsArgs
): Promise<MCPToolResult> {
  try {
    const filepath = resolvePath(args.filepath);
    const { expectedSha256, edits, dryRun = false, createBackup = false } = args;

    // Step 1: Read current file
    let originalContent: string;
    try {
      originalContent = await fs.readFile(filepath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return createErrorResponse(
          'FILE_NOT_FOUND',
          `File not found: ${args.filepath}`,
          'Check file path or create file first'
        );
      }
      throw error;
    }

    // Step 2: Verify SHA256 precondition
    const sha256Check = verifySha256(originalContent, expectedSha256);
    if (!sha256Check.valid) {
      return createErrorResponse(
        'SHA256_MISMATCH',
        `File has changed. Expected: ${expectedSha256.substring(0, 16)}..., Actual: ${sha256Check.actual.substring(0, 16)}...`,
        'Re-read file to get current sha256, then retry with updated expectedSha256'
      );
    }

    // Step 3: Parse lines
    const originalLines = originalContent.split('\n');

    // Step 4: Validate edits
    const validation = validateEdits(originalLines, edits);
    if (!validation.valid) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                errors: validation.errors,
                warnings: validation.warnings,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }

    // Step 5: Apply edits (in memory)
    const newLines = applyEdits(originalLines, validation.sortedEdits);
    const newContent = newLines.join('\n');

    // Step 6: Check result guards
    const resultGuards = checkResultGuards(newContent, originalContent);
    if (!resultGuards.valid) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                errors: resultGuards.errors,
                stats: resultGuards.stats,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }

    // Step 7: Generate preview
    const preview = generateDiffPreview(args.filepath, originalLines, newLines);
    const newSha256 = computeSha256(newContent);

    // Step 8: If dry run, return preview without applying
    if (dryRun) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                dryRun: true,
                newSha256,
                appliedEdits: validation.sortedEdits.length,
                preview: {
                  unifiedDiff: preview.unifiedDiff,
                  linesAdded: preview.linesAdded,
                  linesRemoved: preview.linesRemoved,
                },
                warnings: validation.warnings,
                stats: {
                  ...validation.stats,
                  ...resultGuards.stats,
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }

    // Step 9: Apply changes atomically
    try {
      await atomicWrite(filepath, newContent, { createBackup });
    } catch (error) {
      return createErrorResponse(
        'ATOMIC_WRITE_FAILED',
        `Failed to write file: ${error instanceof Error ? error.message : String(error)}`,
        'Check disk space and permissions, then retry'
      );
    }

    // Step 10: Return success response
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              newSha256,
              appliedEdits: validation.sortedEdits.length,
              preview: {
                unifiedDiff: preview.unifiedDiff,
                linesAdded: preview.linesAdded,
                linesRemoved: preview.linesRemoved,
              },
              warnings: validation.warnings,
              filePath: filepath,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: 'UNEXPECTED_ERROR',
            message: error instanceof Error ? error.message : String(error),
          }),
        },
      ],
      isError: true,
    };
  }
}
