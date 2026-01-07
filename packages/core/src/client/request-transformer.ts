/**
 * Request Transformer for POSTECH GenAI API
 * Transforms OpenAI-style messages to POSTECH API format
 *
 * TypeScript port of continuedev/src/transform/request_transformer.py
 */

import type { Message, ContentPart } from '../types.js';

// Default configuration constants
// A2 API has more generous limits AND no thread/history, so we keep more context
const DEFAULT_HARD_LIMIT = 12000;              // Increased for A2 API (was 4400)
const DEFAULT_MAX_TEXT_LENGTH = 200000;        // Increased for A2 API no-thread mode (was 60000)
const DEFAULT_MAX_TOOL_OUTPUT_LENGTH = 12000;  // Increased for validation output + context (was 4000)
const DEFAULT_KEEP_RECENT_MESSAGES = 20;       // Keep much more context since A2 has no thread (was 6)

/**
 * Configuration options for RequestTransformer.
 */
export interface TransformerConfig {
  /** Maximum characters for AI response (default: 4400) */
  hardLimit?: number;
  /** Maximum total text length for request (default: 60000) */
  maxTextLength?: number;
  /** Maximum characters for tool output (default: 800) */
  maxToolOutputLength?: number;
  /** Number of recent messages to keep in full (default: 6) */
  keepRecentMessages?: number;
  /** Model provider for provider-specific prompts (default: 'anthropic') */
  modelProvider?: 'anthropic' | 'azure' | 'google';
}

/**
 * Generate response constraint prompt based on config.
 */
function generateResponseConstraint(hardLimit: number): string {
  return `Keep response under ${hardLimit} characters. Be concise.`;
}

// GPT-specific tool reminder (GPT tends to ignore tool system)
const GPT_TOOL_REMINDER = `
[CRITICAL] You have REAL tools connected to this system. When I ask to modify files, you MUST use the tool format below.
Do NOT say "I cannot execute tools" - you CAN and MUST use them!
`;

