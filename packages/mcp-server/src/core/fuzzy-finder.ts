/**
 * Fuzzy File Finder - VS Code Ctrl+P style file search
 * Provides fuzzy matching with intelligent ranking
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Directories to skip during search
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.turbo',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '.popilot_log',
  '.cache',
  'coverage',
  '.nyc_output',
]);

/**
 * Result with match score for ranking
 */
export interface FuzzyMatch {
  path: string;
  filename: string;
  score: number;
  matchedIndices: number[];
}

/**
 * Calculate fuzzy match score between query and target
 * Higher score = better match
 *
 * Scoring:
 * - Exact filename match: +1000
 * - Filename starts with query: +500
 * - Filename contains query: +200
 * - Consecutive character matches: +10 each
 * - Character at word boundary: +5
 * - Any character match: +1
 * - Distance penalty: -1 per gap
 */
export function fuzzyMatch(query: string, target: string): { score: number; indices: number[] } | null {
  const queryLower = query.toLowerCase();
  const targetLower = target.toLowerCase();

  // Exact match
  if (targetLower === queryLower) {
    return { score: 1000, indices: Array.from({ length: target.length }, (_, i) => i) };
  }

  // Contains as substring
  const substringIdx = targetLower.indexOf(queryLower);
  if (substringIdx !== -1) {
    const indices = Array.from({ length: query.length }, (_, i) => substringIdx + i);
    // Bonus for prefix match
    const score = substringIdx === 0 ? 500 : 200;
    return { score, indices };
  }

  // Fuzzy match - characters in order
  const indices: number[] = [];
  let queryIdx = 0;
  let lastMatchIdx = -1;
  let score = 0;
  let consecutiveBonus = 0;

  for (let i = 0; i < targetLower.length && queryIdx < queryLower.length; i++) {
    if (targetLower[i] === queryLower[queryIdx]) {
      indices.push(i);

      // Consecutive match bonus
      if (lastMatchIdx === i - 1) {
        consecutiveBonus += 10;
      } else {
        consecutiveBonus = 0;
      }

      // Word boundary bonus (start of word, after separator)
      const prevChar = target[i - 1];
      if (i === 0 || prevChar === '/' || prevChar === '\\' || prevChar === '-' || prevChar === '_' || prevChar === '.') {
        score += 5;
      }
      // CamelCase boundary bonus
      else if (target[i] !== targetLower[i] && (i === 0 || target[i - 1] === target[i - 1].toLowerCase())) {
        score += 5;
      }

      score += 1 + consecutiveBonus;
      lastMatchIdx = i;
      queryIdx++;
    }
  }

  // All query characters must match
  if (queryIdx !== queryLower.length) {
    return null;
  }

  // Penalty for spread-out matches
  if (indices.length > 1) {
    const spread = indices[indices.length - 1] - indices[0];
    score -= Math.max(0, spread - indices.length);
  }

  // Bonus for shorter paths (prefer less nested files)
  const depthPenalty = (target.match(/\//g) || []).length * 2;
  score -= depthPenalty;

  return { score, indices };
}

/**
 * Recursively collect all files in directory
 */
async function collectFiles(
  dir: string,
  baseDir: string,
  files: string[],
  maxDepth: number,
  currentDepth: number = 0
): Promise<void> {
  if (currentDepth > maxDepth) return;

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await collectFiles(
          path.join(dir, entry.name),
          baseDir,
          files,
          maxDepth,
          currentDepth + 1
        );
      } else {
        const relativePath = path.relative(baseDir, path.join(dir, entry.name));
        files.push(relativePath);
      }
    }
  } catch {
    // Ignore permission errors etc.
  }
}

/**
 * Find files using fuzzy matching (VS Code Ctrl+P style)
 *
 * @param query - Search query (e.g., "apptsx", "reqtrans", "idx")
 * @param workspaceDir - Directory to search in
 * @param maxResults - Maximum number of results to return
 * @returns Ranked list of matching files
 */
export async function fuzzyFindFiles(
  query: string,
  workspaceDir: string,
  maxResults: number = 20
): Promise<FuzzyMatch[]> {
  // Collect all files
  const files: string[] = [];
  await collectFiles(workspaceDir, workspaceDir, files, 10);

  // Match and score each file
  const matches: FuzzyMatch[] = [];

  for (const filePath of files) {
    const filename = path.basename(filePath);

    // Try matching against filename first (higher priority)
    const filenameMatch = fuzzyMatch(query, filename);

    // Try matching against full path
    const pathMatch = fuzzyMatch(query, filePath);

    // Use the better match
    const match = filenameMatch && pathMatch
      ? (filenameMatch.score >= pathMatch.score ? filenameMatch : pathMatch)
      : (filenameMatch || pathMatch);

    if (match) {
      // Boost filename matches
      const finalScore = filenameMatch
        ? match.score + (filenameMatch.score > 0 ? 100 : 0)
        : match.score;

      matches.push({
        path: filePath,
        filename,
        score: finalScore,
        matchedIndices: match.indices,
      });
    }
  }

  // Sort by score (descending) and return top results
  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, maxResults);
}

/**
 * Format fuzzy find results for display
 */
export function formatFuzzyResults(query: string, matches: FuzzyMatch[]): string {
  if (matches.length === 0) {
    return `No files found matching: "${query}"

Tips:
- Try shorter query (e.g., "app" instead of "application")
- Use key characters (e.g., "rt" for "request-transformer")
- Include extension (e.g., "apptsx" for App.tsx)`;
  }

  const lines = [`Found ${matches.length} file(s) matching "${query}":`];

  for (const match of matches) {
    // Show score for debugging (can be removed later)
    lines.push(`  - ${match.path}`);
  }

  return lines.join('\n');
}
