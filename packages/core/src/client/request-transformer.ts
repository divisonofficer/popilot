/**
 * Request Transformer for POSTECH GenAI API
 * Transforms OpenAI-style messages to POSTECH API format
 *
 * TypeScript port of continuedev/src/transform/request_transformer.py
 */

import type { Message, ContentPart } from '../types.js';

// Default configuration constants
// A2 API has more generous limits, so we can afford larger contexts
const DEFAULT_HARD_LIMIT = 8000;              // Increased for A2 API (was 4400)
const DEFAULT_MAX_TEXT_LENGTH = 120000;        // Doubled for A2 API (was 60000)
const DEFAULT_MAX_TOOL_OUTPUT_LENGTH = 8000;   // Doubled for A2 API (was 4000) - includes validation output
const DEFAULT_KEEP_RECENT_MESSAGES = 10;       // Keep more context (was 6)

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
[CRITICAL] You have REAL tools connected to this system. When I ask to modify files, you MUST use the [CODE]tool format below.
Do NOT say "I cannot execute tools" - you CAN and MUST use them!
`;

// MCP Tool System Prompt - All available tools for file operations
const MCP_TOOL_PROMPT = `
=== Popilot Tool System ===

[!!!] REQUIRED BEHAVIOR [!!!]
You are a coding agent that directly modifies code. Do NOT explain - EXECUTE!

1. File modification request -> MUST use tools (NO explanations!)
2. Markdown code blocks FORBIDDEN! -> Use [CODE]tool format only
3. Here is how to do it FORBIDDEN! -> Directly call tools to modify
4. Unknown file location -> Use find_files (e.g., pattern="App.tsx")

[!] Explanation-only responses are considered FAILURE!

# Tool call format:
[CODE]tool
TOOL_NAME: toolname
BEGIN_ARG: argname
value
END_ARG
[CODE]

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

6. edit_file - Overwrite entire file
   Args: filepath (required), content (required)

7. file.applyTextEdits - Partial edit (atomic, recommended)
   Args: filepath (required), expectedSha256 (required), edits (required)
   Workflow: file.read to get sha256 -> file.applyTextEdits to modify

   [!!!] EDITS FORMAT (REQUIRED):
   edits: [
     { "startLine": 10, "endLine": 15, "newText": "replacement code here" }
   ]
   - startLine: first line to replace (1-indexed)
   - endLine: last line to replace (1-indexed)
   - newText: replacement text (can be multi-line string)

   [X] WRONG FORMAT (DO NOT USE):
   - edits: [{ "range": {...} }]  <- WRONG!
   - edits: []  <- WRONG! Must have at least one edit
   - edits: null/undefined  <- WRONG!

8. run_terminal_command - Execute terminal command
   Args: command (required)

9. tree - Show project structure tree (recursive)
   Args: dirpath (optional), depth (optional, default: 3)

10. find_files - Find files by name pattern (RECOMMENDED for locating files!)
    Args: pattern (required, e.g., "*.tsx", "App.tsx", "*config*")
    [!] Use this instead of run_terminal_command with find!

# File modification workflow:
1. find_files to locate target file (e.g., pattern="App.tsx")
2. file.search to find exact location in file (get line number)
3. file.read with startLine/endLine to read only needed part
4. file.applyTextEdits for partial modification
5. CHECK the [Modified section preview] in result!
6. If [SYNTAX WARNINGS] appear, FIX immediately with another file.applyTextEdits

# [!!!] POST-EDIT VERIFICATION [!!!]
- file.applyTextEdits now returns syntax validation warnings
- If you see [SYNTAX WARNINGS], you MUST fix them immediately!
- Common issues: unclosed brackets, broken comments, mismatched quotes
- Use the [Modified section preview] to verify your edit is correct
- If edit looks wrong, fix it with another file.applyTextEdits call

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
1. Please provide file path - FORBIDDEN! Use tree/list_directory
2. Please upload file - FORBIDDEN! Use file.read
3. Which file? - FORBIDDEN! Explore yourself
4. Need more info - FORBIDDEN! Gather info with tools

