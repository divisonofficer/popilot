/**
 * Token Manager for Popilot
 * Manages JWT token lifecycle with automatic re-authentication
 *
 * TypeScript port of continuedev/src/auth/token_manager.py
 */

import * as jose from 'jose';
import { TokenStorage, type StoredTokens } from './token-storage.js';
import { SSOAuthenticator, type AuthTokens, AuthenticationError } from './sso-authenticator.js';
import type { TokenInfo } from '../types.js';

export interface TokenManagerConfig {
  storage: TokenStorage;
  authenticator: SSOAuthenticator;
  expiryBufferSeconds?: number;
}

/**
 * Manages JWT token lifecycle with automatic re-authentication.
 */
export class TokenManager {
  private storage: TokenStorage;
  private authenticator: SSOAuthenticator;
  private expiryBufferSeconds: number;

  private token: string | null = null;
  private refreshToken: string | null = null;
  private expTime: number | null = null;
  private authInProgress: Promise<string> | null = null;

  constructor(config: TokenManagerConfig) {
    this.storage = config.storage;
    this.authenticator = config.authenticator;
    this.expiryBufferSeconds = config.expiryBufferSeconds ?? 300;

    // Try to load existing token
    this.loadStoredToken();
  }

  /**
   * Load token from storage if available and valid.
   */
  private loadStoredToken(): void {
    const tokens = this.storage.loadTokens();
    if (tokens?.accessToken) {
      if (!this.isTokenExpired(tokens.accessToken)) {
        this.setToken(tokens.accessToken, tokens.refreshToken);
        console.log('Loaded valid token from storage');
      } else {
        console.log('Stored token is expired');
      }
    }
  }

  /**
   * Get a valid token, re-authenticating if necessary.
   */
  async getValidToken(): Promise<string> {
    // Wait if auth is already in progress
    if (this.authInProgress) {
      return this.authInProgress;
    }

    // Check if current token is valid
    if (this.token && !this.isExpired()) {
      return this.token;
    }

    // Need to re-authenticate
    return this.reauthenticate();
  }

  /**
   * Check if current token is expired or about to expire.
   */
  private isExpired(): boolean {
    if (!this.expTime) return true;
    const currentTime = Date.now() / 1000;
    return currentTime >= this.expTime - this.expiryBufferSeconds;
  }

  /**
   * Check JWT exp claim without signature verification.
   */
  private isTokenExpired(token: string): boolean {
    try {
      const decoded = jose.decodeJwt(token);
      const exp = decoded.exp ?? 0;
      const currentTime = Date.now() / 1000;
      return currentTime >= exp - this.expiryBufferSeconds;
    } catch {
      return true;
    }
  }

  /**
   * Set token and extract expiration time.
   */
  private setToken(token: string, refreshToken?: string | null): void {
    this.token = token;
    this.refreshToken = refreshToken ?? null;

    try {
      const decoded = jose.decodeJwt(token);
      this.expTime = decoded.exp ?? null;
      if (this.expTime) {
        const expiresIn = Math.floor(this.expTime - Date.now() / 1000);
        console.log(`Token set, expires in: ${expiresIn} seconds`);
      }
    } catch {
      // Default to 1 hour if can't decode
      this.expTime = Date.now() / 1000 + 3600;
      console.warn('Could not decode token, using default expiry');
    }
  }

  /**
   * Trigger SSO re-authentication.
   */
  private async reauthenticate(): Promise<string> {
    // Create a promise that other callers can wait on
    this.authInProgress = (async () => {
      try {
        console.log('Starting SSO re-authentication...');
        const tokens = await this.authenticator.authenticate();

        this.setToken(tokens.accessToken, tokens.refreshToken);
        this.storage.saveTokens(tokens.accessToken, tokens.refreshToken);

        console.log('Re-authentication successful');
        return tokens.accessToken;
      } catch (error) {
        if (error instanceof AuthenticationError) {
          console.error(`Re-authentication failed: ${error.message}`);
        }
        throw error;
      } finally {
        this.authInProgress = null;
      }
    })();

    return this.authInProgress;
  }

  /**
   * Get current token status information.
   */
  getTokenInfo(): TokenInfo & { isExpired: boolean; expiresIn: number | null } {
    const expiresIn = this.expTime ? Math.floor(this.expTime - Date.now() / 1000) : null;

    return {
      accessToken: this.token ?? '',
      refreshToken: this.refreshToken ?? undefined,
      expiresAt: this.expTime ? this.expTime * 1000 : undefined,
      isExpired: this.isExpired(),
      expiresIn,
    };
  }

  /**
   * Force clear token and storage.
   */
  clearToken(): void {
    this.token = null;
    this.refreshToken = null;
    this.expTime = null;
    this.storage.clearTokens();
  }

  /**
   * Check if we have a valid token (without triggering re-auth).
   */
  hasValidToken(): boolean {
    return this.token !== null && !this.isExpired();
  }
}
