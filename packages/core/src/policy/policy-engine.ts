/**
 * Policy Engine
 *
 * Evaluates tool execution policies based on configurable rules.
 * Replaces simple autoconfirm with a flexible policy system.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadPoliciesFromDirectory } from './toml-loader.js';

export type PolicyDecision = 'allow' | 'deny' | 'ask';
export type ApprovalMode = 'default' | 'autoEdit' | 'yolo';

export interface PolicyRule {
  /** Tool name or wildcard pattern (e.g., "file.*") */
  tool: string;
  /** Decision for this rule */
  decision: PolicyDecision;
  /** Priority (lower number = higher priority) */
  priority: number;
  /** Optional: Only apply in these modes */
  modes?: ApprovalMode[];
  /** Optional: Regex pattern to match against args */
  argsPattern?: string;
  /** Decision to use if argsPattern matches */
  decisionIfMatch?: PolicyDecision;
  /** Optional description */
  description?: string;
}

export interface PolicyConfig {
  /** Current approval mode */
  mode?: ApprovalMode;
  /** Path to policy directory */
  policyDir?: string;
  /** Whether to remember user decisions */
  rememberDecisions?: boolean;
}

export interface SavedDecision {
  tool: string;
  argsPattern?: string;
  decision: PolicyDecision;
  savedAt: string;
}

/**
 * Default policy rules (built-in)
 */
const DEFAULT_RULES: PolicyRule[] = [
  // Read operations - always allow
  {
    tool: 'file.read',
    decision: 'allow',
    priority: 1.0,
    description: 'File reading is safe',
  },
  {
    tool: 'file.search',
    decision: 'allow',
    priority: 1.0,
    description: 'File search is safe',
  },
  {
    tool: 'file.find',
    decision: 'allow',
    priority: 1.0,
    description: 'File find is safe',
  },
  {
    tool: 'find_files',
    decision: 'allow',
    priority: 1.0,
    description: 'Find files is safe',
  },
  {
    tool: 'read_many_files',
    decision: 'allow',
    priority: 1.0,
    description: 'Reading multiple files is safe',
  },

  // Write operations - ask by default
  {
    tool: 'file.write',
    decision: 'ask',
    priority: 2.0,
    modes: ['default'],
    description: 'File write needs confirmation',
  },
  {
    tool: 'file.applyTextEdits',
    decision: 'ask',
    priority: 2.0,
    modes: ['default'],
    description: 'File edit needs confirmation',
  },

  // Shell commands - context-dependent
  {
    tool: 'run_terminal_command',
    decision: 'ask',
    priority: 3.0,
    modes: ['default', 'autoEdit'],
    description: 'Shell commands need confirmation',
  },
  {
    tool: 'run_terminal_command',
    decision: 'deny',
    priority: 0.5, // High priority - match first
    argsPattern: 'rm\\s+-rf\\s+/',
    decisionIfMatch: 'deny',
    description: 'Block dangerous rm -rf on root',
  },
  {
    tool: 'run_terminal_command',
    decision: 'deny',
    priority: 0.5,
    argsPattern: 'sudo\\s+rm',
    decisionIfMatch: 'deny',
    description: 'Block sudo rm commands',
  },

  // Git operations
  {
    tool: 'git.*',
    decision: 'ask',
    priority: 2.5,
    modes: ['default'],
    description: 'Git operations need confirmation',
  },

  // Safe list commands
  {
    tool: 'run_terminal_command',
    decision: 'allow',
    priority: 1.5,
    argsPattern: '^(ls|pwd|cat|head|tail|echo|git\\s+status|git\\s+log|git\\s+diff|npm\\s+run|pnpm\\s+run)',
    decisionIfMatch: 'allow',
    description: 'Safe read-only commands',
  },
];

/**
 * PolicyEngine evaluates tool execution permissions.
 */
export class PolicyEngine {
  private rules: PolicyRule[] = [];
  private mode: ApprovalMode = 'default';
  private policyDir?: string;
  private savedDecisions: Map<string, SavedDecision> = new Map();
  private rememberDecisions: boolean;

  constructor(config: PolicyConfig = {}) {
    this.mode = config.mode ?? 'default';
    this.policyDir = config.policyDir;
    this.rememberDecisions = config.rememberDecisions ?? true;

    // Load default rules
    this.rules = [...DEFAULT_RULES];

    // Load saved decisions if policy dir exists
    if (this.policyDir) {
      this.loadSavedDecisions();
    }
  }

  /**
   * Set the current approval mode
   */
  setMode(mode: ApprovalMode): void {
    this.mode = mode;
  }

  /**
   * Get the current approval mode
   */
  getMode(): ApprovalMode {
    return this.mode;
  }

  /**
   * Add a policy rule
   */
  addRule(rule: PolicyRule): void {
    this.rules.push(rule);
    this.sortRules();
  }

  /**
   * Sort rules by priority (lower first)
   */
  private sortRules(): void {
    this.rules.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Check if a tool name matches a pattern
   */
  private matchesTool(toolName: string, pattern: string): boolean {
    // Exact match
    if (toolName === pattern) return true;

    // Wildcard match (e.g., "file.*" matches "file.read")
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -1); // Remove '*', keep '.'
      return toolName.startsWith(prefix);
    }

    // Glob-style match (e.g., "*_files" matches "find_files")
    if (pattern.startsWith('*')) {
      const suffix = pattern.slice(1);
      return toolName.endsWith(suffix);
    }

