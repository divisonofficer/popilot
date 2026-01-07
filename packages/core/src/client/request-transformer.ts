/**
 * Request Transformer for POSTECH GenAI API
 * Transforms OpenAI-style messages to POSTECH API format
 *
 * TypeScript port of continuedev/src/transform/request_transformer.py
 */

import type { Message, ContentPart, FileAttachment } from '../types.js';
import { getMimeType } from './file-uploader.js';

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
  /** Extract file.read results as separate file attachments (default: true) */
  extractFileAttachments?: boolean;
  /** Minimum file size to extract as attachment (default: 2000 chars) */
  minFileAttachmentSize?: number;
}

/**
 * Result of transform() - includes both message and file attachments.
 */
export interface TransformerResult {
  /** The transformed message text */
  message: string;
  /** File attachments extracted from tool results (for A2 API files field) */
  files: FileAttachment[];
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
// NOTE: Using [CODE]tool format instead of backticks to avoid JSON parsing issues with A2 API
const MCP_TOOL_PROMPT = `
=== Popilot Tool System ===

You are a coding agent that directly modifies code. Do NOT explain - EXECUTE!

1. File modification request -> MUST use tools
2. Unknown file location -> Use find_files first
3. Do NOT ask questions - explore with tools!

# [!!!] CRITICAL: EXACT Tool Format [!!!]

YOU MUST USE THIS EXACT FORMAT. NO OTHER FORMAT WILL WORK!

[CODE]tool
TOOL_NAME: toolname
BEGIN_ARG: argname
value
END_ARG
[CODE]

[X] WRONG FORMATS (WILL NOT WORK):
- <!-- tools: xxx --> (HTML comments don't work!)
- <tool>xxx</tool> (XML tags don't work!)
- {"tool": "xxx"} (JSON format doesn't work!)
- function_call: xxx (function call syntax doesn't work!)

[O] ONLY THIS FORMAT WORKS:
[CODE]tool
TOOL_NAME: find_files
BEGIN_ARG: query
apptsx
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
[CODE]tool
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
[CODE]

### REPLACE MODE (use only when necessary)
Only use when you MUST delete existing lines:
- Provide endLine >= startLine
- MUST include anchor.expectedText for safety!
- Single line replace: startLine === endLine

Example: Replace lines 15-17
[CODE]tool
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
[CODE]

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

# [!!!] GIT TOOLS - Track Your Changes [!!!]

Use git tools to track what you've modified and recover from mistakes!

## Available Git Tools:

10. git.status - Show changed files (staged/unstaged/untracked)
    Args: paths (optional array)
    [!] Use this to see what files you've modified!

11. git.diff - Show exact changes in files
    Args: filepath (optional), staged (boolean), ref (optional), contextLines (number)
    [!] Use this to review your modifications before/after editing!

12. git.log - Show recent commit history
    Args: count (default: 10), filepath (optional), oneline (boolean)

13. git.restore - Restore file to previous state (UNDO changes)
    Args: filepath (required), staged (boolean), source (optional ref)
    [!] Use this to undo a bad edit!

14. git.show - Show details of a specific commit
    Args: ref (required), filepath (optional), stat (boolean)

## Git Workflow for Safe Editing:

1. BEFORE editing: git.status to see current state
2. AFTER editing: git.diff to verify your changes
3. IF mistake: git.restore to undo changes

Example: Check what you changed
[CODE]tool
TOOL_NAME: git.diff
BEGIN_ARG: filepath
packages/core/src/client/postech-client.ts
END_ARG
[CODE]

Example: Undo a bad edit
[CODE]tool
TOOL_NAME: git.restore
BEGIN_ARG: filepath
packages/core/src/client/postech-client.ts
END_ARG
[CODE]

# [!!!] FORBIDDEN behaviors [!!!]
1. "Please provide file path" - FORBIDDEN! Use tree/find_files
2. "Please upload file" - FORBIDDEN! Use file.read
3. "Which file?" - FORBIDDEN! Explore yourself
4. "Need more info" - FORBIDDEN! Gather info with tools

# [!!!] ABSOLUTE PROHIBITIONS [!!!]
1. Do NOT write [Tool Result]: yourself - system provides it
2. Do NOT fake results like "Done" or "Successfully applied"
3. After file.read, MUST use file.applyTextEdits

# [!!!] FILE CONTENT HANDLING - NO ARBITRARY SUMMARIZATION [!!!]

When you receive file.read results (either inline or as attached files):

1. ALWAYS work with the FULL file content provided
2. Do NOT summarize or truncate file contents in your response
3. If a file is attached, the system has ALREADY processed it for you - use it!
4. Do NOT say "파일이 너무 길어서 일부만 표시합니다" or similar - show what's needed
5. If you need to reference specific lines, cite the exact line numbers from file.read

[X] FORBIDDEN responses about file content:
- "This file is too long, showing only part of it" - NO!
- "Let me summarize the key parts" - NO! (unless user explicitly asks)
- "Due to length, I'll skip some sections" - NO!

[O] CORRECT behavior:
- Read the full attached file content
- Reference specific line numbers when discussing code
- If user asks for specific sections, use startLine/endLine in file.read
- Work with the complete information provided
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
  private extractFileAttachments: boolean;
  private minFileAttachmentSize: number;

  // Accumulated file attachments during transform
  private fileAttachments: FileAttachment[] = [];
  private fileIdCounter = 0;

  constructor(config: TransformerConfig = {}) {
    this.hardLimit = config.hardLimit ?? DEFAULT_HARD_LIMIT;
    this.maxTextLength = config.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
    this.maxToolOutputLength = config.maxToolOutputLength ?? DEFAULT_MAX_TOOL_OUTPUT_LENGTH;
    this.keepRecentMessages = config.keepRecentMessages ?? DEFAULT_KEEP_RECENT_MESSAGES;
    this.modelProvider = config.modelProvider ?? 'anthropic';
    this.extractFileAttachments = config.extractFileAttachments ?? true;
    this.minFileAttachmentSize = config.minFileAttachmentSize ?? 2000;
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
      extractFileAttachments: this.extractFileAttachments,
      minFileAttachmentSize: this.minFileAttachmentSize,
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
    if (config.extractFileAttachments !== undefined) this.extractFileAttachments = config.extractFileAttachments;
    if (config.minFileAttachmentSize !== undefined) this.minFileAttachmentSize = config.minFileAttachmentSize;
  }

  /**
   * Combine message history into a single prompt using budget-based assembly.
   * POSTECH API expects a single text query, so we combine all messages.
   *
   * Budget priority:
   * 1. Header (MCP_TOOL_PROMPT) - MUST be preserved
   * 2. Current user message - MUST be preserved
   * 3. History - fills remaining budget (most recent first)
   *
   * @returns TransformerResult with message and file attachments
   */
  transform(messages: Message[]): TransformerResult {
    // Reset file attachments for this transform
    this.fileAttachments = [];
    this.fileIdCounter = 0;

    // 1. Build header (MUST be preserved - contains tool instructions)
    const header = this.buildHeader();
    const headerBudget = header.length;

    // 2. Build current user message (MUST be preserved)
    const currentUserMsg = this.getCurrentUserMessage(messages);
    const currentMsgBudget = currentUserMsg.length;

    // 3. Calculate remaining budget for history
    // Reserve 500 chars for safety margin and separators
    const historyBudget = Math.max(0, this.maxTextLength - headerBudget - currentMsgBudget - 500);

    // 4. Build history within budget (most recent first)
    const history = this.buildHistoryWithBudget(messages, historyBudget);

    // 5. Assemble: header + history + currentUserMsg
    const parts = [header, history, currentUserMsg].filter(Boolean);
    const message = this.sanitizeText(parts.join('\n\n'));

    return {
      message,
      files: this.fileAttachments,
    };
  }

  /**
   * Legacy transform method for backward compatibility.
   * Returns only the message string.
   * @deprecated Use transform() which returns TransformerResult
   */
  transformMessage(messages: Message[]): string {
    return this.transform(messages).message;
  }

  /**
   * Build the header section (tool instructions).
   * This section MUST always be preserved.
   */
  private buildHeader(): string {
    const parts: string[] = [];

    // Add GPT-specific tool reminder (GPT tends to think it can't use tools)
    if (this.modelProvider === 'azure' || this.modelProvider === 'google') {
      parts.push(GPT_TOOL_REMINDER);
    }

    // Always include MCP tool prompt - this is critical for tool usage
    parts.push(MCP_TOOL_PROMPT);

    return parts.join('\n\n');
  }

  /**
   * Extract and format the current (last) user message.
   */
  private getCurrentUserMessage(messages: Message[]): string {
    // Find last user message
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }

    if (lastUserIdx === -1) return '';

    const content = this.extractTextContent(messages[lastUserIdx].content);
    if (!content || content.startsWith('[SYSTEM]')) return '';

    const userWrapperPrefix = generateUserWrapperPrefix(this.hardLimit);
    return `${userWrapperPrefix}\n[User]: ${content}\n${USER_WRAPPER_SUFFIX}`;
  }

  /**
   * Build conversation history within a character budget.
   * Processes messages from most recent to oldest, stopping when budget is exhausted.
   */
  private buildHistoryWithBudget(messages: Message[], budget: number): string {
    if (budget <= 0 || messages.length <= 1) return '';

    const parts: string[] = [];
    let used = 0;
    let skippedCount = 0;

    // Find last user message index (we'll skip this since it's handled separately)
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }

    // Process messages from most recent to oldest (excluding last user message)
    for (let i = messages.length - 1; i >= 0; i--) {
      // Skip the last user message (handled by getCurrentUserMessage)
      if (i === lastUserIdx) continue;

      const msg = messages[i];
      const formatted = this.formatMessage(msg, false);
      if (!formatted) continue;

      // Check if we have budget for this message
      if (used + formatted.length > budget) {
        skippedCount++;
        continue;
      }

      // Add to front (we're iterating backwards)
      parts.unshift(formatted);
      used += formatted.length;
    }

    // Add skipped indicator if we couldn't fit all messages
    if (skippedCount > 0) {
      parts.unshift(`[...${skippedCount} older messages omitted due to context limit...]`);
    }

    return parts.join('\n\n');
  }

  /**
   * Format a single message for inclusion in the prompt.
   */
  private formatMessage(msg: Message, isLastUserMsg: boolean): string {
    const content = this.extractTextContent(msg.content);
    if (!content) return '';

    // Skip CLI system messages (not relevant to AI)
    if (content.startsWith('[SYSTEM]')) {
      return '';
    }

    switch (msg.role) {
      case 'system':
        return `[System Instructions]: ${content.slice(0, 2000)}`;

      case 'tool':
        return this.formatToolResult(content);

      case 'user':
        if (isLastUserMsg) {
          const userWrapperPrefix = generateUserWrapperPrefix(this.hardLimit);
          return `${userWrapperPrefix}\n[User]: ${content}\n${USER_WRAPPER_SUFFIX}`;
        }
        return `[User]: ${content.slice(0, 1000)}`;

      case 'assistant':
        let truncated = content.slice(0, 1500);
        if (content.length > 1500) {
          truncated += '...';
        }
        return `[Assistant]: ${truncated}`;

      default:
        return `[${msg.role}]: ${content.slice(0, 500)}`;
    }
  }

  /**
   * Format tool result with SHA256 preservation for file.read results.
   * Large file.read results are extracted as file attachments if enabled.
   */
  private formatToolResult(content: string): string {
    // Try to parse as JSON (file.read returns JSON format)
    let parsed: {
      sha256?: string;
      filePath?: string;
      content?: string;
      totalLines?: number;
    } | null = null;

    try {
      parsed = JSON.parse(content);
    } catch {
      // Not JSON - use text patterns
    }

    // Check if this is a file.read result
    const isFileRead = parsed?.sha256 || content.includes('"sha256"');
    const sha256 = parsed?.sha256 ?? content.match(/"sha256":\s*"([a-f0-9]+)"/i)?.[1];
    const filepath = parsed?.filePath ?? content.match(/"filePath":\s*"([^"]+)"/)?.[1];
    const fileContent = parsed?.content ?? content.match(/"content":\s*"([\s\S]*?)"\s*\}/)?.[1];

    // Extract file.read results as attachments if:
    // 1. File attachment extraction is enabled
    // 2. Content is large enough to warrant extraction
    // 3. This is a file.read result with identifiable filepath
    if (
      this.extractFileAttachments &&
      isFileRead &&
      filepath &&
      sha256 &&
      content.length >= this.minFileAttachmentSize
    ) {
      const filename = filepath.split('/').pop() ?? 'file.txt';

      // For file content, unescape JSON string if needed
      let actualContent = fileContent ?? content;
      if (typeof actualContent === 'string' && actualContent.includes('\\n')) {
        actualContent = actualContent.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
      }

      // Create file attachment with pending content for upload
      const fileId = `pending_${++this.fileIdCounter}_${Date.now()}`;
      const attachment: FileAttachment = {
        id: fileId,
        name: filename,
        _pendingContent: actualContent,
        _pendingMimeType: getMimeType(filename),
      };
      this.fileAttachments.push(attachment);

      const totalLines = parsed?.totalLines ?? actualContent.split('\n').length;

      // Return a reference to the attached file (keeps SHA256 for file.applyTextEdits)
      // Make it VERY clear that the full file is attached and available
      return `[Tool Result - file.read SUCCESS]: ${filepath}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SHA256: ${sha256}
Total lines: ${totalLines}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📎 FILE UPLOADED: ${filename} (id: ${fileId})

The COMPLETE file content (${actualContent.length} chars) has been uploaded as an attachment.
You have access to the FULL content - do NOT summarize or say "file is too long".

Use SHA256 above for file.applyTextEdits when modifying this file.`;
    }

    // Small content - include directly
    if (content.length <= this.maxToolOutputLength) {
      return `[Tool Result]: ${content}`;
    }

    // Large content but not extractable as file - this shouldn't happen often
    // If filepath/sha256 parsing failed, still try to attach as generic file
    if (isFileRead) {
      // Try to extract any content we can
      const genericFilename = 'file_content.txt';
      const fileId = `pending_${++this.fileIdCounter}_${Date.now()}`;
      const attachment: FileAttachment = {
        id: fileId,
        name: genericFilename,
        _pendingContent: content,
        _pendingMimeType: 'text/plain',
      };
      this.fileAttachments.push(attachment);

      return `[Tool Result - file.read]: Large file content
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${sha256 ? `SHA256: ${sha256}` : '(SHA256 not parsed)'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📎 FILE UPLOADED: ${genericFilename} (id: ${fileId})

The COMPLETE content (${content.length} chars) has been uploaded as an attachment.
You have access to the FULL content - do NOT summarize or truncate.`;
    }

    // Regular tool output (non-file) - truncate with clear indication
    const truncated = content.slice(0, this.maxToolOutputLength);
    return `[Tool Result]: ${truncated}...\n\n[Note: Output truncated from ${content.length} chars]`;
  }

  /**
   * Sanitize text for API.
   * - Removes control characters
   * - Removes emojis and special Unicode symbols
   * - Keeps ASCII + Korean (Hangul) only
   * - Replaces backticks with safe alternative
   */
  private sanitizeText(text: string): string {
    // Normalize line endings
    let result = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Remove control characters except newline and tab
    result = result.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

    // Remove emojis and special Unicode symbols
    // Covers: Emoticons, Misc Symbols, Dingbats, Transport, Flags, etc.
    result = result.replace(
      /[\u{1F300}-\u{1F9FF}]|[\u{1FA00}-\u{1FAFF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{2300}-\u{23FF}]|[\u{2B50}-\u{2B55}]|[\u{FE00}-\u{FE0F}]|[\u{200D}]|[\u{20E3}]|[\u{1F000}-\u{1F02F}]|[\u{1F0A0}-\u{1F0FF}]/gu,
      ''
    );

    // Remove box drawing and block elements (━, █, etc.) - replace with simple dashes
    result = result.replace(/[\u{2500}-\u{257F}]|[\u{2580}-\u{259F}]/gu, '-');

    // Remove other miscellaneous symbols that aren't standard punctuation
    // Keep: ASCII (0x20-0x7E), Korean (AC00-D7AF, 1100-11FF, 3130-318F), common punctuation
    result = result.replace(
      /[^\x09\x0A\x20-\x7E\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F\u00A0-\u00FF\u2018-\u201F\u2026\u2013-\u2014]/g,
      ''
    );

    // Replace backticks with single quote to avoid A2 API parsing issues
    // ` → ' (simpler and more compatible than Unicode lookalike)
    result = result.replace(/`/g, "'");

    // Clean up multiple consecutive spaces/dashes from removed characters
    result = result.replace(/  +/g, ' ');
    result = result.replace(/--+/g, '--');

    return result;
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
