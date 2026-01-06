/**
 * InputPrompt Component for Popilot CLI
 * Handles user text input
 */

import React, { useState, useCallback } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

const POSTECH_RED = '#c80150';

export interface InputPromptProps {
  onSubmit: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function InputPrompt({ onSubmit, disabled = false, placeholder }: InputPromptProps) {
  const [value, setValue] = useState('');

  const handleSubmit = useCallback((val: string) => {
    if (disabled) return;
    onSubmit(val);
    setValue('');
  }, [onSubmit, disabled]);

  return (
    <Box
      borderStyle="round"
      borderColor={disabled ? 'gray' : POSTECH_RED}
      paddingX={1}
    >
      <Text color={disabled ? 'gray' : POSTECH_RED}>❯ </Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        placeholder={placeholder}
      />
    </Box>
  );
}
