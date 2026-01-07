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

/** ---------- NEW: EOL + final newline preservation ---------- */
function detectEol(text: string): '\r\n' | '\n' {
  // If any CRLF exists, prefer CRLF
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function splitPreserve(text: string) {
  const eol = detectEol(text);
  const hasFinalNewline = text.endsWith(eol);
  const body = hasFinalNewline ? text.slice(0, -eol.length) : text;

  // Keep empty file stable
  const lines = body.length === 0 ? [] : body.split(eol);
  return { lines, eol, hasFinalNewline };
}

function joinPreserve(lines: string[], eol: string, hasFinalNewline: boolean) {
  const body = lines.join(eol);
  return hasFinalNewline ? body + eol : body;
}

/** ---------- NEW: normalize edits so tool semantics are unambiguous ---------- */
function normalizeEdits(edits: TextEdit[]): TextEdit[] {
  return edits.map((e) => {
    const mode =
      e.mode ?? (e.endLine !== undefined ? 'replace' : 'insert');

    // IMPORTANT: allow single-line replace: endLine === startLine
    // and define replace by presence of endLine, not endLine > startLine
    if (mode === 'replace' && e.endLine === undefined) {
      // Let validator throw a clean error; keep it explicit here for safety
      return { ...e, mode };
    }

    return { ...e, mode };
  });
}

/**
 * Tool definition for MCP registration
 */
export const fileApplyEditsTool = {
  name: 'file.applyTextEdits',
  description: `Insert or replace lines in a file. For LARGE changes, use edit_file instead!

MODES:
- INSERT: omit endLine → inserts newText BEFORE startLine (no deletion)
- REPLACE: provide endLine (inclusive) → replaces lines startLine..endLine with newText
  - single-line replace is allowed: startLine === endLine

WORKFLOW: file.read (get sha256) → file.applyTextEdits (dryRun recommended first)`,
  inputSchema: {
    type: 'object',
    properties: {
      filepath: {
        type: 'string',
        description: 'Path to the file to edit',
      },
      expectedSha256: {
        type: 'string',
        description: 'Expected SHA256 from file.read. Fails if mismatch.',
      },
      edits: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        description:
          'Edits to apply. INSERT: omit endLine. REPLACE: include endLine (inclusive).',
        items: {
          type: 'object',
          properties: {
            startLine: {
              type: 'integer',
              minimum: 1,
              description: 'INSERT: line to insert BEFORE. REPLACE: first line to replace.',
            },
            endLine: {
              type: 'integer',
              minimum: 1,
              description:
                'OPTIONAL. Omit for INSERT. For REPLACE: last line (inclusive), must be >= startLine.',
            },
            newText: {
              type: 'string',
              description: 'Text to insert or replace with.',
            },
            mode: {
              type: 'string',
              enum: ['insert', 'replace'],
              description:
                'Optional explicit mode. Default: replace if endLine exists, otherwise insert.',
            },
            anchor: {
              type: 'object',
              description:
                'Optional validation. REPLACE strongly recommended to include expectedText.',
              properties: {
                expectedText: { type: 'string' },
                strict: { type: 'boolean', default: false },
              },
            },
          },
          required: ['startLine', 'newText'],
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
        text: JSON.stringify({ error: code, message, recovery }, null, 2),
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
    const { expectedSha256, dryRun = false, createBackup = false } = args;
    const edits = normalizeEdits(args.edits);

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

    // Step 2: Verify SHA256 precondition (over raw content, before normalization)
    const sha256Check = verifySha256(originalContent, expectedSha256);
    if (!sha256Check.valid) {
      return createErrorResponse(
        'SHA256_MISMATCH',
        `File has changed. Expected: ${expectedSha256.substring(0, 16)}..., Actual: ${sha256Check.actual.substring(0, 16)}...`,
        'Re-read file to get current sha256, then retry with updated expectedSha256'
      );
    }

    // Step 3: Parse lines with EOL preservation
    const { lines: originalLines, eol, hasFinalNewline } = splitPreserve(originalContent);

    // Step 4: Validate edits
    const validation = validateEdits(originalLines, edits);
    if (!validation.valid) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { success: false, errors: validation.errors, warnings: validation.warnings },
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
    const newContent = joinPreserve(newLines, eol, hasFinalNewline);

    // Step 6: Check result guards
    const resultGuards = checkResultGuards(newContent, originalContent);
    if (!resultGuards.valid) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { success: false, errors: resultGuards.errors, stats: resultGuards.stats },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }

    // Step 7: Generate preview (diff는 LF 기준이어도 대개 OK)
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
                stats: { ...validation.stats, ...resultGuards.stats },
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
