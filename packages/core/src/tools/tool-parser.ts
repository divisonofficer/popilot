/**
 * Tool Parser for Popilot
 * Parses tool blocks from model responses
 *
 * TypeScript port of continuedev/src/transform/tool_call_filter.py (ToolCallFilter)
 */

import type { ToolCall } from '../types.js';

export interface ParsedToolBlock {
  toolName: string;
  args: Record<string, unknown>;
  rawBlock: string;
}

/**
 * Buffers tool blocks until complete and parses them.
 * Uses aggressive pattern matching to handle malformed/corrupted tool blocks.
 */
export class ToolParser {
  // Patterns to detect tool block start/end
  private static readonly TOOL_START_PATTERNS = [
    /```tool/,
    /\[CODE\]tool/,
    /CODEBLOCK\s*tool/,
    /TOOL_NAME:\s*\w+/,
  ];

  private static readonly TOOL_END_PATTERNS = [
    /```/,
    /\[CODE\]/,
    /CODEBLOCK/,
  ];

  // Pattern to extract tool name and arguments - more flexible
  private static readonly TOOL_NAME_PATTERN = /TOOL_NAME:\s*(\S+)/;
  private static readonly ARG_PATTERN = /BEGIN_ARG:\s*(\S+)\s*\n?([\s\S]*?)END_ARG/g;

  // Direct extraction pattern for complete tool calls (handles corrupted streams)
  private static readonly DIRECT_TOOL_PATTERN = /TOOL_NAME:\s*(\S+)(?:\s*\n|\s+)((?:BEGIN_ARG:\s*\S+\s*\n?[\s\S]*?END_ARG\s*)*)/g;

  private buffer = '';
  private inToolBlock = false;
  private toolBlockStartPos = 0;

  private static readonly MAX_BUFFER_SIZE = 100000;

  /**
   * Process a content chunk.
   *
   * Returns object with:
   * - output: Content to display (may be empty if buffering)
   * - isBuffering: True if currently buffering a tool block
   * - toolBlock: Completed tool block if one was found
   */
  processChunk(content: string): {
    output: string;
    isBuffering: boolean;
    toolBlock: ParsedToolBlock | null;
  } {
    if (!content) {
      return { output: '', isBuffering: false, toolBlock: null };
    }

    this.buffer += content;

    if (this.inToolBlock) {
      return this.checkToolBlockEnd();
    } else {
      return this.checkToolBlockStart();
    }
  }

  /**
   * Check if a tool block is starting.
   */
  private checkToolBlockStart(): {
    output: string;
    isBuffering: boolean;
    toolBlock: null;
  } {
    for (const pattern of ToolParser.TOOL_START_PATTERNS) {
      const match = pattern.exec(this.buffer);
      if (match) {
        // Tool block starting
        this.inToolBlock = true;
        this.toolBlockStartPos = match.index;

        // Output everything before the tool block
        const output = this.buffer.slice(0, this.toolBlockStartPos);
        this.buffer = this.buffer.slice(this.toolBlockStartPos);

        return { output, isBuffering: true, toolBlock: null };
      }
    }

    // No tool block starting, but keep last 20 chars in case pattern spans chunks
    if (this.buffer.length > 20) {
      const output = this.buffer.slice(0, -20);
      this.buffer = this.buffer.slice(-20);
      return { output, isBuffering: false, toolBlock: null };
    }

    return { output: '', isBuffering: false, toolBlock: null };
  }