    return false;
  }

  /**
   * Evaluate policy for a tool call
   */
  evaluate(toolName: string, args: unknown): PolicyDecision {
    // In yolo mode, allow everything except explicitly denied
    if (this.mode === 'yolo') {
      // Check for explicit deny rules only
      for (const rule of this.rules) {
        if (!this.matchesTool(toolName, rule.tool)) continue;
        if (rule.decision === 'deny') {
          if (rule.argsPattern) {
            const argsStr = JSON.stringify(args);
            if (new RegExp(rule.argsPattern).test(argsStr)) {
              return 'deny';
            }
          } else {
            return 'deny';
          }
        }
      }
      return 'allow';
    }

    // Check saved decisions first
    const savedKey = this.getSavedDecisionKey(toolName, args);
    const saved = this.savedDecisions.get(savedKey);
    if (saved) {
      return saved.decision;
    }

    // Evaluate rules in priority order
    for (const rule of this.rules) {
      if (!this.matchesTool(toolName, rule.tool)) continue;

      // Check mode restriction
      if (rule.modes && !rule.modes.includes(this.mode)) continue;

      // Check args pattern if specified
      if (rule.argsPattern) {
        const argsStr = JSON.stringify(args);
        const matches = new RegExp(rule.argsPattern).test(argsStr);

        if (matches && rule.decisionIfMatch) {
          return rule.decisionIfMatch;
        }

        // If pattern doesn't match, skip this rule
        if (!matches) continue;
      }

      return rule.decision;
    }

    // Default: ask for confirmation
    return 'ask';
  }

  /**
   * Generate a key for saved decisions
   */
  private getSavedDecisionKey(toolName: string, args: unknown): string {
    // For now, just use tool name
    // Could be extended to include specific arg patterns
    return toolName;
  }

  /**
   * Save a user's decision for future use
   */
  saveUserDecision(toolName: string, decision: PolicyDecision, args?: unknown): void {
    if (!this.rememberDecisions) return;

    const key = this.getSavedDecisionKey(toolName, args);
    const saved: SavedDecision = {
      tool: toolName,
      decision,
      savedAt: new Date().toISOString(),
    };

    this.savedDecisions.set(key, saved);

    // Persist to file if policy dir is set
    if (this.policyDir) {
      this.persistSavedDecisions();
    }
  }

  /**
   * Load saved decisions from file
   */
  private loadSavedDecisions(): void {
    if (!this.policyDir) return;

    const savedPath = path.join(this.policyDir, 'saved-decisions.json');

    try {
      if (fs.existsSync(savedPath)) {
        const content = fs.readFileSync(savedPath, 'utf-8');
        const decisions = JSON.parse(content) as SavedDecision[];

        for (const decision of decisions) {
          const key = decision.tool;
          this.savedDecisions.set(key, decision);
        }
      }
    } catch {
      // Ignore load errors
    }
  }

  /**
   * Persist saved decisions to file
   */
  private persistSavedDecisions(): void {
    if (!this.policyDir) return;

    fs.mkdirSync(this.policyDir, { recursive: true });
    const savedPath = path.join(this.policyDir, 'saved-decisions.json');

    const decisions = Array.from(this.savedDecisions.values());
    fs.writeFileSync(savedPath, JSON.stringify(decisions, null, 2), 'utf-8');
  }

  /**
   * Clear all saved decisions
   */
  clearSavedDecisions(): void {
    this.savedDecisions.clear();

    if (this.policyDir) {
      const savedPath = path.join(this.policyDir, 'saved-decisions.json');
      try {
        fs.unlinkSync(savedPath);
      } catch {
        // Ignore if file doesn't exist
      }
    }
  }

  /**
   * Load policies from TOML files in a directory
   */
  async loadFromDirectory(policyDir: string): Promise<{
    loadedFiles: string[];
    errors: Array<{ file: string; error: string }>;
  }> {
    const result = await loadPoliciesFromDirectory(policyDir);

    // Add loaded rules (with higher priority than defaults)
    for (const rule of result.rules) {
      this.rules.push(rule);
    }
    this.sortRules();

    // Apply settings
    if (result.settings.mode) {
      this.mode = result.settings.mode;
    }
    if (result.settings.rememberDecisions !== undefined) {
      this.rememberDecisions = result.settings.rememberDecisions;
    }

    return {
      loadedFiles: result.loadedFiles,
      errors: result.errors,
    };
  }

  /**
   * Get all current rules
   */
  getRules(): PolicyRule[] {
    return [...this.rules];
  }

  /**
   * Get rules that apply to a specific tool
   */
  getRulesForTool(toolName: string): PolicyRule[] {
    return this.rules.filter(rule => this.matchesTool(toolName, rule.tool));
  }

  /**
   * Format policy status for display
   */
  formatStatus(): string {
    const lines: string[] = [
      `Policy Mode: ${this.mode}`,
      `Active Rules: ${this.rules.length}`,
      `Saved Decisions: ${this.savedDecisions.size}`,
    ];

    if (this.mode === 'yolo') {
      lines.push('⚠️  YOLO mode - most operations auto-approved');
    } else if (this.mode === 'autoEdit') {
      lines.push('📝 Auto-edit mode - file operations auto-approved');
    }

    return lines.join('\n');
  }

  /**
   * Check if a specific tool requires confirmation in current mode
   */
  requiresConfirmation(toolName: string, args: unknown): boolean {
    const decision = this.evaluate(toolName, args);
    return decision === 'ask';
  }

  /**
   * Check if a specific tool is denied
   */
  isDenied(toolName: string, args: unknown): boolean {
    const decision = this.evaluate(toolName, args);
    return decision === 'deny';
  }
}

/**
 * Create a default policy engine instance
 */
export function createDefaultPolicyEngine(config?: PolicyConfig): PolicyEngine {
  return new PolicyEngine(config);
}
