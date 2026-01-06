/**
 * SSO Authenticator for POSTECH GenAI
 * Supports both OAuth callback mode and manual token input mode
 *
 * TypeScript port of continuedev/src/auth/sso_authenticator.py
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as net from 'node:net';
import { URL, URLSearchParams } from 'node:url';
import open from 'open';

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
    if (this.manualMode || isWSL()) {
      return this.authenticateManual();
    }
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
   * OAuth callback authentication - start local server and wait for redirect.
   */
  private async authenticateWithCallback(): Promise<AuthTokens> {
    const port = await this.getAvailablePort();
    const redirectUri = `http://localhost:${port}/callback`;

    // Build auth URL with redirect
    const authUrl = new URL(this.ssoUrl);
    authUrl.searchParams.set('redirect_uri', redirectUri);

    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        try {
          if (!req.url?.includes('/callback')) {
            res.writeHead(404);
            res.end('Not found');
            return;
          }

          // The token is in the URL fragment, which browsers don't send to server
          // So we need to serve a page that extracts it and sends it back
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <!DOCTYPE html>
            <html>
            <head><title>Authentication</title></head>
            <body>
              <h1>Processing authentication...</h1>
              <script>
                const hash = window.location.hash.substring(1);
                if (hash) {
                  fetch('/token?' + hash)
                    .then(() => {
                      document.body.innerHTML = '<h1>Authentication successful! You can close this window.</h1>';
                    });
                } else {
                  document.body.innerHTML = '<h1>Authentication failed: No token received</h1>';
                }
              </script>
            </body>
            </html>
          `);
        } catch (error) {
          res.writeHead(500);
          res.end('Error');
        }
      });

      // Handle token callback from the HTML page
      server.on('request', (req, res) => {
        if (req.url?.startsWith('/token?')) {
          const params = new URLSearchParams(req.url.slice(7));
          const accessToken = params.get('access_token');

          if (accessToken) {
            res.writeHead(200);
            res.end('OK');
            server.close();

            resolve({
              accessToken,
              refreshToken: params.get('refresh_token') || undefined,
            });
          } else {
            res.writeHead(400);
            res.end('No token');
          }
        }
      });

      // Set timeout
      const timeout = setTimeout(() => {
        server.close();
        reject(new AuthenticationError('Authentication timed out'));
      }, this.timeoutSeconds * 1000);

      server.listen(port, () => {
        console.log(`\nOpening browser for authentication...`);
        console.log(`If browser doesn't open, visit: ${authUrl.toString()}\n`);

        open(authUrl.toString()).catch(() => {
          console.log(`Please open this URL manually: ${authUrl.toString()}`);
        });
      });

      server.on('close', () => {
        clearTimeout(timeout);
      });

      server.on('error', (error) => {
        clearTimeout(timeout);
        reject(new AuthenticationError(`Server error: ${error.message}`));
      });
    });
  }

  /**
   * Get an available port.
   */
  private getAvailablePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();

      server.listen(0, () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          const port = address.port;
          server.close(() => resolve(port));
        } else {
          server.close(() => reject(new Error('Could not get port')));
        }
      });

      server.on('error', reject);
    });
  }

  /**
   * Read user input from stdin.
   */
  private readUserInput(): Promise<string> {
    return new Promise((resolve) => {
      let input = '';

      process.stdin.setEncoding('utf8');
      process.stdin.once('data', (data) => {
        input = data.toString().trim();
        resolve(input);
      });

      // For non-interactive mode, resolve after a short timeout
      setTimeout(() => {
        if (!input) resolve('');
      }, 100);
    });
  }
}