  /**
   * Check if the current tool block is ending.
   */
  private checkToolBlockEnd(): {
    output: string;
    isBuffering: boolean;
    toolBlock: ParsedToolBlock | null;
  } {
    // Check if buffer is too large
    if (this.buffer.length > ToolParser.MAX_BUFFER_SIZE) {
      const output = this.buffer;
      this.buffer = '';
      this.inToolBlock = false;
      return { output, isBuffering: false, toolBlock: null };
    }

    let closePos: number | null = null;

    // Pattern 1: END_ARG followed by closing fence (tool with arguments)
    const endPattern1 = /END_ARG\s*\n?(```|\[CODE\]|CODEBLOCK)/;
    const match1 = endPattern1.exec(this.buffer);

    // Pattern 2: END_ARG at end of content or followed by newline + non-tool text
    const endPattern2 = /END_ARG\s*(\n\n|\n[^B]|$)/;
    const match2 = !match1 ? endPattern2.exec(this.buffer) : null;

    // Pattern 3: TOOL_NAME followed by closing fence WITHOUT arguments
    // e.g., [CODE]tool\nTOOL_NAME: list_directory\n[CODE]
    const endPattern3 = /TOOL_NAME:\s*\S+\s*\n(```|\[CODE\]|CODEBLOCK)/;
    const match3 = !match1 && !match2 ? endPattern3.exec(this.buffer) : null;

    // Pattern 4: TOOL_NAME at end or followed by double newline (no args, no fence)
    const endPattern4 = /TOOL_NAME:\s*\S+\s*(\n\n|$)/;
    const match4 = !match1 && !match2 && !match3 ? endPattern4.exec(this.buffer) : null;

    if (match1) {
      closePos = match1.index + match1[0].length;
    } else if (match2) {
      closePos = match2.index + 'END_ARG'.length;
      if (closePos < this.buffer.length && this.buffer[closePos] === '\n') {
        closePos += 1;
      }
    } else if (match3) {
      closePos = match3.index + match3[0].length;
    } else if (match4) {
      // Find end of TOOL_NAME line
      const toolNameMatch = /TOOL_NAME:\s*\S+/.exec(this.buffer);
      if (toolNameMatch) {
        closePos = toolNameMatch.index + toolNameMatch[0].length;
        // Include trailing newline if present
        if (closePos < this.buffer.length && this.buffer[closePos] === '\n') {
          closePos += 1;
        }
      }
    }

    if (closePos === null) {
      // Still waiting for tool block to complete
      return { output: '', isBuffering: true, toolBlock: null };
    }

    const completeBlock = this.buffer.slice(0, closePos);
    this.buffer = this.buffer.slice(closePos);
    this.inToolBlock = false;

    // Parse the tool block
    const toolBlock = this.parseToolBlock(completeBlock);

    return { output: '', isBuffering: false, toolBlock };
  }

  /**
   * Parse tool name and arguments from a tool block.
   */
  private parseToolBlock(block: string): ParsedToolBlock | null {
    // Extract tool name
    const nameMatch = ToolParser.TOOL_NAME_PATTERN.exec(block);
    if (!nameMatch) {
      return null;
    }

    const toolName = nameMatch[1];

    // Extract arguments
    const args: Record<string, unknown> = {};
    let argMatch: RegExpExecArray | null;

    // Reset lastIndex for global regex
    const argPattern = new RegExp(ToolParser.ARG_PATTERN.source, 'g');

    while ((argMatch = argPattern.exec(block)) !== null) {
      const argName = argMatch[1];
      let argValue: unknown = argMatch[2].trim();

      // Try to parse JSON for complex args (like edits)
      if (argName === 'edits') {
        try {
          argValue = JSON.parse(argValue as string);
        } catch {
          // Keep as string
        }
      }

      args[argName] = argValue;
    }

    return {
      toolName,
      args,
      rawBlock: block,
    };
  }

  /**
   * Convert parsed tool block to ToolCall.
   */
  static toToolCall(parsed: ParsedToolBlock, id?: string): ToolCall {
    return {
      id: id ?? crypto.randomUUID(),
      name: parsed.toolName,
      args: parsed.args,
    };
  }

  /**
   * Flush any remaining buffered content.
   */
  flush(): string {
    const output = this.buffer;
    this.buffer = '';
    this.inToolBlock = false;
    return output;
  }