# [!!!] ABSOLUTE PROHIBITIONS [!!!]
1. Do NOT write [Tool Result]: yourself - system provides it
2. Do NOT fake results like Done or Successfully applied
3. After file.read, MUST call file.applyTextEdits with [CODE]tool format
4. Markdown code blocks do NOT modify files!
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
   * Sanitize text to prevent POSTECH API parsing errors.
   */
  private sanitizeText(text: string): string {
    // Step 1: Replace code block markers with safe alternatives
    let result = text
      .replace(/```/g, '[CODE]')
      .replace(/`/g, '')
      .replace(/'''/g, '[CODE]')
      .replace(/"""/g, '[CODE]');

    // Step 2: Handle backslashes properly for double-JSON-encoding
    result = result
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '')
      .replace(/\\\\/g, '/');

    // Step 3: Remove remaining single backslashes that could cause issues
    result = result.replace(/\\(?![nrt"\\/])/g, '');

    // Step 4: Normalize line endings
    result = result.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Step 5: Remove control characters except newline and tab
    result = result.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

    // Step 5.5: Remove Unicode variation selectors and other invisible characters
    // These cause "failed to parse stringified json" errors on the backend
    result = result
      // Variation selectors (U+FE00-U+FE0F) - make emojis colored but invisible
      .replace(/[\uFE00-\uFE0F]/g, '')
      // Zero-width characters
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      // Common emojis to text (warning, check, cross, etc.) - using unicode flag for proper handling
      .replace(/\u26A0/g, '[!]')  // ⚠ Warning sign
      .replace(/\u2713|\u2714/g, '[v]')  // ✓✔ Check marks
      .replace(/\u2717|\u2718/g, '[x]')  // ✗✘ X marks
      .replace(/\u274C/g, '[x]')  // ❌ Cross mark
      .replace(/\u2705/g, '[v]')  // ✅ Check mark
      .replace(/\u{1F4C1}|\u{1F4C2}/gu, '[DIR]')  // 📁📂 Folder
      .replace(/\u{1F4C4}|\u{1F4C3}/gu, '[FILE]')  // 📄📃 File
      .replace(/\u{1F4DD}/gu, '[EDIT]')  // 📝 Memo
      .replace(/\u{1F527}|\u{1F528}/gu, '[TOOL]')  // 🔧🔨 Tools
      .replace(/\u2753|\u2754/g, '?')  // ❓❔ Question marks
      .replace(/\u2757|\u2755/g, '!')  // ❗❕ Exclamation marks
      .replace(/\u{1F4A1}/gu, '[IDEA]')  // 💡 Light bulb
      .replace(/\u{1F680}/gu, '[GO]')  // 🚀 Rocket
      .replace(/\u231B|\u23F3/g, '[WAIT]')  // ⏳⌛ Hourglass
      // Remove any remaining emojis (broad pattern for most emoji ranges)
      .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')
      .replace(/[\u{2600}-\u{26FF}]/gu, '')
      .replace(/[\u{2700}-\u{27BF}]/gu, '');

    // Step 6: Replace box drawing and block characters with ASCII equivalents
    // These Unicode characters cause "failed to parse stringified json" errors on the backend
    result = result
      // Horizontal lines
      .replace(/[─━┄┅┈┉═]/g, '-')
      // Vertical lines
      .replace(/[│┃┆┇┊┋║]/g, '|')
      // Corners (top-left)
      .replace(/[┌┍┎┏╔╓╒]/g, '+')
      // Corners (top-right)
      .replace(/[┐┑┒┓╗╖╕]/g, '+')
      // Corners (bottom-left)
      .replace(/[└┕┖┗╚╙╘]/g, '+')
      // Corners (bottom-right)
      .replace(/[┘┙┚┛╝╜╛]/g, '+')
      // T-junctions
      .replace(/[├┝┞┟┠┡┢┣╠╟╞]/g, '+')
      .replace(/[┤┥┦┧┨┩┪┫╣╢╡]/g, '+')
      .replace(/[┬┭┮┯┰┱┲┳╦╥╤]/g, '+')
      .replace(/[┴┵┶┷┸┹┺┻╩╨╧]/g, '+')
      // Cross
      .replace(/[┼┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋╬╫╪]/g, '+')
      // Block elements
      .replace(/[█▓▒░]/g, '#')
      .replace(/[▀▄▌▐]/g, '#')
      // Other common box characters
      .replace(/[■□▪▫]/g, '#')
      .replace(/[●○◐◑◒◓]/g, 'o')
      .replace(/[◆◇◈]/g, '*')
      .replace(/[★☆]/g, '*')
      .replace(/[▲△▼▽◀◁▶▷]/g, '>');

    // Step 7: Ensure JSON-safe (final validation)
    result = this.ensureJsonSafe(result);

    return result;
  }

  /**
   * Ensure text can be safely serialized to JSON.
   * Does a round-trip encode/decode to catch any issues.
   */
  private ensureJsonSafe(text: string): string {
    try {
      // Test that the text can be JSON encoded
      const encoded = JSON.stringify({ test: text });
      // Parse it back to verify
      JSON.parse(encoded);
      return text;
    } catch {
      // If encoding fails, do more aggressive sanitization
      // Remove any characters that could cause issues
      let safeText = '';
      for (const char of text) {
        const code = char.charCodeAt(0);
        // Keep printable ASCII, newlines, tabs, and common Unicode
        if (char === '\n' || char === '\t' || (code >= 32 && code < 127) || code >= 160) {
          safeText += char;
        }
      }
      return safeText;
    }
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
