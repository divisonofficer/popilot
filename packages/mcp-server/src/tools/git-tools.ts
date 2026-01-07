/**
 * Git tools for MCP server
 * Allows agent to track its own changes and understand project state
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { MCPToolResult } from './file-read.js';

const execAsync = promisify(exec);

// Max output length for git commands
const MAX_OUTPUT_LENGTH = 50000;

/**
 * Execute git command safely
 */
async function execGit(
  cwd: string,
  args: string[],
  timeoutMs: number = 30000
): Promise<{ stdout: string; stderr: string }> {
  const command = `git ${args.join(' ')}`;

  try {
    const result = await execAsync(command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
    });
    return result;
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string; message?: string };
    // Git commands may exit with non-zero but still have useful output
    if (execError.stdout || execError.stderr) {
      return {
        stdout: execError.stdout ?? '',
        stderr: execError.stderr ?? '',
      };
    }
    throw error;
  }
}

/**
 * Check if directory is a git repository
 */
async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await execGit(cwd, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

// ============= git.status =============

export interface GitStatusArgs {
  /** Show only specific paths (optional) */
  paths?: string[];
}

export const gitStatusTool = {
  name: 'git.status',
  description: `Show git working tree status - modified, staged, and untracked files.

Use this to:
- See what files you've changed in this session
- Check if there are uncommitted changes
- Understand the current state of the repository

Returns: List of files with their status (modified/added/deleted/untracked)`,
  inputSchema: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional: limit status to specific paths',
      },
    },
    required: [],
  },
};

export async function executeGitStatus(
  workspaceDir: string,
  args: GitStatusArgs
): Promise<MCPToolResult> {
  try {
    if (!(await isGitRepo(workspaceDir))) {
      return {
        content: [{ type: 'text', text: '[Not a git repository]' }],
        isError: true,
      };
    }

    const gitArgs = ['status', '--porcelain=v2', '--branch'];
    if (args.paths?.length) {
      gitArgs.push('--', ...args.paths);
    }

    const { stdout, stderr } = await execGit(workspaceDir, gitArgs);

    if (stderr && !stdout) {
      return {
        content: [{ type: 'text', text: `Git error: ${stderr}` }],
        isError: true,
      };
    }

    // Parse porcelain v2 output for human-readable format
    const lines = stdout.trim().split('\n').filter(Boolean);
    const result: string[] = [];

    let branch = '';
    const staged: string[] = [];
    const unstaged: string[] = [];
    const untracked: string[] = [];

    for (const line of lines) {
      if (line.startsWith('# branch.head ')) {
        branch = line.replace('# branch.head ', '');
      } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
        // Changed entry
        const parts = line.split('\t');
        const statusPart = parts[0].split(' ');
        const xy = statusPart[1]; // XY status
        const filepath = parts[parts.length - 1];

        const x = xy[0]; // staged status
        const y = xy[1]; // unstaged status

        if (x !== '.') {
          staged.push(`  ${x} ${filepath}`);
        }
        if (y !== '.') {
          unstaged.push(`  ${y} ${filepath}`);
        }
      } else if (line.startsWith('? ')) {
        // Untracked
        const filepath = line.slice(2);
        untracked.push(`  ? ${filepath}`);
      } else if (line.startsWith('u ')) {
        // Unmerged
        const parts = line.split('\t');
        const filepath = parts[parts.length - 1];
        unstaged.push(`  U ${filepath} (unmerged)`);
      }
    }

    result.push(`On branch: ${branch || '(unknown)'}`);
    result.push('');

    if (staged.length > 0) {
      result.push('Staged changes (ready to commit):');
      result.push(...staged);
      result.push('');
    }

    if (unstaged.length > 0) {
      result.push('Unstaged changes (not yet staged):');
      result.push(...unstaged);
      result.push('');
    }

    if (untracked.length > 0) {
      result.push('Untracked files:');
      result.push(...untracked);
      result.push('');
    }

    if (staged.length === 0 && unstaged.length === 0 && untracked.length === 0) {
      result.push('Working tree clean - no changes detected.');
    }

    // Add summary
    result.push('---');
    result.push(`Summary: ${staged.length} staged, ${unstaged.length} unstaged, ${untracked.length} untracked`);

    return {
      content: [{ type: 'text', text: result.join('\n') }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Git status failed: ${error instanceof Error ? error.message : String(error)}`,
      }],
      isError: true,
    };
  }
}

// ============= git.diff =============

export interface GitDiffArgs {
  /** Specific file path to diff (optional - all changes if omitted) */
  filepath?: string;
  /** Show staged changes instead of unstaged */
  staged?: boolean;
  /** Compare with specific commit or ref */
  ref?: string;
  /** Number of context lines (default: 3) */
  contextLines?: number;
}

export const gitDiffTool = {
  name: 'git.diff',
  description: `Show changes in git working tree or staging area.

Use this to:
- Review what you've changed in a file
- See the exact lines added/removed
- Compare current state with a previous commit

[!] This is essential for tracking your own modifications!`,
  inputSchema: {
    type: 'object',
    properties: {
      filepath: {
        type: 'string',
        description: 'Optional: specific file to diff (all files if omitted)',
      },
      staged: {
        type: 'boolean',
        default: false,
        description: 'If true, show staged changes (--cached)',
      },
      ref: {
        type: 'string',
        description: 'Optional: compare with specific commit/ref (e.g., HEAD~1, main)',
      },
      contextLines: {
        type: 'number',
        default: 3,
        description: 'Lines of context around changes (default: 3)',
      },
    },
    required: [],
  },
};

export async function executeGitDiff(
  workspaceDir: string,
  args: GitDiffArgs
): Promise<MCPToolResult> {
  try {
    if (!(await isGitRepo(workspaceDir))) {
      return {
        content: [{ type: 'text', text: '[Not a git repository]' }],
        isError: true,
      };
    }

    const gitArgs = ['diff', '--stat', '--patch'];

    // Context lines
    const contextLines = args.contextLines ?? 3;
    gitArgs.push(`-U${contextLines}`);

    // Staged vs unstaged
    if (args.staged) {
      gitArgs.push('--cached');
    }

    // Compare with ref
    if (args.ref) {
      gitArgs.push(args.ref);
    }

    // Specific file
    if (args.filepath) {
      gitArgs.push('--', args.filepath);
    }

    const { stdout, stderr } = await execGit(workspaceDir, gitArgs);

    if (stderr && !stdout) {
      return {
        content: [{ type: 'text', text: `Git error: ${stderr}` }],
        isError: true,
      };
    }

    if (!stdout.trim()) {
      const scope = args.filepath ? `for ${args.filepath}` : '';
      const type = args.staged ? 'staged' : 'unstaged';
      return {
        content: [{
          type: 'text',
          text: `No ${type} changes ${scope}`.trim(),
        }],
      };
    }

    // Truncate if too long
    let output = stdout;
    if (output.length > MAX_OUTPUT_LENGTH) {
      output = output.slice(0, MAX_OUTPUT_LENGTH) +
        `\n\n[!] Output truncated (${stdout.length} chars). Use filepath to see specific file.`;
    }

    return {
      content: [{ type: 'text', text: output }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Git diff failed: ${error instanceof Error ? error.message : String(error)}`,
      }],
      isError: true,
    };
  }
}

