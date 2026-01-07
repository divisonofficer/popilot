/**
 * Edit validation and safety guards
 * Prevents catastrophic failures like empty files or full rewrites
 */

/**
 * Default policy limits
 */
export const DEFAULT_POLICY = {
  maxTotalReplacedLines: 300,
  maxChangeRatio: 0.4,
  rejectSingleEditWholeFile: true,
  requireNonEmpty: true,
  maxEdits: 50,
};

export type PolicyOptions = Partial<typeof DEFAULT_POLICY>;

/**
 * Error codes for recovery guidance
 */
export const ErrorCodes = {
  SHA256_MISMATCH: {
    code: 'SHA256_MISMATCH',
    recovery: 'File changed. Re-read to get current sha256, then retry.',
  },
  ANCHOR_MISMATCH: {
    code: 'ANCHOR_MISMATCH',
    recovery: 'Expected text not found. Use file.search to find correct lines.',
  },
  OVERLAPPING_EDITS: {
    code: 'OVERLAPPING_EDITS',
    recovery: 'Edits overlap. Merge overlapping edits or adjust line ranges.',
  },
  INVALID_RANGE: {
    code: 'INVALID_RANGE',
    recovery: 'Line range out of bounds. Check file line count.',
  },
  WHOLE_FILE_EDIT_REJECTED: {
    code: 'WHOLE_FILE_EDIT_REJECTED',
    recovery: 'Single edit replacing entire file is not allowed. Split into smaller edits.',
  },
  MAX_REPLACED_LINES_EXCEEDED: {
    code: 'MAX_REPLACED_LINES_EXCEEDED',
    recovery: 'Too many lines replaced. Split into multiple smaller edits.',
  },
  MAX_CHANGE_RATIO_EXCEEDED: {
    code: 'MAX_CHANGE_RATIO_EXCEEDED',
    recovery: 'Change too large. Make incremental changes instead.',
  },
  EMPTY_RESULT: {
    code: 'EMPTY_RESULT',
    recovery: 'Edit would result in empty file. This is not allowed.',
  },
  TOO_MANY_EDITS: {
    code: 'TOO_MANY_EDITS',
    recovery: 'Too many edits in single request. Split into multiple calls.',
  },
} as const;

export interface EditAnchor {
  expectedText: string;
  strict?: boolean;
}

export interface TextEdit {
  startLine: number;
  endLine?: number;  // Optional: omit for INSERT mode
  newText: string;
  anchor?: EditAnchor;
  /**
   * Operation mode:
   * - 'insert': Insert newText BEFORE startLine, delete nothing (endLine ignored)
   * - 'replace': Replace lines from startLine to endLine (inclusive)
   * - Default: 'insert' if endLine is omitted or endLine <= startLine, 'replace' if endLine > startLine
   */
  mode?: 'insert' | 'replace';
}

export interface ValidationError {
  code: string;
  message: string;
  recovery: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: string[];
  sortedEdits: TextEdit[];
  stats: {
    totalReplacedLines: number;
    editCount: number;
  };
}

/**
 * Validate edits before applying
 */
