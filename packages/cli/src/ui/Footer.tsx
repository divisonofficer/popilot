/**
 * Footer Component for Popilot CLI
 * Shows status and keyboard shortcuts
 */

import React from 'react';
import { Box, Text } from 'ink';

const POSTECH_YELLOW = '#ffb300';

export interface FooterProps {
  state: 'idle' | 'streaming' | 'confirming' | 'authenticating';
  model: string;
}

export function Footer({ state, model }: FooterProps) {
  const getStatusText = () => {
    switch (state) {
      case 'streaming':
        return '응답 생성 중... (Ctrl+C: 취소)';
      case 'confirming':
        return '도구 실행 확인 대기 중...';
      case 'authenticating':
        return '인증 중...';
      default:
        return 'Ready';
    }
  };

  return (
    <Box marginTop={1} justifyContent="space-between">
      <Box>
        <Text color="gray">Status: </Text>
        <Text color={state === 'idle' ? 'green' : POSTECH_YELLOW}>
          {getStatusText()}
        </Text>
      </Box>
      <Box>
        <Text color="gray">
          Ctrl+C: {state === 'streaming' ? '취소' : '종료'} | /help: 도움말
        </Text>
      </Box>
    </Box>
  );
}
