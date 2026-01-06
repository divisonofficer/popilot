/**
 * Header Component for Popilot CLI
 * Displays logo, model info, and working directory
 */

import React from 'react';
import { Box, Text } from 'ink';

// POSTECH Brand Colors
const POSTECH_RED = '#c80150';
const POSTECH_YELLOW = '#ffb300';

export interface HeaderProps {
  model: string;
  workingDir: string;
}

// Bird Mascot ASCII Art Lines (matching the pink bird with laptop image)
// Pink bird with yellow beak, wings spread, sitting at laptop
const BIRD_LINES = [
  { text: "    ", accent: "  v  ", rest: "    " },
  { text: " \\", accent: "('v')", rest: "/  " },
  { text: " (", accent: " @ @ ", rest: ")  " },
  { text: "  \\", accent: "\\|/", rest: "/   " },
  { text: "   ", accent: "|=|", rest: "    " },
  { text: "  ", accent: "[___]", rest: "   " },
];

// Logo text lines
const LOGO_LINES = [
  "  ___          _ _       _   ",
  " | _ \\___  _ __(_) |___| |_ ",
  " |  _/ _ \\| '_ \\ | / _ \\  _|",
  " |_| \\___/| .__/_|_\\___/\\__|",
  "          |_|               ",
];

export function Header({ model, workingDir }: HeaderProps) {
  return (
    <Box flexDirection="column">
      {/* Bird Mascot with Logo */}
      <Box flexDirection="row">
        {/* Bird ASCII Art */}
        <Box flexDirection="column" marginRight={1}>
          {BIRD_LINES.map((line, i) => (
            <Box key={i}>
              <Text color={POSTECH_RED}>{line.text}</Text>
              <Text color={POSTECH_YELLOW}>{line.accent}</Text>
              <Text color={POSTECH_RED}>{line.rest}</Text>
            </Box>
          ))}
        </Box>

        {/* Logo Text */}
        <Box flexDirection="column">
          {LOGO_LINES.map((line, i) => (
            <Text key={i} color={POSTECH_RED} bold>{line}</Text>
          ))}
          <Text color="gray">  POSTECH AI Coding Assistant</Text>
          <Text color="gray" dimColor>  by Divisonofficer</Text>
        </Box>
      </Box>

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