export function validateEdits(
  lines: string[],
  edits: TextEdit[],
  policy: PolicyOptions = {}
): ValidationResult {
  const opts = { ...DEFAULT_POLICY, ...policy };
  const errors: ValidationError[] = [];
  const warnings: string[] = [];
  const totalLines = lines.length;

  // Check max edits
  if (edits.length > opts.maxEdits) {
    errors.push({
      ...ErrorCodes.TOO_MANY_EDITS,
      message: `Too many edits (${edits.length}). Maximum is ${opts.maxEdits}.`,
    });
  }

  // Sort edits by startLine for overlap detection
  const sortedEdits = [...edits].sort((a, b) => a.startLine - b.startLine);

  // Check for overlaps (only for REPLACE mode edits with endLine)
  for (let i = 0; i < sortedEdits.length - 1; i++) {
    const current = sortedEdits[i];
    const next = sortedEdits[i + 1];
    // For INSERT mode (no endLine), it's a single point insertion at startLine
    const currentEnd = current.endLine ?? current.startLine;
    const nextStart = next.startLine;
    if (currentEnd >= nextStart) {
      errors.push({
        ...ErrorCodes.OVERLAPPING_EDITS,
        message: `Edit at lines ${current.startLine}-${currentEnd} overlaps with edit at lines ${nextStart}-${next.endLine ?? nextStart}`,
      });
    }
  }

  // Validate each edit and determine INSERT vs REPLACE mode
  let totalReplacedLines = 0;

  for (const edit of sortedEdits) {
    // Determine operation mode
    // - Explicit 'insert': always insert
    // - Explicit 'replace': always replace
    // - No mode + endLine exists: REPLACE (including single-line: startLine === endLine)
    // - No mode + no endLine: INSERT
    let isInsertMode: boolean;
    if (edit.mode === 'insert') {
      isInsertMode = true;
    } else if (edit.mode === 'replace') {
      isInsertMode = false;
    } else if (edit.endLine !== undefined) {
      // endLine exists → REPLACE mode (single-line replace allowed: startLine === endLine)
      isInsertMode = false;
    } else {
      // No endLine → INSERT mode
      isInsertMode = true;
    }

    // Store computed mode on edit for applyEdits
    (edit as TextEdit & { _isInsertMode?: boolean })._isInsertMode = isInsertMode;

    // Range validation
    if (edit.startLine < 1) {
      errors.push({
        ...ErrorCodes.INVALID_RANGE,
        message: `startLine ${edit.startLine} must be >= 1`,
      });
    }

    // For REPLACE mode, validate endLine
    if (!isInsertMode && edit.endLine !== undefined) {
      if (edit.startLine > totalLines + 1) {
        errors.push({
          ...ErrorCodes.INVALID_RANGE,
          message: `startLine ${edit.startLine} exceeds file length (${totalLines} lines)`,
        });
      }

      if (edit.endLine > totalLines && edit.startLine <= totalLines) {
        warnings.push(`endLine ${edit.endLine} adjusted to ${totalLines} (file length)`);
        edit.endLine = totalLines;
      }

      // Anchor validation for REPLACE mode
      if (edit.anchor?.expectedText && edit.startLine <= totalLines) {
        const actualLines = lines.slice(edit.startLine - 1, Math.min(edit.endLine, totalLines));
        const actualText = actualLines.join('\n');

        const match = edit.anchor.strict
          ? actualText === edit.anchor.expectedText
          : actualText.includes(edit.anchor.expectedText);

        if (!match) {
          errors.push({
            ...ErrorCodes.ANCHOR_MISMATCH,
            message: `Expected text at lines ${edit.startLine}-${edit.endLine} does not match. Expected: "${edit.anchor.expectedText.substring(0, 50)}..."`,
          });
        }
      }

      totalReplacedLines += Math.max(0, edit.endLine - edit.startLine + 1);
    } else {
      // INSERT mode: validate startLine is within bounds
      if (edit.startLine > totalLines + 1) {
        errors.push({
          ...ErrorCodes.INVALID_RANGE,
          message: `startLine ${edit.startLine} exceeds file length + 1 (${totalLines + 1} max for insert)`,
        });
      }
      // INSERT mode doesn't replace lines
      warnings.push(`Edit at line ${edit.startLine}: INSERT mode (no lines will be deleted)`);
    }
  }

  // Single edit whole file check (only for REPLACE mode)
  if (opts.rejectSingleEditWholeFile && sortedEdits.length === 1 && totalLines > 0) {
    const edit = sortedEdits[0];
    const editEndLine = edit.endLine ?? edit.startLine;
    if (edit.startLine === 1 && editEndLine >= totalLines && edit.mode !== 'insert') {
      errors.push({
        ...ErrorCodes.WHOLE_FILE_EDIT_REJECTED,
        message: 'Single edit replacing entire file is not allowed. Use edit_file instead.',
      });
    }
  }

  // Max replaced lines check
  if (totalReplacedLines > opts.maxTotalReplacedLines) {
    errors.push({
      ...ErrorCodes.MAX_REPLACED_LINES_EXCEEDED,
      message: `Total replaced lines (${totalReplacedLines}) exceeds limit (${opts.maxTotalReplacedLines})`,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    sortedEdits,
    stats: {
      totalReplacedLines,
      editCount: sortedEdits.length,
    },
  };
}

/**
 * Apply validated edits to lines
 * IMPORTANT: Edits must be pre-validated and sorted
 */
export function applyEdits(lines: string[], sortedEdits: TextEdit[]): string[] {
  const result = [...lines];

  // Apply edits in reverse order to preserve line numbers
  const reversedEdits = [...sortedEdits].reverse();

  for (const edit of reversedEdits) {
    // Check if INSERT mode was computed during validation
    const isInsertMode = (edit as TextEdit & { _isInsertMode?: boolean })._isInsertMode;

    let newLines: string[] = [];
    if (edit.newText) {
      newLines = edit.newText.split('\n');
      if (edit.newText.endsWith('\n') && newLines[newLines.length - 1] === '') {
        newLines.pop();
      }
    }

    const startIdx = edit.startLine - 1;

    // Calculate delete count based on mode
    let deleteCount: number;
    if (isInsertMode) {
      // INSERT mode: don't delete any lines
      deleteCount = 0;
    } else {
      // REPLACE mode: delete from startLine to endLine
      const endLine = edit.endLine ?? edit.startLine;
      deleteCount = Math.min(endLine - edit.startLine + 1, result.length - startIdx);
    }

    result.splice(startIdx, Math.max(0, deleteCount), ...newLines);
  }

  return result;
}

export interface ResultGuardsResult {
  valid: boolean;
  errors: ValidationError[];
  stats: {
    originalLength: number;
    newLength: number;
    changeRatio: number;
  };
}

/**
 * Check result guards after dry-run
 */
export function checkResultGuards(
  newContent: string,
  originalContent: string,
  policy: PolicyOptions = {}
): ResultGuardsResult {
  const opts = { ...DEFAULT_POLICY, ...policy };
  const errors: ValidationError[] = [];

  if (opts.requireNonEmpty && newContent.trim() === '') {
    errors.push({
      ...ErrorCodes.EMPTY_RESULT,
      message: 'Edit would result in empty file, which is not allowed',
    });
  }

  const originalLen = originalContent.length;
  const newLen = newContent.length;
  const changeAmount = Math.abs(originalLen - newLen);
  const changeRatio = changeAmount / Math.max(originalLen, 1);

  if (changeRatio > opts.maxChangeRatio && originalLen > 100) {
    errors.push({
      ...ErrorCodes.MAX_CHANGE_RATIO_EXCEEDED,
      message: `Change ratio (${(changeRatio * 100).toFixed(1)}%) exceeds limit (${opts.maxChangeRatio * 100}%)`,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    stats: {
      originalLength: originalLen,
      newLength: newLen,
      changeRatio: changeRatio,
    },
  };
}

export interface DiffPreview {
  unifiedDiff: string;
  linesAdded: number;
  linesRemoved: number;
}

/**
 * Generate unified diff preview
 */
export function generateDiffPreview(
  filepath: string,
  originalLines: string[],
  newLines: string[]
): DiffPreview {
  const diff: string[] = [];
  diff.push(`--- a/${filepath}`);
  diff.push(`+++ b/${filepath}`);

  let linesAdded = 0;
  let linesRemoved = 0;

  const maxLen = Math.max(originalLines.length, newLines.length);

  let i = 0;
  while (i < maxLen) {
    if (originalLines[i] !== newLines[i]) {
      const regionStart = i;
      const origRegion: string[] = [];
      const newRegion: string[] = [];

      while (i < maxLen && originalLines[i] !== newLines[i]) {
        if (originalLines[i] !== undefined) origRegion.push(originalLines[i]);
        if (newLines[i] !== undefined) newRegion.push(newLines[i]);
        i++;
      }

      const origStart = regionStart + 1;
      const origCount = origRegion.length;
      const newStart = regionStart + 1;
      const newCount = newRegion.length;

      diff.push(`@@ -${origStart},${origCount} +${newStart},${newCount} @@`);

      for (let j = Math.max(0, regionStart - 3); j < regionStart; j++) {
        if (originalLines[j] !== undefined) {
          diff.push(` ${originalLines[j]}`);
        }
      }

      for (const line of origRegion) {
        diff.push(`-${line}`);
        linesRemoved++;
      }

      for (const line of newRegion) {
        diff.push(`+${line}`);
        linesAdded++;
      }

      for (let j = i; j < Math.min(maxLen, i + 3); j++) {
        if (newLines[j] !== undefined) {
          diff.push(` ${newLines[j]}`);
        }
      }
    } else {
      i++;
    }
  }

  return {
    unifiedDiff: diff.join('\n'),
    linesAdded,
    linesRemoved,
  };
}
