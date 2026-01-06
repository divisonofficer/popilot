/**
 * API Key Authenticator for Popilot
 * Handles API key acquisition from env, storage, or user input
 */

import * as readline from 'node:readline';
import { ApiKeyStorage } from './apikey-storage.js';

export interface ApiKeyAuthenticatorConfig {
  storage: ApiKeyStorage;
  envVarName?: string;
}

export class ApiKeyAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiKeyAuthenticationError';
  }
}

/**
 * API key authenticator for POSTECH GenAI.
 * Tries to get API key from: env var → storage → user input
 */
export class ApiKeyAuthenticator {
  private storage: ApiKeyStorage;
  private envVarName: string;

  constructor(config: ApiKeyAuthenticatorConfig) {
    this.storage = config.storage;
    this.envVarName = config.envVarName ?? 'POPILOT_API_KEY';
  }

  /**
   * Get API key from available sources.
   * Priority: env var → stored key → user input
   */
  async getApiKey(): Promise<string> {
    // 1. Check environment variable
    const envKey = process.env[this.envVarName];
    if (envKey) {
      console.log(`Using API key from ${this.envVarName} environment variable`);
      return envKey;
    }

    // 2. Check stored key
    const storedKey = this.storage.loadApiKey();
    if (storedKey) {
      console.log('Using stored API key');
      return storedKey;
    }

    // 3. Prompt user for input
    console.log('\n' + '='.repeat(60));
    console.log('API KEY REQUIRED');
    console.log('='.repeat(60));
    console.log('\nNo API key found. Please enter your POSTECH GenAI API key.');
    console.log('The key will be encrypted and saved for future use.');
    console.log(`\nTip: You can also set the ${this.envVarName} environment variable.`);
    console.log('='.repeat(60) + '\n');

    const inputKey = await this.promptForApiKey();

    if (!inputKey) {
      throw new ApiKeyAuthenticationError('No API key provided');
    }

    // Save for future use
    this.storage.saveApiKey(inputKey);
    console.log('\nAPI key saved successfully.');

    return inputKey;
  }

  /**
   * Check if API key is available (without prompting).
   */
  hasApiKey(): boolean {
    const envKey = process.env[this.envVarName];
    if (envKey) return true;

    return this.storage.hasApiKey();
  }

  /**
   * Get API key source description.
   */
  getKeySource(): 'env' | 'stored' | 'none' {
    if (process.env[this.envVarName]) return 'env';
    if (this.storage.hasApiKey()) return 'stored';
    return 'none';
  }

  /**
   * Clear stored API key.
   */
  clearApiKey(): void {
    this.storage.clearApiKey();
  }

  /**
   * Save API key to storage.
   */
  saveApiKey(apiKey: string): void {
    this.storage.saveApiKey(apiKey);
  }

  /**
   * Read user input from stdin using readline.
   */
  private promptForApiKey(): Promise<string> {
    return new Promise((resolve) => {
      // Save current raw mode state and switch to line mode for readline
      const wasRaw = process.stdin.isRaw;
      if (wasRaw) {
        process.stdin.setRawMode(false);
      }

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
      });

      rl.question('Enter API key: ', (answer) => {
        rl.close();

        // Restore raw mode if it was enabled
        if (wasRaw && process.stdin.isTTY) {
          process.stdin.setRawMode(true);
        }

        resolve(answer.trim());
      });
    });
  }
}
