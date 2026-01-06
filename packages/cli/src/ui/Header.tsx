/**
 * Header Component for Popilot CLI
 * Displays logo, model info, and working directory
 */

import React from 'react';
import { Box, Text } from 'ink';

// POSTECH Brand Colors
const POSTECH_RED = '#c80150';
const POSTECH_YELLOW = '#ffb300';

// ASCII Art Logo
const LOGO = `╔═══════════════════════════════════════════╗
║   ____             _ _       _            ║
║  |  _ \\ ___  _ __ (_) | ___ | |_          ║
║  | |_) / _ \\| '_ \\| | |/ _ \\| __|         ║
║  |  __/ (_) | |_) | | | (_) | |_          ║
║  |_|   \\___/| .__/|_|_|\\___/ \\__|         ║
║             |_|                           ║
║                                           ║
║    POSTECH AI Coding Assistant            ║
╚═══════════════════════════════════════════╝`;

export interface HeaderProps {
  model: string;
  workingDir: string;
}

export function Header({ model, workingDir }: HeaderProps) {
  return (
    <Box flexDirection="column">
      <Text color={POSTECH_RED}>{LOGO}</Text>
      <Box marginTop={1}>
        <Text color={POSTECH_YELLOW}>Model: </Text>
        <Text color="white" bold>{model}</Text>
        <Text color="gray"> | </Text>
        <Text color={POSTECH_YELLOW}>Dir: </Text>
        <Text color="cyan">{workingDir}</Text>
      </Box>
    </Box>
  );
}
