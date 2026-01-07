/**
 * Tools module for Popilot
 */

export { ToolExecutor, type ToolExecutorConfig, type TextEdit } from './tool-executor.js';
export { ToolParser, type ParsedToolBlock } from './tool-parser.js';
export {
  readManyFiles,
  formatReadManyFilesResult,
  type ReadManyFilesArgs,
  type ReadManyFilesResult,
  type FileReadResult,
} from './read-many-files.js';
export {
  validateSvelteFile,
  validateSvelteFileAsync,
  quickSvelteCheck,
  formatValidationErrors,
  type SvelteValidationResult,
  type SvelteValidationError,
  type SvelteValidationWarning,
  type SvelteMetadata,
} from './svelte-validator.js';
