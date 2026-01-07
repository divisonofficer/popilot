/**
 * InputPrompt Component for Popilot CLI
 * Handles user text input with tab completion
 */

import React, { useState, useCallback, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';

const POSTECH_RED = '#c80150';

// Slash commands for tab completion
const SLASH_COMMANDS = [
  '/model',
  '/clear',
  '/thread',
  '/retry',
  '/config',
  '/autoconfirm',
  '/auto',
  '/session',
  '/api',
  '/sso',
  '/auth',
  '/logout',
  '/quit',
  '/help',
  '/gpt',
  '/claude',
  '/gemini',
] as const;

// Autoconfirm tool patterns for tab completion
const AUTOCONFIRM_TOOLS = [
  'file.applyTextEdits',
  'run_terminal_command',
  'create_new_file',
  'edit_file',
  'file.*',
  'all',
  'reset',
] as const;

export interface InputPromptProps {
  onSubmit: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function InputPrompt({ onSubmit, disabled = false, placeholder }: InputPromptProps) {
  const [value, setValue] = useState('');
  const [completionIndex, setCompletionIndex] = useState(0);

  // Get completion candidates based on current input
  const completionCandidates = useMemo(() => {
    const trimmed = value.trimStart();

    // Autoconfirm tool completion: /autoconfirm <tool> or /auto <tool>
    const autoconfirmMatch = trimmed.match(/^\/(autoconfirm|auto)\s+(\S*)$/i);
    if (autoconfirmMatch) {
      const prefix = autoconfirmMatch[2].toLowerCase();
      return AUTOCONFIRM_TOOLS
        .filter(tool => tool.toLowerCase().startsWith(prefix))
        .map(tool => `/${autoconfirmMatch[1]} ${tool}`);
    }

    // Slash command completion
    if (trimmed.startsWith('/')) {
      const prefix = trimmed.toLowerCase();
      return SLASH_COMMANDS.filter(cmd => cmd.startsWith(prefix));
    }

    return [];
  }, [value]);

  const handleSubmit = useCallback((val: string) => {
    if (disabled) return;
    onSubmit(val);
    setValue('');
    setCompletionIndex(0);
  }, [onSubmit, disabled]);

  // Handle tab key for completion
  useInput((input, key) => {
    if (disabled) return;

    if (key.tab && completionCandidates.length > 0) {
      // Cycle through candidates with repeated tab presses
      const candidate = completionCandidates[completionIndex % completionCandidates.length];
      setValue(candidate + ' ');
      setCompletionIndex((prev) => (prev + 1) % completionCandidates.length);
    }
  });

  // Reset completion index when value changes manually
  const handleChange = useCallback((newValue: string) => {
    setValue(newValue);
    setCompletionIndex(0);
  }, []);

  return (
    <Box flexDirection="column">
      {/* Show completion hint if available */}
      {completionCandidates.length > 0 && value.length > 0 && (
        <Box paddingLeft={3} marginBottom={0}>
          <Text dimColor>
            Tab: {completionCandidates.slice(0, 5).join(', ')}
            {completionCandidates.length > 5 ? ` (+${completionCandidates.length - 5})` : ''}
          </Text>
        </Box>
      )}
      <Box
        borderStyle="round"
        borderColor={disabled ? 'gray' : POSTECH_RED}
        paddingX={1}
      >
        <Text color={disabled ? 'gray' : POSTECH_RED}>❯ </Text>
        <TextInput
          value={value}
          onChange={handleChange}
          onSubmit={handleSubmit}
          placeholder={placeholder}
        />
      </Box>
    </Box>
  );
}
