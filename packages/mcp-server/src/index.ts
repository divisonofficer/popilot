#!/usr/bin/env node
/**
 * Popilot MCP File Server
 * Provides atomic file editing capabilities via MCP protocol
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

// Import atomic edit tools
import { fileReadTool, executeFileRead, type FileReadArgs } from './tools/file-read.js';
import { fileSearchTool, executeFileSearch, type FileSearchArgs } from './tools/file-search.js';
import { fileApplyEditsTool, executeFileApplyEdits, type FileApplyEditsArgs } from './tools/file-apply-edits.js';
import { fuzzyFindFiles, formatFuzzyResults } from './core/fuzzy-finder.js';

// Import git tools
import {
  gitStatusTool, executeGitStatus, type GitStatusArgs,
  gitDiffTool, executeGitDiff, type GitDiffArgs,
  gitLogTool, executeGitLog, type GitLogArgs,
  gitRestoreTool, executeGitRestore, type GitRestoreArgs,
  gitShowTool, executeGitShow, type GitShowArgs,
} from './tools/git-tools.js';

const execAsync = promisify(exec);

// Workspace directory - can be set via:
// 1. WORKSPACE_DIR environment variable
// 2. First command line argument
// 3. Current working directory
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || process.argv[2] || process.cwd();
console.error(`Popilot MCP Server - Workspace: ${WORKSPACE_DIR}`);

const server = new Server(
  {
    name: 'popilot-mcp-server',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Resolve filepath - handle relative and absolute paths
function resolvePath(filepath: string): string {
  if (!filepath) {
    throw new Error('filepath is required and cannot be empty');
  }

  // If absolute path, use as-is
  if (path.isAbsolute(filepath)) {
    return filepath;
  }

  // Otherwise, resolve relative to workspace
  return path.join(WORKSPACE_DIR, filepath);
}

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'create_new_file',
        description: 'Create a new file with the specified content. Creates parent directories if needed.',
        inputSchema: {
          type: 'object',
          properties: {
            filepath: {
              type: 'string',
              description: 'The path to the file to create (relative to workspace or absolute)',
            },
            content: {
              type: 'string',
              description: 'The content to write to the file',
            },
          },
          required: ['filepath', 'content'],
        },
      },
      {
        name: 'edit_file',
        description: 'Edit an existing file by replacing its content',
        inputSchema: {
          type: 'object',
          properties: {
            filepath: {
              type: 'string',
              description: 'The path to the file to edit',
            },
            content: {
              type: 'string',
              description: 'The new content for the file',
            },
          },
          required: ['filepath', 'content'],
        },
      },
      {
        name: 'read_file',
        description: 'Read the contents of a file',
        inputSchema: {
          type: 'object',
          properties: {
            filepath: {
              type: 'string',
              description: 'The path to the file to read',
            },
          },
          required: ['filepath'],
        },
      },
      {
        name: 'run_terminal_command',
        description: 'Run a terminal command in the workspace directory',
        inputSchema: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'The command to run',
            },
          },
          required: ['command'],
        },
      },
      {
        name: 'list_directory',
        description: 'List files and directories in a path',
        inputSchema: {
          type: 'object',
          properties: {
            dirpath: {
              type: 'string',
              description: 'The directory path to list (defaults to workspace root)',
            },
          },
          required: [],
        },
      },
      {
        name: 'tree',
        description: 'Show directory tree structure recursively. Useful for understanding project layout.',
        inputSchema: {
          type: 'object',
          properties: {
            dirpath: {
              type: 'string',
              description: 'The directory path to show tree (defaults to workspace root)',
            },
            depth: {
              type: 'number',
              description: 'Maximum depth to traverse (default: 3)',
            },
          },
          required: [],
        },
      },
      // Fuzzy file finder (VS Code Ctrl+P style)
      {
        name: 'find_files',
        description: `Find files by name using fuzzy matching (like VS Code Ctrl+P).

Examples:
- "apptsx" → finds App.tsx, AppTest.tsx
- "reqtrans" → finds request-transformer.ts
- "idx" → finds index.ts, index.tsx
- "pkg" → finds package.json files

Tips: Use key characters from filename, no need for exact glob patterns.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query - can be partial filename, abbreviation, or key characters',
            },
            maxResults: {
              type: 'number',
              description: 'Maximum results to return (default: 20, max: 50)',
            },
          },
          required: ['query'],
        },
      },
      // Atomic edit tools
      fileReadTool,
      fileSearchTool,
      fileApplyEditsTool,
      // Git tools - for tracking changes
      gitStatusTool,
      gitDiffTool,
      gitLogTool,
      gitRestoreTool,
      gitShowTool,
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'create_new_file': {
        const filepath = resolvePath(args?.filepath as string);
        const content = (args?.content as string) || '';

        // Create parent directories if they don't exist
        const dir = path.dirname(filepath);
        await fs.mkdir(dir, { recursive: true });

        // Write the file
        await fs.writeFile(filepath, content, 'utf-8');

        return {
          content: [
            {
              type: 'text',
              text: `Successfully created file: ${filepath}`,
            },
          ],
        };
      }

      case 'edit_file': {
        const filepath = resolvePath(args?.filepath as string);
        const content = (args?.content as string) || '';

        // Check if file exists
        try {
          await fs.access(filepath);
        } catch {
          throw new Error(`File does not exist: ${filepath}`);
        }

        // Write the file
        await fs.writeFile(filepath, content, 'utf-8');

        return {
          content: [
            {
              type: 'text',
              text: `Successfully edited file: ${filepath}`,
            },
          ],
        };
      }

      case 'read_file': {
        const filepath = resolvePath(args?.filepath as string);

        const content = await fs.readFile(filepath, 'utf-8');

        return {
          content: [
            {
              type: 'text',
              text: content,
            },
          ],
        };
      }

      case 'run_terminal_command': {
        const command = args?.command as string;

        if (!command) {
          throw new Error('command is required');
        }

        const { stdout, stderr } = await execAsync(command, {
          cwd: WORKSPACE_DIR,
          timeout: 60000, // 60 second timeout
        });

        let result = '';
        if (stdout) result += stdout;
        if (stderr) result += '\n[stderr]\n' + stderr;

        return {
          content: [
            {
              type: 'text',
              text: result || '(no output)',
            },
          ],
        };
      }

      case 'list_directory': {
        const dirpath = args?.dirpath ? resolvePath(args.dirpath as string) : WORKSPACE_DIR;

        const entries = await fs.readdir(dirpath, { withFileTypes: true });
        const items = entries.map((entry) => {
          const type = entry.isDirectory() ? '[DIR]' : '[FILE]';
          return `${type} ${entry.name}`;
        });

        return {
          content: [
            {
              type: 'text',
              text: items.join('\n') || '(empty directory)',
            },
          ],
        };
      }

      case 'tree': {
        const dirpath = args?.dirpath ? resolvePath(args.dirpath as string) : WORKSPACE_DIR;
        const maxDepth = (args?.depth as number) || 3;

        // Directories to skip
        const skipDirs = new Set(['node_modules', '.git', '.turbo', 'dist', 'build', '.next', '__pycache__', '.popilot_log']);

        async function buildTree(dir: string, prefix: string, depth: number): Promise<string[]> {
          if (depth > maxDepth) return [];

          const lines: string[] = [];
          try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            // Sort: directories first, then files
            entries.sort((a, b) => {
              if (a.isDirectory() && !b.isDirectory()) return -1;
              if (!a.isDirectory() && b.isDirectory()) return 1;
              return a.name.localeCompare(b.name);
            });

            for (let i = 0; i < entries.length; i++) {
              const entry = entries[i];
              const isLast = i === entries.length - 1;
              const connector = isLast ? '+-- ' : '|-- ';
              const newPrefix = prefix + (isLast ? '    ' : '|   ');

              if (entry.isDirectory()) {
                if (skipDirs.has(entry.name)) {
                  lines.push(`${prefix}${connector}${entry.name}/ (skipped)`);
                } else {
                  lines.push(`${prefix}${connector}${entry.name}/`);
                  const subTree = await buildTree(path.join(dir, entry.name), newPrefix, depth + 1);
                  lines.push(...subTree);
                }
              } else {
                lines.push(`${prefix}${connector}${entry.name}`);
              }
            }
          } catch {
            lines.push(`${prefix}(error reading directory)`);
          }
          return lines;
        }

        const rootName = path.basename(dirpath) || dirpath;
        const tree = await buildTree(dirpath, '', 1);
        const result = [`${rootName}/`, ...tree].join('\n');

        return {
          content: [
            {
              type: 'text',
              text: result || '(empty directory)',
            },
          ],
        };
      }

      // Fuzzy file finder
      case 'find_files': {
        const query = String(args?.query ?? '');
        if (!query) {
          throw new Error('query is required');
        }
        const maxResults = Math.min(Number(args?.maxResults) || 20, 50);

        const matches = await fuzzyFindFiles(query, WORKSPACE_DIR, maxResults);
        const result = formatFuzzyResults(query, matches);

        return {
          content: [
            {
              type: 'text',
              text: result,
            },
          ],
        };
      }

      // Atomic edit tools
      case 'file.read':
        return await executeFileRead(resolvePath, args as unknown as FileReadArgs);

      case 'file.search':
        return await executeFileSearch(resolvePath, args as unknown as FileSearchArgs);

      case 'file.applyTextEdits':
        return await executeFileApplyEdits(resolvePath, args as unknown as FileApplyEditsArgs);

      // Git tools
      case 'git.status':
        return await executeGitStatus(WORKSPACE_DIR, args as unknown as GitStatusArgs);

      case 'git.diff':
        return await executeGitDiff(WORKSPACE_DIR, args as unknown as GitDiffArgs);

      case 'git.log':
        return await executeGitLog(WORKSPACE_DIR, args as unknown as GitLogArgs);

      case 'git.restore':
        return await executeGitRestore(WORKSPACE_DIR, args as unknown as GitRestoreArgs);

      case 'git.show':
        return await executeGitShow(WORKSPACE_DIR, args as unknown as GitShowArgs);

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Popilot MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
