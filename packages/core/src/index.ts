/**
 * Popilot Core - POSTECH GenAI CLI Agent Core Library
 */

// Types
export * from './types.js';

// Client
export {
  PostechClient,
  PostechClientError,
  type PostechClientConfig,
  type AIAgent,
  type ChatRoomInfo,
  type AuthMode,
} from './client/postech-client.js';
export { RequestTransformer, type TransformerConfig, type TransformerResult } from './client/request-transformer.js';

// Authentication
export {
  TokenStorage,
  type StoredTokens,
} from './auth/token-storage.js';
export {
  SSOAuthenticator,
  type SSOAuthenticatorConfig,
  type AuthTokens,
  AuthenticationError,
} from './auth/sso-authenticator.js';
export { TokenManager, type TokenManagerConfig } from './auth/token-manager.js';
export { ApiKeyStorage } from './auth/apikey-storage.js';
export {
  ApiKeyAuthenticator,
  type ApiKeyAuthenticatorConfig,
  ApiKeyAuthenticationError,
} from './auth/apikey-authenticator.js';

// Tools
export {
  ToolExecutor,
  type ToolExecutorConfig,
  type TextEdit,
} from './tools/tool-executor.js';
export { ToolParser, type ParsedToolBlock } from './tools/tool-parser.js';

// Services
export { SessionService, type SessionServiceConfig } from './services/session-service.js';

// Utils
export { DebugLogger } from './utils/logger.js';