// MCP Tool System Prompt - All available tools for file operations
const MCP_TOOL_PROMPT = `
=== Popilot Tool System ===

You are a coding agent that directly modifies code. Do NOT explain - EXECUTE!

1. File modification request -> MUST use tools
2. Unknown file location -> Use find_files first
3. Do NOT ask questions - explore with tools!

# [!!!] CRITICAL: EXACT Tool Format [!!!]

YOU MUST USE THIS EXACT FORMAT. NO OTHER FORMAT WILL WORK!

\`\`\`tool
TOOL_NAME: toolname
BEGIN_ARG: argname
value
END_ARG
\`\`\`

[X] WRONG FORMATS (WILL NOT WORK):
- <!-- tools: xxx --> (HTML comments don't work!)
- <tool>xxx</tool> (XML tags don't work!)
- {"tool": "xxx"} (JSON format doesn't work!)
- function_call: xxx (function call syntax doesn't work!)

[O] ONLY THIS FORMAT WORKS:
\`\`\`tool
TOOL_NAME: find_files
BEGIN_ARG: query
apptsx
END_ARG
\`\`\`

# Available tools:

1. list_directory - List directory contents
   Args: dirpath (optional, default: workspace root)

2. read_file - Read file (simple)
   Args: filepath (required)

3. file.read - Read file + SHA256 (required before modification)
   Args: filepath (required), startLine (optional), endLine (optional)
   [!] For large files, use startLine/endLine to read only 100-200 lines!

4. file.search - Search pattern in file
   Args: filepath (required), pattern (required, regex)

5. create_new_file - Create new file
   Args: filepath (required), content (required)

6. file.applyTextEdits - ⭐ PRIMARY TOOL for file modification
   Args: filepath (required), expectedSha256 (required), edits (required), dryRun (optional)

   [!] ALWAYS use dryRun=true first to preview changes!

   MODES:
   - INSERT: omit endLine → inserts BEFORE startLine (no deletion)
   - REPLACE: include endLine → replaces lines startLine..endLine (single-line: endLine=startLine)

   EDITS FORMAT:
   INSERT: [{ "startLine": 10, "newText": "new code" }]
   REPLACE: [{ "startLine": 15, "endLine": 20, "newText": "replacement", "anchor": { "expectedText": "old code" } }]

   [!] For REPLACE, always include anchor.expectedText for safety!

7. run_terminal_command - Execute terminal command
   Args: command (required)

8. tree - Show project structure tree (recursive)
   Args: dirpath (optional), depth (optional, default: 3)

9. find_files - Fuzzy file search like VS Code Ctrl+P (RECOMMENDED!)
    Args: query (required) - partial filename or key characters
    Examples:
    - "apptsx" → App.tsx, AppTest.tsx
    - "reqtrans" → request-transformer.ts
    - "pkgjson" → package.json
    - "idx" → index.ts, index.tsx
    [!] No need for exact glob patterns - just type key characters!

# [!!!] FILE MODIFICATION - USE file.applyTextEdits! [!!!]

## ⭐ RECOMMENDED: Atomic Line Edits (file.applyTextEdits)
This tool provides precise, line-based editing with SHA256 verification.

### WORKFLOW (MUST FOLLOW):
1. file.read to get file content + SHA256
2. Identify exact line numbers from the output
3. file.applyTextEdits with dryRun=true first (preview changes)
4. If preview looks good, file.applyTextEdits with dryRun=false

### ⭐ PREFERRED: INSERT MODE (additive editing)
Insert new code without deleting existing lines - SAFEST approach!

- Omit endLine entirely (do NOT include endLine at all)
- newText is inserted BEFORE startLine
- Existing code is preserved
- [!] If you include endLine, it becomes REPLACE mode!

Example: Add import at line 5
\`\`\`tool
TOOL_NAME: file.applyTextEdits
BEGIN_ARG: filepath
packages/cli/src/App.tsx
END_ARG
BEGIN_ARG: expectedSha256
(SHA256 from file.read)
END_ARG
BEGIN_ARG: edits
[{ "startLine": 5, "newText": "import { newModule } from './newModule';" }]
END_ARG
\`\`\`

### REPLACE MODE (use only when necessary)
Only use when you MUST delete existing lines:
- Provide endLine >= startLine
- MUST include anchor.expectedText for safety!
- Single line replace: startLine === endLine

Example: Replace lines 15-17
\`\`\`tool
TOOL_NAME: file.applyTextEdits
BEGIN_ARG: filepath
packages/cli/src/App.tsx
END_ARG
BEGIN_ARG: expectedSha256
(SHA256 from file.read)
END_ARG
BEGIN_ARG: edits
[{ "startLine": 15, "endLine": 17, "newText": "// Fixed code", "anchor": { "expectedText": "buggy code" } }]
END_ARG
\`\`\`

### CRITICAL RULES:
1. PREFER INSERT over REPLACE when possible
2. ALWAYS use dryRun=true first to preview changes
3. For REPLACE: MUST include anchor.expectedText
4. Line numbers are 1-indexed (from file.read output)
5. NEVER guess line numbers - always read first!
6. If SHA256 mismatch: re-read file and retry

### [X] FORBIDDEN:
- Guessing line numbers without file.read
- REPLACE without anchor.expectedText
- Using edit_file (causes file corruption!)

# [!!!] POST-EDIT VERIFICATION [!!!]
- After file.applyTextEdits, check the diff preview in response
- If something looks wrong, file.read again and fix with another edit

# Rules:
- MUST call tools for file operations
- expectedSha256: copy from file.read result
- startLine/endLine: 1-indexed
- Do NOT explain - call tools!

# [!!!] FILE PATH RULES [!!!]
- ALWAYS use EXACT paths from find_files or tree results
- NEVER guess or shorten paths (e.g., "App.tsx" is WRONG, use "packages/cli/src/App.tsx")
- Paths are RELATIVE to workspace root
- If unsure, use find_files FIRST to get correct path
- Copy-paste paths exactly from tool results!

[X] WRONG PATHS (SYSTEM WILL REJECT):
- "(정확한 파일 경로)"  <- NO! Korean placeholder text!
- "(Enter file path here)"  <- NO! Placeholder!
- "App.tsx"  <- NO! Missing directory path!
- "<filepath>"  <- NO! Angle bracket placeholder!
- "example/file.ts"  <- NO! Must be real path from find_files!

[O] CORRECT PATH EXAMPLES:
- "packages/cli/src/App.tsx"  <- YES! Full relative path
- "packages/core/src/client/postech-client.ts"  <- YES! From find_files result

# [!!!] Tool call limit [!!!]
- Max 3-5 tools per response (A2 API allows more)
- Need more? Call in next response after getting results
- Complex edits: break into multiple file.applyTextEdits calls

# [!!!] FORBIDDEN behaviors [!!!]
1. "Please provide file path" - FORBIDDEN! Use tree/find_files
2. "Please upload file" - FORBIDDEN! Use file.read
3. "Which file?" - FORBIDDEN! Explore yourself
4. "Need more info" - FORBIDDEN! Gather info with tools

# [!!!] ABSOLUTE PROHIBITIONS [!!!]
1. Do NOT write [Tool Result]: yourself - system provides it
2. Do NOT fake results like "Done" or "Successfully applied"
3. After file.read, MUST use file.applyTextEdits
`;

