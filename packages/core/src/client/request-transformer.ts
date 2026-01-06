/**
 * Request Transformer for POSTECH GenAI API
 * Transforms OpenAI-style messages to POSTECH API format
 *
 * TypeScript port of continuedev/src/transform/request_transformer.py
 */

import type { Message, ContentPart } from '../types.js';

// Configuration constants
const HARD_LIMIT = 4400;
const MAX_TEXT_LENGTH = 60000;
const MAX_TOOL_OUTPUT_LENGTH = 800;
const KEEP_RECENT_MESSAGES = 6;

// Response constraint prompt
const RESPONSE_CONSTRAINT = `⚠️ CRITICAL OUTPUT LENGTH LIMIT ⚠️
Hard limit: MAX ${HARD_LIMIT} characters (not tokens).

Character counting rules (MUST follow):
- Count characters exactly as they would appear if the whole output is copied into a plain text file.
- Newlines and tabs count as characters too.
- Also count all spaces, punctuation, quotes, backslashes, and any markup characters.

Output format (MUST follow):
1) First line: CHAR_COUNT=<integer>
2) The answer body

If the answer might exceed 2500 characters:
- Switch immediately to COMPRESSED MODE:
  - Max 10 bullet points
  - 1–2 sentences per bullet
  - No long code blocks (at most 20 lines, or summarize in prose)
  - Remove non-essential explanations and examples

Self-check requirement:
- Before sending, verify the final output length ≤ 3500 characters.
- If unsure, shorten further until clearly under the limit.`;

// MCP Tool System Prompt
const MCP_TOOL_PROMPT = `
=== 파일 수정 도구 (MUST USE) ===

중요: 파일 수정 요청 시 반드시 아래 도구를 실행하세요. 설명만 하지 말고 실제로 실행!

■ 필수 워크플로우:
1. run_terminal_command로 파일 찾기
2. file.read로 파일 읽기 + SHA256 획득
3. file.applyTextEdits로 실제 수정 (반드시 실행!)

■ 도구 형식:
[CODE]tool
TOOL_NAME: 도구이름
BEGIN_ARG: 인자명
값
END_ARG
[CODE]

■ run_terminal_command (파일 검색):
[CODE]tool
TOOL_NAME: run_terminal_command
BEGIN_ARG: command
find . -name "*.svelte" | head -20
END_ARG
[CODE]

■ file.read (파일 읽기):
[CODE]tool
TOOL_NAME: file.read
BEGIN_ARG: filepath
src/lib/components/Example.svelte
END_ARG
[CODE]

■ file.applyTextEdits (파일 수정 - 핵심!):
[CODE]tool
TOOL_NAME: file.applyTextEdits
BEGIN_ARG: filepath
src/lib/components/Example.svelte
END_ARG
BEGIN_ARG: expectedSha256
abc123def456...
END_ARG
BEGIN_ARG: edits
[{"startLine": 10, "endLine": 12, "newText": "새로운 코드\\n"}]
END_ARG
[CODE]

■ 규칙:
- expectedSha256: file.read 결과에서 복사
- startLine/endLine: 1부터 시작
- 파일 수정 요청 → file.applyTextEdits 반드시 실행
- 설명만 하지 말고 도구를 실제로 호출할 것!
`;

const USER_WRAPPER_PREFIX = `[${HARD_LIMIT}자 이하, \\n 포함 raw 문자수로 계산, CHAR_COUNT= 필수]`;
const USER_WRAPPER_SUFFIX = `[RAW END - 불필요한 요약 금지]
    When you include code, prefer:
- High-level pseudocode or short fragments only.
- Avoid indentation-heavy output.
- Avoid large JSON / long XML / generated files.
    `;

/**
 * Transforms messages to POSTECH API text format.
 */
export class RequestTransformer {
  /**
   * Combine message history into a single prompt.
   * POSTECH API expects a single text query, so we combine all messages.
   */
  transform(messages: Message[]): string {
    const parts: string[] = [RESPONSE_CONSTRAINT, MCP_TOOL_PROMPT];

    if (messages.length === 1) {
      const content = this.extractTextContent(messages[0].content);
      parts.push(`${USER_WRAPPER_PREFIX}\n[User]: ${content}\n${USER_WRAPPER_SUFFIX}`);
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
    const keepFromIdx = Math.max(0, totalMsgs - KEEP_RECENT_MESSAGES);

    let skippedCount = 0;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const content = this.extractTextContent(msg.content);
      if (!content) continue;

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
        parts.push(`[...${skippedCount}개 이전 메시지 생략...]`);
        skippedCount = 0;
      }

      // Truncate tool outputs heavily
      if (msg.role === 'tool') {
        let truncated = content.slice(0, MAX_TOOL_OUTPUT_LENGTH);
        if (content.length > MAX_TOOL_OUTPUT_LENGTH) {
          truncated += `... (총 ${content.length}자 중 일부만 표시)`;
        }
        parts.push(`[Tool Result]: ${truncated}`);
      } else if (msg.role === 'user') {
        if (i === lastUserIdx) {
          parts.push(`${USER_WRAPPER_PREFIX}\n[User]: ${content}\n${USER_WRAPPER_SUFFIX}`);
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

    return result;
  }

  /**
   * Truncate text from beginning if too long, keeping recent context.
   */
  private truncateIfNeeded(text: string): string {
    if (text.length <= MAX_TEXT_LENGTH) {
      return text;
    }

    let truncated = text.slice(-MAX_TEXT_LENGTH);

    // Find first newline to avoid cutting mid-sentence
    const firstNewline = truncated.indexOf('\n');
    if (firstNewline > 0 && firstNewline < 500) {
      truncated = truncated.slice(firstNewline + 1);
    }

    return `[이전 대화 일부 생략...]\n\n${truncated}`;
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
