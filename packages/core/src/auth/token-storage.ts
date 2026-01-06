/**
 * Token Storage for Popilot
 * Encrypted file-based token storage
 *
 * TypeScript port of continuedev/src/auth/token_storage.py
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  savedAt: number;
}

/**
 * Encrypted file-based token storage.
 *
 * Uses AES-256-GCM encryption with a machine-specific key.
 */
export class TokenStorage {
  private storagePath: string;
  private key: Buffer;

  constructor(storagePath?: string) {
    this.storagePath = storagePath ?? this.getDefaultPath();
    this.key = this.deriveKey();

    // Ensure directory exists
    const dir = path.dirname(this.storagePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  private getDefaultPath(): string {
    const homeDir = os.homedir();
    return path.join(homeDir, '.popilot', 'credentials.enc');
  }

  /**
   * Derive encryption key from machine-specific data.
   */
  private deriveKey(): Buffer {
    const machineId = [
      process.env.COMPUTERNAME || '',
      process.env.USER || process.env.USERNAME || '',
      os.hostname(),
      os.platform(),
    ].join('');

    return crypto.createHash('sha256').update(machineId).digest();
  }

  /**
   * Encrypt and save tokens to disk.
   */
  saveTokens(accessToken: string, refreshToken?: string): void {
    const data: StoredTokens = {
      accessToken,
      refreshToken,
      savedAt: Date.now(),
    };

    const plaintext = JSON.stringify(data);

    // Generate random IV
    const iv = crypto.randomBytes(12);

    // Encrypt using AES-256-GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    // Store: IV (12 bytes) + AuthTag (16 bytes) + Encrypted data
    const combined = Buffer.concat([iv, authTag, encrypted]);

    fs.writeFileSync(this.storagePath, combined, { mode: 0o600 });
  }

  /**
   * Load and decrypt tokens from disk.
   */
  loadTokens(): StoredTokens | null {
    if (!fs.existsSync(this.storagePath)) {
      return null;
    }

    try {
      const combined = fs.readFileSync(this.storagePath);

      // Extract IV, AuthTag, and encrypted data
      const iv = combined.subarray(0, 12);
      const authTag = combined.subarray(12, 28);
      const encrypted = combined.subarray(28);

      // Decrypt using AES-256-GCM
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(authTag);

      const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]);

      return JSON.parse(decrypted.toString('utf8'));
    } catch {
      // Corrupted or invalid file
      return null;
    }
  }

  /**
   * Remove stored tokens.
   */
  clearTokens(): void {
    if (fs.existsSync(this.storagePath)) {
      fs.unlinkSync(this.storagePath);
    }
  }

  /**
   * Check if tokens exist.
   */
  hasTokens(): boolean {
    return fs.existsSync(this.storagePath);
  }
}
