/**
 * SSO Authenticator for POSTECH GenAI
 * Uses Puppeteer to monitor browser and automatically capture callback URL
 *
 * TypeScript port of continuedev/src/auth/sso_authenticator.py
 */

import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { URL, URLSearchParams } from 'node:url';
import open from 'open';

// Puppeteer is optional - dynamically imported
type PuppeteerBrowser = import('puppeteer').Browser;
type PuppeteerPage = import('puppeteer').Page;

export interface AuthTokens {
  accessToken: string;
  refreshToken?: string;
}

export interface SSOAuthenticatorConfig {
  ssoUrl: string;
  callbackPattern: string;
  timeoutSeconds?: number;
  manualMode?: boolean;
}

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

/**
 * Check if running in WSL environment.
 */
function isWSL(): boolean {
  if (process.platform !== 'linux') return false;

  try {
    const version = fs.readFileSync('/proc/version', 'utf8');
    return version.toLowerCase().includes('microsoft');
  } catch {
    return false;
  }
}

/**
 * SSO authenticator for POSTECH GenAI.
 */
export class SSOAuthenticator {
  private ssoUrl: string;
  private callbackPattern: string;
  private timeoutSeconds: number;
  private manualMode: boolean;

  constructor(config: SSOAuthenticatorConfig) {
    this.ssoUrl = config.ssoUrl;
    this.callbackPattern = config.callbackPattern;
    this.timeoutSeconds = config.timeoutSeconds ?? 300;
    this.manualMode = config.manualMode ?? true;
  }

  /**
   * Authenticate via SSO.
   */
  async authenticate(): Promise<AuthTokens> {
    // if (this.manualMode || isWSL()) {
    //   return this.authenticateManual();
    // }
    return this.authenticateWithCallback();
  }

  /**
   * Manual authentication - user copies token from browser.
   */
  private async authenticateManual(): Promise<AuthTokens> {
    console.log('\n' + '='.repeat(60));
    console.log('SSO AUTHENTICATION REQUIRED');
    console.log('='.repeat(60));
    console.log(`\n1. Opening browser to: ${this.ssoUrl}`);
    console.log('2. Please login with your POSTECH account');
    console.log('3. After login, you will be redirected to a URL like:');
    console.log('   https://genai.postech.ac.kr/auth/callback#access_token=...');
    console.log('4. Copy the ENTIRE URL from the address bar');
    console.log('\n[Alternative] You can also paste just the JWT token directly');
    console.log("   (starts with 'eyJ...')");
    console.log('='.repeat(60) + '\n');

    // Try to open browser
    try {
      await open(this.ssoUrl);
    } catch (error) {
      console.log(`Could not open browser automatically: ${error}`);
      console.log(`Please open this URL manually: ${this.ssoUrl}`);
    }

    // Wait for user to paste the callback URL or token
    console.log('\nPaste the callback URL or JWT token here:');
    const userInput = await this.readUserInput();

    if (!userInput) {
      throw new AuthenticationError('No input provided');
    }

    // Parse the input
    const tokens = this.parseAuthInput(userInput);

    if (!tokens.accessToken) {
      throw new AuthenticationError('Could not extract access_token from input');
    }

    console.log('\n' + '='.repeat(60));
    console.log('SSO LOGIN SUCCESSFUL!');
    console.log(`Token length: ${tokens.accessToken.length} chars`);
    console.log('='.repeat(60) + '\n');

    return tokens;
  }

  /**
   * Parse authentication input (URL, fragment, or raw token).
   */
  private parseAuthInput(input: string): AuthTokens {
    const trimmed = input.trim();

    // Check if input is a JWT token directly (starts with eyJ)
    if (trimmed.startsWith('eyJ')) {
      return { accessToken: trimmed };
    }

    // Check if input is a URL
    if (trimmed.startsWith('http')) {
      return this.extractTokensFromUrl(trimmed);
    }

    // Check if input contains access_token (fragment without URL)
    if (trimmed.includes('access_token=')) {
      return this.extractTokensFromFragment(trimmed);
    }

    // Assume it's a JWT token
    return { accessToken: trimmed };
  }

  /**
   * Extract tokens from URL fragment.
   */
  private extractTokensFromUrl(url: string): AuthTokens {
    const parsed = new URL(url);
    const fragment = parsed.hash.slice(1); // Remove leading #
    return this.extractTokensFromFragment(fragment);
  }

  /**
   * Extract tokens from fragment string.
   */
  private extractTokensFromFragment(fragment: string): AuthTokens {
    // Remove leading # if present
    if (fragment.startsWith('#')) {
      fragment = fragment.slice(1);
    }

    const params = new URLSearchParams(fragment);
    return {
      accessToken: params.get('access_token') || '',
      refreshToken: params.get('refresh_token') || undefined,
    };
  }

  /**
   * Puppeteer-based authentication - monitors browser URL for callback.
   */
  private async authenticateWithCallback(): Promise<AuthTokens> {
    // Dynamically import puppeteer (optional dependency)
    let launch: typeof import('puppeteer').launch;
    try {
      const puppeteerModule = await import('puppeteer');
      launch = puppeteerModule.default?.launch ?? puppeteerModule.launch;
    } catch {
      console.log('Puppeteer not available, falling back to manual mode');
      return this.authenticateManual();
    }

    console.log('\n' + '='.repeat(60));
    console.log('SSO AUTHENTICATION - BROWSER MODE');
    console.log('='.repeat(60));
    console.log('\nOpening browser for authentication...');
    console.log('Please login with your POSTECH account.');
    console.log('The browser will close automatically after login.\n');

    let browser: PuppeteerBrowser | null = null;

    try {
      // Launch browser (visible to user for login)
      browser = await launch({
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });

      const page: PuppeteerPage = await browser.newPage();

      // Navigate to SSO URL
      await page.goto(this.ssoUrl, { waitUntil: 'networkidle2' });

      // Wait for URL to match callback pattern (user completes login)
      const tokens = await this.waitForCallbackUrl(page);

      console.log('\n' + '='.repeat(60));
      console.log('SSO LOGIN SUCCESSFUL!');
      console.log(`Token length: ${tokens.accessToken.length} chars`);
      console.log('='.repeat(60) + '\n');

      return tokens;
    } catch (error) {
      if (error instanceof AuthenticationError) {
        throw error;
      }
      throw new AuthenticationError(`Browser authentication failed: ${error}`);
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }

  /**
   * Wait for the browser URL to match callback pattern and extract tokens.
   */
  private async waitForCallbackUrl(page: PuppeteerPage): Promise<AuthTokens> {
    const startTime = Date.now();
    const timeoutMs = this.timeoutSeconds * 1000;

    while (Date.now() - startTime < timeoutMs) {
      const currentUrl = page.url();

      // Check if URL matches callback pattern
      if (currentUrl.includes(this.callbackPattern)) {
        // Extract tokens from URL fragment
        const tokens = this.extractTokensFromUrl(currentUrl);

        if (tokens.accessToken) {
          return tokens;
        }

        // If no token in URL, try to get it from the page's hash
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const hash = await page.evaluate('window.location.hash') as string;
        if (hash) {
          const hashTokens = this.extractTokensFromFragment(hash);
          if (hashTokens.accessToken) {
            return hashTokens;
          }
        }
      }

      // Small delay before next check
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new AuthenticationError('Authentication timed out waiting for callback');
  }

  /**
   * Read user input from stdin using readline.
   * This properly handles raw mode by temporarily switching to line mode.
   */
  private readUserInput(): Promise<string> {
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

      rl.question('> ', (answer) => {
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
