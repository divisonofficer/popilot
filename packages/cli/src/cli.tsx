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
  .action((options) => {
    // Validate model
    if (!AVAILABLE_MODELS[options.model]) {
      console.error(`Invalid model: ${options.model}`);
      console.error(`Available models: ${Object.keys(AVAILABLE_MODELS).join(', ')}`);
      process.exit(1);
    }

    // Render the app
    const { waitUntilExit } = render(
      <App
        model={options.model}
        workingDir={options.dir}
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