  /**
   * Check if currently buffering a tool block.
   */
  get isBuffering(): boolean {
    return this.inToolBlock;
  }

  /**
   * Normalize tool block markers to standard format.
   */
  static normalizeBlock(block: string): string {
    return block
      .replace(/^CODEBLOCK\s*tool/, '```tool')
      .replace(/CODEBLOCK\s*$/, '```')
      .replace(/^\[CODE\]tool/, '```tool')
      .replace(/\[CODE\]\s*$/, '```');
  }

  /**
   * Extract ALL tool calls from accumulated text (post-hoc parsing).
   * This is more robust than streaming detection for corrupted output.
   */
  static extractAllToolCalls(text: string): ParsedToolBlock[] {
    const results: ParsedToolBlock[] = [];

    // Pattern to find TOOL_NAME declarations
    const toolNamePattern = /TOOL_NAME:\s*(\S+)/g;
    let match: RegExpExecArray | null;

    while ((match = toolNamePattern.exec(text)) !== null) {
      const toolName = match[1];
      const startIdx = match.index;

      // Find the end of this tool block (next TOOL_NAME or end of relevant section)
      const nextToolMatch = /TOOL_NAME:\s*\S+/.exec(text.slice(startIdx + match[0].length));
      const endIdx = nextToolMatch
        ? startIdx + match[0].length + nextToolMatch.index
        : text.length;

      const blockText = text.slice(startIdx, endIdx);

      // Extract arguments from this block
      const args: Record<string, unknown> = {};
      const argPattern = /BEGIN_ARG:\s*(\S+)\s*\n?([\s\S]*?)END_ARG/g;
      let argMatch: RegExpExecArray | null;

      while ((argMatch = argPattern.exec(blockText)) !== null) {
        const argName = argMatch[1];
        let argValue: unknown = argMatch[2].trim();

        // Try to parse JSON for complex args
        if (argName === 'edits') {
          try {
            argValue = JSON.parse(argValue as string);
          } catch {
            // Keep as string
          }
        }

        args[argName] = argValue;
      }

      results.push({
        toolName,
        args,
        rawBlock: blockText,
      });
    }

    return results;
  }

  /**
   * Remove all tool block content from text, leaving only regular output.
   */
  static removeToolBlocks(text: string): string {
    let result = text;

    // Remove fence-wrapped tool blocks
    result = result.replace(/(\[CODE\]tool|```tool|CODEBLOCK\s*tool)[\s\S]*?(\[CODE\]|```|CODEBLOCK)/g, '');

    // Remove standalone tool declarations and arguments
    result = result.replace(/TOOL_NAME:\s*\S+[\s\S]*?(?=TOOL_NAME:|$)/g, (match) => {
      // Keep text after END_ARG that's not part of tool block
      const lastEndArg = match.lastIndexOf('END_ARG');
      if (lastEndArg !== -1) {
        const afterEndArg = match.slice(lastEndArg + 7);
        // Check if there's meaningful text after (not just [CODE] or whitespace)
        const cleanAfter = afterEndArg.replace(/\[CODE\]|```|CODEBLOCK/g, '').trim();
        if (cleanAfter && !cleanAfter.startsWith('BEGIN_ARG')) {
          return cleanAfter;
        }
      }
      return '';
    });

    // Clean up remaining markers
    result = result
      .replace(/\[CODE\]tool\s*/g, '')
      .replace(/```tool\s*/g, '')
      .replace(/CODEBLOCK\s*tool\s*/g, '')
      .replace(/\[CODE\]\s*/g, '')
      .replace(/```\s*/g, '')
      .replace(/CODEBLOCK\s*/g, '')
      .replace(/BEGIN_ARG:\s*\S+\s*/g, '')
      .replace(/END_ARG\s*/g, '')
      .replace(/TOOL_NAME:\s*\S+\s*/g, '');

    // Clean up excessive whitespace
    result = result.replace(/\n{3,}/g, '\n\n').trim();

    return result;
  }
}