function generateUserWrapperPrefix(hardLimit: number): string {
  return `[User message - respond concisely]`;
}
const USER_WRAPPER_SUFFIX = ``;

/**
 * Transforms messages to POSTECH API text format.
 */
export class RequestTransformer {
  private hardLimit: number;
  private maxTextLength: number;
  private maxToolOutputLength: number;
  private keepRecentMessages: number;
  private modelProvider: 'anthropic' | 'azure' | 'google';

  constructor(config: TransformerConfig = {}) {
    this.hardLimit = config.hardLimit ?? DEFAULT_HARD_LIMIT;
    this.maxTextLength = config.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
    this.maxToolOutputLength = config.maxToolOutputLength ?? DEFAULT_MAX_TOOL_OUTPUT_LENGTH;
    this.keepRecentMessages = config.keepRecentMessages ?? DEFAULT_KEEP_RECENT_MESSAGES;
    this.modelProvider = config.modelProvider ?? 'anthropic';
  }

  /**
   * Get current configuration (for debugging).
   */
  getConfig(): TransformerConfig {
    return {
      hardLimit: this.hardLimit,
      maxTextLength: this.maxTextLength,
      maxToolOutputLength: this.maxToolOutputLength,
      keepRecentMessages: this.keepRecentMessages,
      modelProvider: this.modelProvider,
    };
  }

  /**
   * Update configuration at runtime.
   */
  updateConfig(config: Partial<TransformerConfig>): void {
    if (config.hardLimit !== undefined) this.hardLimit = config.hardLimit;
    if (config.maxTextLength !== undefined) this.maxTextLength = config.maxTextLength;
    if (config.maxToolOutputLength !== undefined) this.maxToolOutputLength = config.maxToolOutputLength;
    if (config.keepRecentMessages !== undefined) this.keepRecentMessages = config.keepRecentMessages;
    if (config.modelProvider !== undefined) this.modelProvider = config.modelProvider;
  }