// ============= git.log =============

export interface GitLogArgs {
  /** Number of commits to show (default: 10) */
  count?: number;
  /** Show commits for specific file */
  filepath?: string;
  /** Show only commits from this ref onwards */
  since?: string;
  /** One-line format for compact view */
  oneline?: boolean;
}

export const gitLogTool = {
  name: 'git.log',
  description: `Show recent commit history.

Use this to:
- See what commits existed before your changes
- Find a commit to compare against
- Understand recent project history`,
  inputSchema: {
    type: 'object',
    properties: {
      count: {
        type: 'number',
        default: 10,
        description: 'Number of commits to show (default: 10)',
      },
      filepath: {
        type: 'string',
        description: 'Optional: show commits for specific file',
      },
      since: {
        type: 'string',
        description: 'Optional: show commits since date/ref (e.g., "1 hour ago", "HEAD~5")',
      },
      oneline: {
        type: 'boolean',
        default: false,
        description: 'Compact one-line format',
      },
    },
    required: [],
  },
};

export async function executeGitLog(
  workspaceDir: string,
  args: GitLogArgs
): Promise<MCPToolResult> {
  try {
    if (!(await isGitRepo(workspaceDir))) {
      return {
        content: [{ type: 'text', text: '[Not a git repository]' }],
        isError: true,
      };
    }

    const count = Math.min(args.count ?? 10, 50);
    const gitArgs = ['log', `-${count}`];

    if (args.oneline) {
      gitArgs.push('--oneline');
    } else {
      gitArgs.push('--format=%h %ad | %s [%an]', '--date=short');
    }

    if (args.since) {
      gitArgs.push(`--since="${args.since}"`);
    }

    if (args.filepath) {
      gitArgs.push('--', args.filepath);
    }

    const { stdout, stderr } = await execGit(workspaceDir, gitArgs);

    if (stderr && !stdout) {
      return {
        content: [{ type: 'text', text: `Git error: ${stderr}` }],
        isError: true,
      };
    }

    if (!stdout.trim()) {
      return {
        content: [{ type: 'text', text: 'No commits found.' }],
      };
    }

    return {
      content: [{ type: 'text', text: stdout.trim() }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Git log failed: ${error instanceof Error ? error.message : String(error)}`,
      }],
      isError: true,
    };
  }
}

// ============= git.restore =============

export interface GitRestoreArgs {
  /** File path to restore */
  filepath: string;
  /** Restore from staging area (unstage) instead of working tree */
  staged?: boolean;
  /** Restore from specific commit/ref */
  source?: string;
}

export const gitRestoreTool = {
  name: 'git.restore',
  description: `Restore file to previous state (discard changes).

[!] WARNING: This discards changes! Use with caution.

Use this to:
- Undo changes to a file you modified incorrectly
- Unstage a file (with staged=true)
- Restore file from a specific commit`,
  inputSchema: {
    type: 'object',
    properties: {
      filepath: {
        type: 'string',
        description: 'File path to restore (required)',
      },
      staged: {
        type: 'boolean',
        default: false,
        description: 'If true, unstage the file (keep working tree changes)',
      },
      source: {
        type: 'string',
        description: 'Optional: restore from specific commit/ref (e.g., HEAD~1)',
      },
    },
    required: ['filepath'],
  },
};

export async function executeGitRestore(
  workspaceDir: string,
  args: GitRestoreArgs
): Promise<MCPToolResult> {
  try {
    if (!(await isGitRepo(workspaceDir))) {
      return {
        content: [{ type: 'text', text: '[Not a git repository]' }],
        isError: true,
      };
    }

    if (!args.filepath) {
      return {
        content: [{ type: 'text', text: 'filepath is required' }],
        isError: true,
      };
    }

    const gitArgs = ['restore'];

    if (args.staged) {
      gitArgs.push('--staged');
    }

    if (args.source) {
      gitArgs.push(`--source=${args.source}`);
    }

    gitArgs.push('--', args.filepath);

    const { stdout, stderr } = await execGit(workspaceDir, gitArgs);

    if (stderr && stderr.includes('error:')) {
      return {
        content: [{ type: 'text', text: `Git restore failed: ${stderr}` }],
        isError: true,
      };
    }

    const action = args.staged ? 'unstaged' : 'restored';
    const source = args.source ? ` from ${args.source}` : '';

    return {
      content: [{
        type: 'text',
        text: `Successfully ${action}: ${args.filepath}${source}`,
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Git restore failed: ${error instanceof Error ? error.message : String(error)}`,
      }],
      isError: true,
    };
  }
}

