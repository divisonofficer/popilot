/**
 * Checkpoint Service
 *
 * Manages conversation checkpoints with Git snapshots for rollback capability.
 * Allows restoring both conversation state and file system state.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { Message } from '../types.js';

const execAsync = promisify(exec);

export interface ToolCall {
  name: string;
  args: unknown;
}

export interface Checkpoint {
  id: string;
  timestamp: string;
  description: string;
  conversation: Message[];
  lastToolCall?: ToolCall;
  gitCommitHash?: string;
  gitPatchPath?: string;
  fileChanges?: string[];
}

export interface CheckpointListItem {
  id: string;
  timestamp: string;
  description: string;
  toolCall?: string;
  hasGitPatch: boolean;
}

export interface CheckpointServiceConfig {
  projectPath: string;
  maxCheckpoints?: number;
}

/**
 * CheckpointService manages conversation and file system state snapshots.
 */
export class CheckpointService {
  private checkpointDir: string;
  private patchDir: string;
  private projectPath: string;
  private maxCheckpoints: number;

  constructor(config: CheckpointServiceConfig) {
    this.projectPath = config.projectPath;
    this.maxCheckpoints = config.maxCheckpoints ?? 50;

    // Create unique checkpoint directory based on project path hash
    const projectHash = crypto
      .createHash('md5')
      .update(config.projectPath)
      .digest('hex')
      .slice(0, 8);

    const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
    this.checkpointDir = path.join(homeDir, '.popilot', 'checkpoints', projectHash);
    this.patchDir = path.join(this.checkpointDir, 'patches');

    // Ensure directories exist
    this.ensureDirectories();
  }

  private ensureDirectories(): void {
    fs.mkdirSync(this.checkpointDir, { recursive: true });
    fs.mkdirSync(this.patchDir, { recursive: true });
  }

