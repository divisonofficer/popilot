/**
 * ChatView Component for Popilot CLI
 * Displays conversation history and streaming response
 */

import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { Message } from '@popilot/core';

// 최대 표시 줄 수 - 스크롤 점프 방지
const MAX_VISIBLE_LINES = 40;
const MAX_MESSAGE_LINES = 25;

export interface ChatViewProps {
  messages: Message[];
  currentResponse: string;
  isStreaming: boolean;
}

/**
 * 긴 텍스트를 마지막 N줄만 표시하도록 truncate
 * 스크롤 점프 문제 해결을 위해 사용
 */
function truncateText(text: string, maxLines: number): { text: string; truncated: boolean; hiddenLines: number } {
  const lines = text.split('\n');
  if (lines.length <= maxLines) {
    return { text, truncated: false, hiddenLines: 0 };
  }
  const hiddenLines = lines.length - maxLines;
  const visible = lines.slice(-maxLines);
  return {
    text: visible.join('\n'),
    truncated: true,
    hiddenLines,
  };
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user';
  const rawContent = typeof message.content === 'string'
    ? message.content
    : JSON.stringify(message.content);

  // 메시지가 너무 길면 truncate (스크롤 점프 방지)
  const { text: content, truncated, hiddenLines } = truncateText(rawContent, MAX_MESSAGE_LINES);

  return (
    <Box
      flexDirection="column"
      marginY={1}
      paddingX={1}
      borderStyle="round"
      borderColor={isUser ? 'blue' : 'green'}
    >
      <Text color={isUser ? 'blue' : 'green'} bold>
        {isUser ? '👤 You' : '🐦 Popilot'}
      </Text>
      {truncated && (
        <Text dimColor>... ({hiddenLines} lines hidden)</Text>
      )}
      <Box marginTop={1}>
        <Text wrap="wrap">{content}</Text>
      </Box>
    </Box>
  );
}

export function ChatView({ messages, currentResponse, isStreaming }: ChatViewProps) {
  return (
    <Box flexDirection="column">
      {messages.map((msg, idx) => (
        <MessageBubble key={idx} message={msg} />
      ))}

      {(isStreaming || currentResponse) && (() => {
        // 스트리밍 응답도 truncate (스크롤 점프 방지)
        const { text: displayResponse, truncated, hiddenLines } = truncateText(
          currentResponse,
          MAX_VISIBLE_LINES
        );

        return (
          <Box
            flexDirection="column"
            marginY={1}
            paddingX={1}
            borderStyle="round"
            borderColor="yellow"
          >
            <Box>
              {isStreaming && <Spinner type="dots" />}
              <Text color="yellow" bold>
                {' '}🐦 Popilot {isStreaming ? '(typing...)' : ''}
              </Text>
            </Box>
            {truncated && (
              <Text dimColor>... ({hiddenLines} lines hidden, showing last {MAX_VISIBLE_LINES})</Text>
            )}
            {displayResponse && (
              <Box marginTop={1}>
                <Text wrap="wrap">{displayResponse}</Text>
              </Box>
            )}
          </Box>
        );
      })()}

      {messages.length === 0 && !isStreaming && (
        <Box marginY={2} justifyContent="center">
          <Text color="gray">
            대화를 시작하세요. /help로 명령어 확인 가능합니다.
          </Text>
        </Box>
      )}
    </Box>
  );
}
