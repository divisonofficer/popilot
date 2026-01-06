/**
 * Atomic file writer using temp file + rename strategy
 * Ensures file integrity on write failure
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

export interface AtomicWriteOptions {
  createBackup?: boolean;
}

export interface AtomicWriteResult {
  success: boolean;
}

/**
 * Write content to file atomically
 * Uses temp file in same directory + rename for atomicity
 */
export async function atomicWrite(
  filepath: string,
  content: string,
  options: AtomicWriteOptions = {}
): Promise<AtomicWriteResult> {
  const { createBackup = false } = options;

  // Generate unique temp file in same directory (required for atomic rename)
  const dir = path.dirname(filepath);
  const tempName = `.${path.basename(filepath)}.${randomBytes(8).toString('hex')}.tmp`;
  const tempPath = path.join(dir, tempName);

  try {
    // Ensure directory exists
    await fs.mkdir(dir, { recursive: true });

    // Write to temp file
    await fs.writeFile(tempPath, content, 'utf-8');

    // Create backup if requested and original exists
    if (createBackup) {
      try {
        await fs.access(filepath);
        const backupPath = `${filepath}.bak`;
        await fs.copyFile(filepath, backupPath);
      } catch {
        // Original doesn't exist, skip backup
      }
    }

    // Atomic rename (POSIX guarantees atomicity for same-filesystem rename)
    await fs.rename(tempPath, filepath);

    return { success: true };
  } catch (error) {
    // Cleanup temp file on failure
    try {
      await fs.unlink(tempPath);
    } catch {
      // Temp file may not exist, ignore
    }
    throw error;
  }
}

export interface AtomicWriteOperation {
  filepath: string;
  content: string;
  originalContent?: string;
}

/**
 * Write multiple files atomically (transaction)
 * If any write fails, all changes are rolled back
 */
export async function atomicWriteMultiple(
  operations: AtomicWriteOperation[]
): Promise<AtomicWriteResult> {
  const tempFiles: Array<{
    tempPath: string;
    targetPath: string;
    originalContent?: string;
  }> = [];

  try {
    // Phase 1: Write all temp files (preparation)
    for (const op of operations) {
      const dir = path.dirname(op.filepath);
      const tempName = `.${path.basename(op.filepath)}.${randomBytes(8).toString('hex')}.tmp`;
      const tempPath = path.join(dir, tempName);

      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(tempPath, op.content, 'utf-8');

      tempFiles.push({
        tempPath,
        targetPath: op.filepath,
        originalContent: op.originalContent,
      });
    }

    // Phase 2: Atomic renames (point of no return)
    for (const { tempPath, targetPath } of tempFiles) {
      await fs.rename(tempPath, targetPath);
    }

    return { success: true };
  } catch (error) {
    // Rollback: cleanup temps and restore originals
    for (const tf of tempFiles) {
      try {
        await fs.unlink(tf.tempPath);
      } catch {
        // May already be renamed or not exist
      }

      if (tf.originalContent !== undefined) {
        try {
          const currentContent = await fs.readFile(tf.targetPath, 'utf-8');
          if (currentContent !== tf.originalContent) {
            await fs.writeFile(tf.targetPath, tf.originalContent, 'utf-8');
          }
        } catch {
          // File may not exist, ignore
        }
      }
    }
    throw error;
  }
}
