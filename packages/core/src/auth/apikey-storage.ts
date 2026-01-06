/**
 * API Key Storage for Popilot
 * Encrypted file-based API key storage
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

/**
 * Encrypted file-based API key storage.
 *
 * Uses AES-256-GCM encryption with a machine-specific key.
 */
export class ApiKeyStorage {
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
    return path.join(homeDir, '.popilot', 'apikey.enc');
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
      'popilot-apikey', // Salt for API key storage
    ].join('');

    return crypto.createHash('sha256').update(machineId).digest();
  }

  /**
   * Encrypt and save API key to disk.
   */
  saveApiKey(apiKey: string): void {
    const data = {
      apiKey,
      savedAt: Date.now(),
    };

    const plaintext = JSON.stringify(data);

    // Generate random IV
    const iv = crypto.randomBytes(12);

    // Encrypt using AES-256-GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Store: IV (12 bytes) + AuthTag (16 bytes) + Encrypted data
    const combined = Buffer.concat([iv, authTag, encrypted]);

    fs.writeFileSync(this.storagePath, combined, { mode: 0o600 });
  }

  /**
   * Load and decrypt API key from disk.
   */
  loadApiKey(): string | null {
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

      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

      const data = JSON.parse(decrypted.toString('utf8'));
      return data.apiKey || null;
    } catch {
      // Corrupted or invalid file
      return null;
    }
  }

  /**
   * Remove stored API key.
   */
  clearApiKey(): void {
    if (fs.existsSync(this.storagePath)) {
      fs.unlinkSync(this.storagePath);
    }
  }

  /**
   * Check if API key exists.
   */
  hasApiKey(): boolean {
    return fs.existsSync(this.storagePath);
  }
}
