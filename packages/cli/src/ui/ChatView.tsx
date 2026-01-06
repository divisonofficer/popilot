/**
 * ChatView Component for Popilot CLI
 * Displays conversation history and streaming response
 */

import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { Message } from '@popilot/core';

export interface ChatViewProps {
  messages: Message[];
  currentResponse: string;
  isStreaming: boolean;
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user';
  const content = typeof message.content === 'string'
    ? message.content
    : JSON.stringify(message.content);

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

      {(isStreaming || currentResponse) && (
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
          {currentResponse && (
            <Box marginTop={1}>
              <Text wrap="wrap">{currentResponse}</Text>
            </Box>
          )}
        </Box>
      )}

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
