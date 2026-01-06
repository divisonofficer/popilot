/**
 * SHA256 utility for file content verification
 * Used for precondition checks (race condition prevention)
 */

import { createHash } from 'node:crypto';

/**
 * Compute SHA256 hash of content
 */
export function computeSha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

export interface Sha256VerifyResult {
  valid: boolean;
  actual: string;
  expected: string;
}

/**
 * Verify content matches expected SHA256
 */
export function verifySha256(content: string, expectedHash: string): Sha256VerifyResult {
  const actual = computeSha256(content);
  return {
    valid: actual === expectedHash,
    actual,
    expected: expectedHash,
  };
}
