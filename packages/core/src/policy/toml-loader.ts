/**
 * TOML Policy Loader
 *
 * Loads policy rules from TOML configuration files.
 * Supports multiple policy files with priority-based merging.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PolicyRule, ApprovalMode, PolicyDecision } from './policy-engine.js';

// Type for TOML parser
interface TomlParser {
  parse(input: string): Record<string, unknown>;
}

/**
 * TOML policy file structure
 */
interface TomlPolicyFile {
  rules?: TomlRule[];
  settings?: TomlSettings;
}

interface TomlRule {
  tool: string;
  decision: string;
  priority?: number;
  modes?: string[];
  args_pattern?: string;
  decision_if_match?: string;
  description?: string;
}

interface TomlSettings {
  mode?: string;
  remember_decisions?: boolean;
}

/**
 * Result of loading policy files
 */
export interface PolicyLoadResult {
  rules: PolicyRule[];
  settings: {
    mode?: ApprovalMode;
    rememberDecisions?: boolean;
  };
  loadedFiles: string[];
  errors: Array<{ file: string; error: string }>;
}

/**
 * Validate and convert decision string
 */
function parseDecision(value: string): PolicyDecision | null {
  const normalized = value.toLowerCase();
  if (normalized === 'allow' || normalized === 'deny' || normalized === 'ask') {
    return normalized as PolicyDecision;
  }
  return null;
}

/**
 * Validate and convert mode string
 */
function parseMode(value: string): ApprovalMode | null {
  const normalized = value.toLowerCase();
  if (normalized === 'default') return 'default';
  if (normalized === 'autoedit') return 'autoEdit';
  if (normalized === 'yolo') return 'yolo';
  return null;
}

/**
 * Convert a TOML rule to PolicyRule
 */
function convertRule(tomlRule: TomlRule, fileIndex: number): PolicyRule | null {
  if (!tomlRule.tool || !tomlRule.decision) {
    return null;
  }

  const decision = parseDecision(tomlRule.decision);
  if (!decision) {
    return null;
  }

  const rule: PolicyRule = {
    tool: tomlRule.tool,
    decision,
    priority: tomlRule.priority ?? (10 + fileIndex * 0.1), // File-based priority offset
  };

  // Optional fields
  if (tomlRule.modes) {
    const modes: ApprovalMode[] = [];
    for (const m of tomlRule.modes) {
      const mode = parseMode(m);
      if (mode) modes.push(mode);
    }
    if (modes.length > 0) {
      rule.modes = modes;
    }
  }

  if (tomlRule.args_pattern) {
    rule.argsPattern = tomlRule.args_pattern;
  }

  if (tomlRule.decision_if_match) {
    const decisionIfMatch = parseDecision(tomlRule.decision_if_match);
    if (decisionIfMatch) {
      rule.decisionIfMatch = decisionIfMatch;
    }
  }

  if (tomlRule.description) {
    rule.description = tomlRule.description;
  }

  return rule;
}

/**
 * Load policies from a single TOML file
 */