  /**
   * Generate a unique checkpoint ID
   */
  private generateId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).slice(2, 6);
    return `${timestamp}-${random}`;
  }

  /**
   * Check if the project is a git repository
   */
  async isGitRepo(): Promise<boolean> {
    try {
      await execAsync('git rev-parse --git-dir', { cwd: this.projectPath });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get current git commit hash
   */
  async getCurrentCommitHash(): Promise<string | undefined> {
    try {
      const { stdout } = await execAsync('git rev-parse HEAD', { cwd: this.projectPath });
      return stdout.trim();
    } catch {
      return undefined;
    }
  }

  /**
   * Create a git diff patch of uncommitted changes
   */
  async createGitPatch(checkpointId: string): Promise<string | undefined> {
    if (!(await this.isGitRepo())) {
      return undefined;
    }

    try {
      // Check if there are any changes
      const { stdout: statusOutput } = await execAsync(
        'git status --porcelain',
        { cwd: this.projectPath }
      );

      if (!statusOutput.trim()) {
        // No changes to save
        return undefined;
      }

      // Create a patch file including staged and unstaged changes
      const patchPath = path.join(this.patchDir, `${checkpointId}.patch`);

      // First, get diff of tracked files
      const { stdout: diffOutput } = await execAsync(
        'git diff HEAD',
        { cwd: this.projectPath, maxBuffer: 10 * 1024 * 1024 } // 10MB buffer
      );

      // Get list of untracked files
      const { stdout: untrackedOutput } = await execAsync(
        'git ls-files --others --exclude-standard',
        { cwd: this.projectPath }
      );

      const patchContent = {
        diff: diffOutput,
        untracked: untrackedOutput.trim().split('\n').filter(Boolean),
        timestamp: new Date().toISOString(),
      };

      fs.writeFileSync(patchPath, JSON.stringify(patchContent, null, 2), 'utf-8');

      return patchPath;
    } catch (error) {
      console.error('Failed to create git patch:', error);
      return undefined;
    }
  }

  /**
   * Create a checkpoint before a potentially destructive operation
   */
  async createCheckpoint(
    conversation: Message[],
    toolCall?: ToolCall,
    description?: string
  ): Promise<string> {
    const id = this.generateId();

    // Create git patch for current changes
    const gitPatchPath = await this.createGitPatch(id);
    const gitCommitHash = await this.getCurrentCommitHash();

    // Determine description
    const autoDescription = toolCall
      ? `Before ${toolCall.name}`
      : 'Manual checkpoint';

    const checkpoint: Checkpoint = {
      id,
      timestamp: new Date().toISOString(),
      description: description ?? autoDescription,
      conversation: conversation.slice(), // Clone the array
      lastToolCall: toolCall,
      gitCommitHash,
      gitPatchPath,
    };

    // Save checkpoint
    const checkpointPath = path.join(this.checkpointDir, `${id}.json`);
    fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2), 'utf-8');

    // Cleanup old checkpoints if over limit
    await this.cleanupOldCheckpoints();

    return id;
  }

  /**
   * List available checkpoints (most recent first)
   */
  async list(): Promise<CheckpointListItem[]> {
    const files = fs.readdirSync(this.checkpointDir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse(); // Most recent first

    const items: CheckpointListItem[] = [];

    for (const file of files.slice(0, 20)) { // Return max 20
      try {
        const content = fs.readFileSync(
          path.join(this.checkpointDir, file),
          'utf-8'
        );
        const checkpoint = JSON.parse(content) as Checkpoint;

        items.push({
          id: checkpoint.id,
          timestamp: checkpoint.timestamp,
          description: checkpoint.description,
          toolCall: checkpoint.lastToolCall?.name,
          hasGitPatch: !!checkpoint.gitPatchPath,
        });
      } catch {
        // Skip invalid checkpoints
      }
    }

    return items;
  }

  /**
   * Load a checkpoint by ID
   */
  async load(checkpointId: string): Promise<Checkpoint | null> {
    const checkpointPath = path.join(this.checkpointDir, `${checkpointId}.json`);

    try {
      const content = fs.readFileSync(checkpointPath, 'utf-8');
      return JSON.parse(content) as Checkpoint;
    } catch {
      return null;
    }
  }

  /**
   * Restore file system state from a checkpoint's git patch
   */
  async restoreGitState(checkpoint: Checkpoint): Promise<{
    success: boolean;
    message: string;
    restoredFiles?: string[];
  }> {
    if (!checkpoint.gitPatchPath) {
      return {
        success: true,
        message: 'No git patch to restore',
      };
    }

    if (!fs.existsSync(checkpoint.gitPatchPath)) {
      return {
        success: false,
        message: 'Git patch file not found',
      };
    }

    try {
      // Read patch content
      const patchContent = JSON.parse(
        fs.readFileSync(checkpoint.gitPatchPath, 'utf-8')
      ) as { diff: string; untracked: string[] };

      // Reset to the commit hash if available
      if (checkpoint.gitCommitHash) {
        await execAsync(
          `git checkout ${checkpoint.gitCommitHash} -- .`,
          { cwd: this.projectPath }
        );
      }

      // Apply the diff patch if it exists
      if (patchContent.diff) {
        const tempPatchPath = path.join(this.patchDir, 'temp.patch');
        fs.writeFileSync(tempPatchPath, patchContent.diff, 'utf-8');

        try {
          await execAsync(
            `git apply --whitespace=nowarn "${tempPatchPath}"`,
            { cwd: this.projectPath }
          );
        } catch {
          // Patch might fail if files changed significantly
          // Try with 3-way merge
          try {
            await execAsync(
              `git apply --3way "${tempPatchPath}"`,
              { cwd: this.projectPath }
            );
          } catch {
            // If still fails, just warn
            console.warn('Could not apply git patch cleanly');
          }
        } finally {
          fs.unlinkSync(tempPatchPath);
        }
      }

      return {
        success: true,
        message: 'Git state restored',
        restoredFiles: patchContent.untracked,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to restore git state: ${error}`,
      };
    }
  }

  /**
   * Restore a checkpoint (conversation + optionally git state)
   */
  async restore(
    checkpointId: string,
    options: { restoreGit?: boolean } = {}
  ): Promise<{
    success: boolean;
    checkpoint?: Checkpoint;
    gitRestoreResult?: { success: boolean; message: string };
    message: string;
  }> {
    const checkpoint = await this.load(checkpointId);

    if (!checkpoint) {
      return {
        success: false,
        message: `Checkpoint ${checkpointId} not found`,
      };
    }

    let gitRestoreResult: { success: boolean; message: string } | undefined;

    // Restore git state if requested
    if (options.restoreGit && checkpoint.gitPatchPath) {
      gitRestoreResult = await this.restoreGitState(checkpoint);
    }

    return {
      success: true,
      checkpoint,
      gitRestoreResult,
      message: `Checkpoint ${checkpointId} restored`,
    };
  }

  /**
   * Delete a checkpoint
   */
  async delete(checkpointId: string): Promise<boolean> {
    const checkpointPath = path.join(this.checkpointDir, `${checkpointId}.json`);

    try {
      const checkpoint = await this.load(checkpointId);

      // Delete patch file if exists
      if (checkpoint?.gitPatchPath && fs.existsSync(checkpoint.gitPatchPath)) {
        fs.unlinkSync(checkpoint.gitPatchPath);
      }

      // Delete checkpoint file
      fs.unlinkSync(checkpointPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Cleanup old checkpoints to maintain limit
   */
  private async cleanupOldCheckpoints(): Promise<void> {
    const files = fs.readdirSync(this.checkpointDir)
      .filter(f => f.endsWith('.json'))
      .sort();

    // Remove oldest if over limit
    while (files.length > this.maxCheckpoints) {
      const oldest = files.shift();
      if (oldest) {
        await this.delete(oldest.replace('.json', ''));
      }
    }
  }

  /**
   * Get checkpoint directory path (for display)
   */
  getCheckpointDir(): string {
    return this.checkpointDir;
  }
}