  /**
   * Combine message history into a single prompt.
   * POSTECH API expects a single text query, so we combine all messages.
   */
  transform(messages: Message[]): string {
    const userWrapperPrefix = generateUserWrapperPrefix(this.hardLimit);
    const parts: string[] = [];

    // // Only add response length constraint for Claude (anthropic) due to 5KB API limit
    // if (this.modelProvider === 'anthropic') {
    //   const responseConstraint = generateResponseConstraint(this.hardLimit);
    //   parts.push(responseConstraint);
    // }

    // Add GPT-specific tool reminder (GPT tends to think it can't use tools)
    if (this.modelProvider === 'azure' || this.modelProvider === 'google') {
      parts.push(GPT_TOOL_REMINDER);
    }

    parts.push(MCP_TOOL_PROMPT);

    if (messages.length === 1) {
      const content = this.extractTextContent(messages[0].content);
      parts.push(`${userWrapperPrefix}\n[User]: ${content}\n${USER_WRAPPER_SUFFIX}`);
      return this.truncateIfNeeded(this.sanitizeText(parts.join('\n\n')));
    }

    // Find the last user message index
    let lastUserIdx = -1;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'user') {
        lastUserIdx = i;
      }
    }

    // Determine which messages to keep fully (recent ones)
    const totalMsgs = messages.length;
    const keepFromIdx = Math.max(0, totalMsgs - this.keepRecentMessages);

    let skippedCount = 0;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const content = this.extractTextContent(msg.content);
      if (!content) continue;

      // Skip CLI system messages (not relevant to AI)
      if (content.startsWith('[SYSTEM]')) {
        continue;
      }

      // System messages always kept
      if (msg.role === 'system') {
        parts.push(`[System Instructions]: ${content.slice(0, 2000)}`);
        continue;
      }

      // Skip old messages (except system)
      if (i < keepFromIdx) {
        skippedCount++;
        continue;
      }

      // Add skipped message indicator once
      if (skippedCount > 0 && i === keepFromIdx) {
        parts.push(`[...${skippedCount} previous messages omitted...]`);
        skippedCount = 0;
      }

      // Truncate tool outputs heavily
      if (msg.role === 'tool') {
        let truncated = content.slice(0, this.maxToolOutputLength);
        if (content.length > this.maxToolOutputLength) {
          // Check if this is a file.read result (has SHA256)
          const isFileRead = content.includes('SHA256:');
          if (isFileRead) {
            truncated += `\n\n[!] Full file content stored in system. Do NOT re-read! Use SHA256 with file.applyTextEdits.`;
          } else {
            truncated += `... (showing partial of ${content.length} chars)`;
          }
        }
        parts.push(`[Tool Result]: ${truncated}`);
      } else if (msg.role === 'user') {
        if (i === lastUserIdx) {
          parts.push(`${userWrapperPrefix}\n[User]: ${content}\n${USER_WRAPPER_SUFFIX}`);
        } else {
          parts.push(`[User]: ${content.slice(0, 1000)}`);
        }
      } else if (msg.role === 'assistant') {
        // Truncate old assistant responses
        let truncated = content.slice(0, 1500);
        if (content.length > 1500) {
          truncated += '...';
        }
        parts.push(`[Assistant]: ${truncated}`);
      } else {
        parts.push(`[${msg.role}]: ${content.slice(0, 500)}`);
      }
    }

    const combined = this.sanitizeText(parts.join('\n\n'));
    return this.truncateIfNeeded(combined);
  }

  /**
   * Sanitize text for API.
   * A2 API has issues with backticks in JSON payload.
   */
  private sanitizeText(text: string): string {
    // Normalize line endings
    let result = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Remove control characters except newline and tab
    result = result.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

    // Escape backticks to avoid JSON parsing errors in A2 API
    // Using backslash escape: ` -> \`
    result = result.replace(/`/g, '\\`');

    return result;
  }

  /**
   * Truncate text from beginning if too long, keeping recent context.
   */
  private truncateIfNeeded(text: string): string {
    if (text.length <= this.maxTextLength) {
      return text;
    }

    let truncated = text.slice(-this.maxTextLength);

    // Find first newline to avoid cutting mid-sentence
    const firstNewline = truncated.indexOf('\n');
    if (firstNewline > 0 && firstNewline < 500) {
      truncated = truncated.slice(firstNewline + 1);
    }

    return `[Previous conversation truncated...]\n\n${truncated}`;
  }

  /**
   * Extract text from content which can be string or list of parts.
   */
  private extractTextContent(content: string | ContentPart[] | undefined): string {
    if (!content) return '';
    if (typeof content === 'string') return content;

    const textParts: string[] = [];
    for (const part of content) {
      if (typeof part === 'string') {
        textParts.push(part);
      } else if (part.type === 'text' && part.text) {
        textParts.push(part.text);
      }
    }
    return textParts.join(' ');
  }
}
