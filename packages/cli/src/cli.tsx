#!/usr/bin/env node
/**
 * Popilot CLI Entry Point
 * POSTECH GenAI Coding Assistant
 */

import React from 'react';
import { render } from 'ink';
import { Command } from 'commander';
import { App } from './App.js';
import { DEFAULT_CONFIG, AVAILABLE_MODELS } from '@popilot/core';

const program = new Command();

program
  .name('popilot')
  .description('POSTECH AI Coding Assistant CLI')
  .version('0.1.0')
  .option('-m, --model <model>', 'Model to use (claude-sonnet-4-5, gpt-5.1, gemini-3-pro)', 'claude-sonnet-4-5')
  .option('-d, --dir <directory>', 'Working directory', process.cwd())
  .option('--no-color', 'Disable colored output')
  // Prompt debugging options
  .option('--hard-limit <number>', 'Max characters for AI response (default: 4400)', parseInt)
  .option('--max-text-length <number>', 'Max total text length for request (default: 60000)', parseInt)
  .option('--max-tool-output <number>', 'Max characters for tool output (default: 800)', parseInt)
  .option('--keep-recent <number>', 'Number of recent messages to keep (default: 6)', parseInt)
  .action((options) => {
    // Validate model
    if (!AVAILABLE_MODELS[options.model]) {
      console.error(`Invalid model: ${options.model}`);
      console.error(`Available models: ${Object.keys(AVAILABLE_MODELS).join(', ')}`);
      process.exit(1);
    }

    // Build transformer config from CLI options
    const transformerConfig = {
      hardLimit: options.hardLimit,
      maxTextLength: options.maxTextLength,
      maxToolOutputLength: options.maxToolOutput,
      keepRecentMessages: options.keepRecent,
    };

    // Log config if any debugging options are set
    if (options.hardLimit || options.maxTextLength || options.maxToolOutput || options.keepRecent) {
      console.log('Transformer config:', JSON.stringify(transformerConfig, null, 2));
    }

    // Render the app
    const { waitUntilExit } = render(
      <App
        model={options.model}
        workingDir={options.dir}
        transformerConfig={transformerConfig}
      />,
      {
        exitOnCtrlC: false,
      }
    );

    waitUntilExit().then(() => {
      process.exit(0);
    });
  });

program.parse();