export async function loadPolicyFile(filePath: string): Promise<{
  rules: PolicyRule[];
  settings: TomlSettings;
  error?: string;
}> {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');

    // Dynamic import for @iarna/toml
    const TOML = await import('@iarna/toml') as unknown as TomlParser;
    const parsed = TOML.parse(content) as TomlPolicyFile;

    const rules: PolicyRule[] = [];

    if (parsed.rules && Array.isArray(parsed.rules)) {
      for (const tomlRule of parsed.rules) {
        const rule = convertRule(tomlRule, 0);
        if (rule) {
          rules.push(rule);
        }
      }
    }

    return {
      rules,
      settings: parsed.settings ?? {},
    };
  } catch (error) {
    return {
      rules: [],
      settings: {},
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Load policies from a directory
 *
 * Files are loaded in alphabetical order, with later files having lower priority
 * (so they can override earlier files).
 *
 * Expected files:
 * - default.toml: Built-in defaults (usually not user-edited)
 * - user.toml: User customizations
 * - auto-saved.toml: Auto-saved permissions
 */
export async function loadPoliciesFromDirectory(policyDir: string): Promise<PolicyLoadResult> {
  const result: PolicyLoadResult = {
    rules: [],
    settings: {},
    loadedFiles: [],
    errors: [],
  };

  if (!fs.existsSync(policyDir)) {
    return result;
  }

  // Get all .toml files, sorted alphabetically
  const files = fs.readdirSync(policyDir)
    .filter(f => f.endsWith('.toml'))
    .sort();

  for (let i = 0; i < files.length; i++) {
    const filePath = path.join(policyDir, files[i]);
    const { rules, settings, error } = await loadPolicyFile(filePath);

    if (error) {
      result.errors.push({ file: files[i], error });
      continue;
    }

    // Add rules with file-based priority offset
    for (const rule of rules) {
      // Adjust priority based on file order (later files = lower priority number = higher precedence)
      rule.priority = (rule.priority ?? 10) - (files.length - i) * 0.01;
      result.rules.push(rule);
    }

    // Merge settings (later files override earlier)
    if (settings.mode) {
      const mode = parseMode(settings.mode);
      if (mode) result.settings.mode = mode;
    }
    if (settings.remember_decisions !== undefined) {
      result.settings.rememberDecisions = settings.remember_decisions;
    }

    result.loadedFiles.push(files[i]);
  }

  // Sort rules by priority
  result.rules.sort((a, b) => a.priority - b.priority);

  return result;
}

/**
 * Create a default policy TOML file template
 */
export function createDefaultPolicyTemplate(): string {
  return `# Popilot Policy Configuration
#
# Each [[rules]] block defines a policy rule.
# Rules are evaluated in priority order (lower number = higher priority).
#
# Available decisions: allow, deny, ask
# Available modes: default, autoEdit, yolo

[settings]
# mode = "default"           # Options: default, autoEdit, yolo
# remember_decisions = true  # Save user decisions for reuse

# Allow read operations
[[rules]]
tool = "file.read"
decision = "allow"
priority = 1.0
description = "File reading is safe"

[[rules]]
tool = "file.search"
decision = "allow"
priority = 1.0

[[rules]]
tool = "find_files"
decision = "allow"
priority = 1.0

# Require confirmation for write operations (in default mode)
[[rules]]
tool = "file.write"
decision = "ask"
priority = 2.0
modes = ["default"]

[[rules]]
tool = "file.applyTextEdits"
decision = "ask"
priority = 2.0
modes = ["default"]

# Shell commands - require confirmation except for safe commands
[[rules]]
tool = "run_terminal_command"
decision = "ask"
priority = 3.0
modes = ["default", "autoEdit"]

# Block dangerous commands
[[rules]]
tool = "run_terminal_command"
decision = "deny"
priority = 0.5
args_pattern = "rm\\\\s+-rf\\\\s+/"
decision_if_match = "deny"
description = "Block dangerous rm -rf on root"

# Allow safe read-only commands
[[rules]]
tool = "run_terminal_command"
decision = "allow"
priority = 1.5
args_pattern = "^(ls|pwd|cat|head|tail|echo|git\\\\s+status|git\\\\s+log|git\\\\s+diff)"
decision_if_match = "allow"
description = "Safe read-only commands"
`;
}

/**
 * Save a policy rule to the user's policy file
 */
export async function saveRuleToFile(
  policyDir: string,
  rule: PolicyRule,
  filename: string = 'user.toml'
): Promise<void> {
  fs.mkdirSync(policyDir, { recursive: true });

  const filePath = path.join(policyDir, filename);
  let content = '';

  // Try to read existing file
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    // File doesn't exist, start with template header
    content = `# User Policy Customizations\n\n`;
  }

  // Append new rule
  const ruleToml = `
[[rules]]
tool = "${rule.tool}"
decision = "${rule.decision}"
priority = ${rule.priority}
${rule.description ? `description = "${rule.description}"` : ''}
`;

  content += ruleToml;
  fs.writeFileSync(filePath, content, 'utf-8');
}
