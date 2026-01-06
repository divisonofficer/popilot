/**
 * Footer Component for Popilot CLI
 * Shows status and keyboard shortcuts
 */

import React from 'react';
import { Box, Text } from 'ink';

const POSTECH_YELLOW = '#ffb300';

export interface FooterProps {
  state: 'idle' | 'streaming' | 'confirming' | 'authenticating' | 'executing_tool';
  model: string;
  isAuthenticated?: boolean;
  initializingChat?: boolean;
  currentTool?: string;
  threadId?: number;
}

export function Footer({ state, model, isAuthenticated = true, initializingChat = false, currentTool, threadId }: FooterProps) {
  const getStatusText = () => {
    if (initializingChat) {
      return '채팅방 초기화 중...';
    }
    switch (state) {
      case 'streaming':
        return '응답 생성 중... (Ctrl+C: 취소)';
      case 'confirming':
        return '도구 실행 확인 대기 중...';
      case 'authenticating':
        return '인증 중...';
      case 'executing_tool':
        return `🔧 도구 실행 중: ${currentTool || 'unknown'}...`;
      default:
        return isAuthenticated ? 'Ready' : 'Login Required';
    }
  };

  const getStatusColor = () => {
    if (initializingChat || state !== 'idle') return POSTECH_YELLOW;
    return isAuthenticated ? 'green' : 'red';
  };

  // Get short model name for display
  const getShortModelName = () => {
    const modelMap: Record<string, string> = {
      'claude-sonnet-4-5': 'Claude',
      'gpt-5.1': 'GPT',
      'gemini-3-pro': 'Gemini',
    };
    return modelMap[model] || model;
  };

  return (
    <Box marginTop={1} justifyContent="space-between">
      <Box>
        <Text color="gray">Status: </Text>
        <Text color={getStatusColor()}>
          {getStatusText()}
        </Text>
        <Text color="gray"> | Model: </Text>
        <Text color={POSTECH_YELLOW}>{getShortModelName()}</Text>
        {threadId && (
          <>
            <Text color="gray"> | Thread: </Text>
            <Text color="cyan">#{threadId}</Text>
          </>
        )}
      </Box>
      <Box>
        <Text color="gray">
          Ctrl+C: {state === 'streaming' ? '취소' : '종료'} | /help: 도움말
        </Text>
      </Box>
    </Box>
  );
}
