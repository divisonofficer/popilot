/**
 * Core types for Popilot - POSTECH GenAI CLI Agent
 */

// ============================================
// Model Configuration Types
// ============================================

export type ModelProvider = 'anthropic' | 'azure' | 'google';

export interface ModelConfig {
  provider: ModelProvider;
  modelName: string;
  deploymentName: string;
}

export const AVAILABLE_MODELS: Record<string, ModelConfig> = {
  'claude-sonnet-4-5': {
    provider: 'anthropic',
    modelName: 'Sonnet-4.5',
    deploymentName: 'claude-sonnet-4-5-20250929',
  },
  'gpt-5.1': {
    provider: 'azure',
    modelName: 'GPT-5.1',
    deploymentName: 'gpt-5.1-gs-2025-11-13',
  },
  'gemini-3-pro': {
    provider: 'google',
    modelName: 'Gemini-Pro-3',
    deploymentName: 'gemini-3-pro-preview',
  },
};

/**
 * Model shortcut aliases for easier command input.
 */
export const MODEL_ALIASES: Record<string, string> = {
  'claude': 'claude-sonnet-4-5',
  'gpt': 'gpt-5.1',
  'gemini': 'gemini-3-pro',
};

/**
 * Resolve model name from input (supports aliases).
 */
export function resolveModelName(input: string): string | undefined {
  // Direct match
  if (AVAILABLE_MODELS[input]) {
    return input;
  }
  // Alias match
  const alias = MODEL_ALIASES[input.toLowerCase()];
  if (alias && AVAILABLE_MODELS[alias]) {
    return alias;
  }
  return undefined;
}

// ============================================
// Message Types
// ============================================

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface Message {
  role: MessageRole;
  content: string | ContentPart[];
  name?: string;
  toolCallId?: string;
}

export interface ContentPart {
  type: 'text' | 'image_url';
  text?: string;
  imageUrl?: { url: string };
}

// ============================================
// API Request/Response Types
// ============================================

/**
 * Model config in API format (snake_case).
 */
export interface PostechModelConfig {
  provider: ModelProvider;
  model_name: string;
  deployment_name: string;
}

export interface PostechRequestPayload {
  app_type: 'browser';
  device_type: 'pc';
  users_id: number;
  chat_rooms_id: number;
  llms: {
    model_config: PostechModelConfig;
  };
  param_filters: {
    dept_code: string[];
    sclpst_code: string[];
    email_1: string[];
    user_id?: string[];
    nm?: string[];
  };
  queries: {
    type: 'text';
    text: string;
  };
  scenarios_id: string;
  sse_status_enabled: boolean;
  chat_threads_id?: number;
}

export interface SSEDocument {
  chat_threads_id?: number;
  replies?: {
    text?: string;
  };
}

export interface SSEData {
  data?: {
    documents?: SSEDocument[];
  };
}

// ============================================
// Authentication Types
// ============================================

export interface TokenInfo {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface UserInfo {
  userId: number;
  chatRoomId: number;
  scenarioId: string;
  email: string;
  deptCode: string;
  sclpstCode: string;
  userName?: string;  // user_id in param_filters
  name?: string;      // nm in param_filters
}

// ============================================
// Session Types
// ============================================

export interface Session {
  id: string;
  messages: Message[];
  model: string;
  threadId?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionMetadata {
  id: string;
  model: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  summary?: string;
}

// ============================================
// Tool Types
// ============================================

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  requiresConfirmation: boolean;
  riskLevel: 'low' | 'medium' | 'high';
}

export interface ToolParameter {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  required?: boolean;
  default?: unknown;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  name: string;
  result: string;
  success: boolean;
}

// ============================================
// Stream Types
// ============================================

export interface StreamChunk {
  type: 'text' | 'tool_call' | 'error' | 'done' | 'json_parse_error';
  content?: string;
  toolCall?: ToolCall;
  error?: string;
  threadId?: number;
}

// ============================================
// Configuration Types
// ============================================

export interface PopilotConfig {
  apiUrl: string;
  ssoUrl: string;
  callbackPattern: string;
  defaultModel: string;
  autoConfirm: boolean;
  maxTokens: number;
  theme: 'postech' | 'dark' | 'light';
}

export const DEFAULT_CONFIG: PopilotConfig = {
  apiUrl: 'https://genai.postech.ac.kr/v2/athena/chats/m1/queries',
  ssoUrl: 'https://genai.postech.ac.kr/auth/login',
  callbackPattern: 'genai.postech.ac.kr/auth/callback',
  defaultModel: 'claude-sonnet-4-5',
  autoConfirm: false,
  maxTokens: 4096,
  theme: 'postech',
};

// ============================================
// Event Types
// ============================================

export type PopilotEvent =
  | { type: 'stream_start' }
  | { type: 'stream_chunk'; chunk: StreamChunk }
  | { type: 'stream_end' }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_result'; result: ToolResult }
  | { type: 'error'; error: Error }
  | { type: 'auth_required' }
  | { type: 'auth_success' };
