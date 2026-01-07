/**
 * Policy module for Popilot
 */

export {
  PolicyEngine,
  createDefaultPolicyEngine,
  type PolicyDecision,
  type ApprovalMode,
  type PolicyRule,
  type PolicyConfig,
  type SavedDecision,
} from './policy-engine.js';

export {
  loadPolicyFile,
  loadPoliciesFromDirectory,
  createDefaultPolicyTemplate,
  saveRuleToFile,
  type PolicyLoadResult,
} from './toml-loader.js';