// ============= git.show =============

export interface GitShowArgs {
  /** Commit hash or ref to show */
  ref: string;
  /** Show only specific file from commit */
  filepath?: string;
  /** Show only stats without full diff */
  stat?: boolean;
}

export const gitShowTool = {
  name: 'git.show',
  description: `Show details of a specific commit.

Use this to:
- See what was changed in a specific commit
- View the content of a file at a specific commit
- Understand what a commit did`,
  inputSchema: {
    type: 'object',
    properties: {
      ref: {
        type: 'string',
        description: 'Commit hash or ref (e.g., HEAD, abc1234, main~2)',
      },
      filepath: {
        type: 'string',
        description: 'Optional: show only specific file from commit',
      },
      stat: {
        type: 'boolean',
        default: false,
        description: 'Show only stats (files changed, insertions, deletions)',
      },
    },
    required: ['ref'],
  },
};

export async function executeGitShow(
  workspaceDir: string,
  args: GitShowArgs
): Promise<MCPToolResult> {
  try {
    if (!(await isGitRepo(workspaceDir))) {
      return {
        content: [{ type: 'text', text: '[Not a git repository]' }],
        isError: true,
      };
    }

    if (!args.ref) {
      return {
        content: [{ type: 'text', text: 'ref is required' }],
        isError: true,
      };
    }

    const gitArgs = ['show'];

    if (args.stat) {
      gitArgs.push('--stat');
    }

    gitArgs.push(args.ref);

    if (args.filepath) {
      gitArgs.push('--', args.filepath);
    }

    const { stdout, stderr } = await execGit(workspaceDir, gitArgs);

    if (stderr && stderr.includes('fatal:')) {
      return {
        content: [{ type: 'text', text: `Git show failed: ${stderr}` }],
        isError: true,
      };
    }

    if (!stdout.trim()) {
      return {
        content: [{ type: 'text', text: `No content found for ref: ${args.ref}` }],
      };
    }

    // Truncate if too long
    let output = stdout;
    if (output.length > MAX_OUTPUT_LENGTH) {
      output = output.slice(0, MAX_OUTPUT_LENGTH) +
        `\n\n[!] Output truncated (${stdout.length} chars). Use filepath or stat option.`;
    }

    return {
      content: [{ type: 'text', text: output }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Git show failed: ${error instanceof Error ? error.message : String(error)}`,
      }],
      isError: true,
    };
  }
}
