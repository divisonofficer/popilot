/**
 * ToolConfirmation Component for Popilot CLI
 * Asks user to confirm tool execution
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

const POSTECH_RED = '#c80150';
const POSTECH_YELLOW = '#ffb300';

export interface ToolConfirmationProps {
  toolName: string;
  args: Record<string, unknown>;
  onConfirm: (confirmed: boolean) => void;
}

export function ToolConfirmation({ toolName, args, onConfirm }: ToolConfirmationProps) {
  const [selected, setSelected] = useState<'yes' | 'no'>('yes');

  useInput((input, key) => {
    if (key.leftArrow || key.rightArrow || input === 'h' || input === 'l') {
      setSelected((prev) => (prev === 'yes' ? 'no' : 'yes'));
    } else if (key.return) {
      onConfirm(selected === 'yes');
    } else if (input === 'y' || input === 'Y') {
      onConfirm(true);
    } else if (input === 'n' || input === 'N' || key.escape || key.backspace || key.delete) {
      onConfirm(false);
    }
  });

  // Format args for display
  const argsDisplay = Object.entries(args)
    .map(([key, value]) => {
      const valStr = typeof value === 'string'
        ? value.length > 50 ? value.slice(0, 50) + '...' : value
        : JSON.stringify(value).slice(0, 50);
      return `  ${key}: ${valStr}`;
    })
    .join('\n');

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={POSTECH_YELLOW}
      paddingX={2}
      paddingY={1}
      marginY={1}
    >
      <Text color={POSTECH_YELLOW} bold>⚠️  도구 실행 확인</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text color="white" bold>{toolName}</Text>을 실행하시겠습니까?
        </Text>
        <Box marginTop={1}>
          <Text color="gray">{argsDisplay}</Text>
        </Box>
      </Box>

      <Box marginTop={2} justifyContent="center">
        <Box marginRight={2}>
          <Text
            color={selected === 'yes' ? 'green' : 'gray'}
            bold={selected === 'yes'}
            inverse={selected === 'yes'}
          >
            {'  [Y] 예  '}
          </Text>
        </Box>
        <Box>
          <Text
            color={selected === 'no' ? 'red' : 'gray'}
            bold={selected === 'no'}
            inverse={selected === 'no'}
          >
            {'  [N] 아니오  '}
          </Text>
        </Box>
      </Box>

      <Box marginTop={1} justifyContent="center">
        <Text color="gray" dimColor>
          Y/Enter=실행 | N/Esc=취소 | ←→ 선택
        </Text>
      </Box>
    </Box>
  );
}
