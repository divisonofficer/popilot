/**
 * POSTECH GenAI API Client
 * TypeScript port of continuedev/src/client/postech_client.py
 */

import {
  type ModelConfig,
  type PostechRequestPayload,
  type StreamChunk,
  type UserInfo,
  type SSEData,
  type FileAttachment,
} from '../types.js';

export class PostechClientError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public requestInfo?: {
      url: string;
      headers: Record<string, string>;
      bodyPreview: string;
    },
    public responseInfo?: {
      status: number;
      statusText: string;
      bodyPreview: string;
    }
  ) {
    super(message);
    this.name = 'PostechClientError';
  }

  /**
   * Get detailed error log string.
   */
  getDetailedLog(): string {
    const lines: string[] = [`Error: ${this.message}`];

    if (this.requestInfo) {
      lines.push('\n=== Request ===');
      lines.push(`URL: ${this.requestInfo.url}`);
      lines.push(`Headers: ${JSON.stringify(this.requestInfo.headers, null, 2)}`);
      lines.push(`Body (preview): ${this.requestInfo.bodyPreview}`);
    }

    if (this.responseInfo) {
      lines.push('\n=== Response ===');
      lines.push(`Status: ${this.responseInfo.status} ${this.responseInfo.statusText}`);
      lines.push(`Body (preview): ${this.responseInfo.bodyPreview}`);
    }

    return lines.join('\n');
  }
}

/**
 * Truncate string for logging (to avoid huge console output).
 */
function truncateForLog(str: string, maxLength: number = 500): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength) + '... [truncated]';
}

export type AuthMode = 'sso' | 'apikey';

export interface PostechClientConfig {
  apiUrl: string;
  baseUrl?: string;
  authMode?: AuthMode;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

/**
 * AI Agent info from chat-dashboard API.
 */
export interface AIAgent {
  id: number;
  name: string;
  description: string;
  categoryName: string;
  chatRoomId: number;
}

/**
 * Chat room creation response.
 */
export interface ChatRoomInfo {
  chatRoomsId: number;
  usersId: number;
}

/**
 * Async HTTP client for POSTECH GenAI API with SSE streaming support.
 */
export class PostechClient {
  private apiUrl: string;
  private baseUrl: string;
  private authMode: AuthMode;
  private timeoutMs: number;
  private maxRetries: number;
  private retryDelayMs: number;

  constructor(config: PostechClientConfig) {
    this.apiUrl = config.apiUrl;
    this.baseUrl = 'https://genai.postech.ac.kr';
    this.authMode = config.authMode ?? 'sso';
    this.timeoutMs = config.timeoutMs ?? 60000;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryDelayMs = config.retryDelayMs ?? 3000;
  }

  /**
   * Set auth mode dynamically.
   */
  setAuthMode(mode: AuthMode): void {
    this.authMode = mode;
  }

  /**
   * Get current auth mode.
   */
  getAuthMode(): AuthMode {
    return this.authMode;
  }

  /**
   * Build authorization headers based on auth mode.
   */
  private buildAuthHeaders(credential: string): Record<string, string> {
    if (this.authMode === 'apikey') {
      return { 'X-Api-Key': credential };
    }
    return { Authorization: `Bearer ${credential}` };
  }

  /**
   * Get available AI agents from chat-dashboard.
   */
  async getAIAgents(token: string): Promise<AIAgent[]> {
    const url = `${this.baseUrl}/v2/datahub/ai-agents/chat-dashboard`;

    console.log(`\n=== GET AI Agents ===`);
    console.log(`URL: ${url}`);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/plain, */*',
        Origin: this.baseUrl,
        Referer: `${this.baseUrl}/home`,
        'Cache-Control': 'no-store',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
      },
    });

    if (!response.ok) {
      throw new PostechClientError(
        `Failed to get AI agents: ${response.status} ${response.statusText}`,
        response.status
      );
    }

    const data = (await response.json()) as {
      data?: Array<{ aiAgents?: AIAgent[] }>;
    };
    console.log(`Response: ${JSON.stringify(data).slice(0, 200)}...`);

    // Extract agents from response
    const agents: AIAgent[] = [];
    if (data.data && Array.isArray(data.data)) {
      for (const category of data.data) {
        if (category.aiAgents && Array.isArray(category.aiAgents)) {
          agents.push(...category.aiAgents);
        }
      }
    }

    return agents;
  }

  /**
   * User profile from /users/me API.
   */
  async getUserProfile(token: string): Promise<{
    authUsersId: number;
    name: string;
    email: string;
    authServerUsername: string;
    attributes: {
      dept_code: string[];
      sclpst_code: string[];
      email_1: string[];
      user_id: string[];
      nm: string[];
    };
  }> {
    const url = `${this.baseUrl}/v2/identix/users/me`;

    console.log(`\n=== GET User Profile ===`);
    console.log(`URL: ${url}`);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/plain, */*',
        Origin: this.baseUrl,
        Referer: `${this.baseUrl}/home`,
        'Cache-Control': 'no-store',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
      },
    });

    if (!response.ok) {
      throw new PostechClientError(
        `Failed to get user profile: ${response.status} ${response.statusText}`,
        response.status
      );
    }

    interface UserProfileResponse {
      data?: {
        documents?: Array<{
          authUsersId: number;
          name: string;
          email: string;
          authServerUsername: string;
          attributes: {
            dept_code: string[];
            sclpst_code: string[];
            email_1: string[];
            user_id: string[];
            nm: string[];
          };
        }>;
      };
    }
    const data = (await response.json()) as UserProfileResponse;
    console.log(`Response: User ${data.data?.documents?.[0]?.name}`);

    if (data.data?.documents?.[0]) {
      return data.data.documents[0];
    }

    throw new PostechClientError('Invalid response from getUserProfile');
  }

  /**
   * Create a new chat room for an AI agent.
   */
  async createChatRoom(token: string, aiAgentsId: number): Promise<ChatRoomInfo> {
    const url = `${this.baseUrl}/v2/datahub/chat-rooms`;

    console.log(`\n=== Create Chat Room ===`);
    console.log(`URL: ${url}`);
    console.log(`Body: {"aiAgentsId": ${aiAgentsId}}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/plain, */*',
        Origin: this.baseUrl,
        Referer: `${this.baseUrl}/home`,
        'Cache-Control': 'no-store',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({ aiAgentsId }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new PostechClientError(
        `Failed to create chat room: ${response.status} ${response.statusText}`,
        response.status,
        {
          url,
          headers: {
            Authorization: 'Bearer ...',
            'Content-Type': 'application/json',
            Accept: 'application/json, text/plain, */*',
            Origin: this.baseUrl,
            Referer: `${this.baseUrl}/home`,
            'Cache-Control': 'no-store',
          },
          bodyPreview: `{"aiAgentsId": ${aiAgentsId}}`,
        },
        { status: response.status, statusText: response.statusText, bodyPreview: errorBody }
      );
    }

    const data = (await response.json()) as {
      data?: { chatRoomsId: number; usersId: number };
    };
    console.log(`Response: ${JSON.stringify(data)}`);

    if (data.data) {
      return {
        chatRoomsId: data.data.chatRoomsId,
        usersId: data.data.usersId,
      };
    }

    throw new PostechClientError('Invalid response from createChatRoom');
  }

  /**
   * Stream query to POSTECH API and yield chunks.
   * Automatically retries on JSON parsing errors.
   *
   * @param credential - SSO token or API key depending on auth mode
   */
  async *streamQuery(
    credential: string,
    payload: PostechRequestPayload,
    retryCount: number = 0
  ): AsyncGenerator<StreamChunk> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    // Prepare request info for logging
    const authHeaders = this.buildAuthHeaders(credential);
    const maskedCredential =
      this.authMode === 'apikey'
        ? `X-Api-Key: ${credential.slice(0, 8)}...`
        : `Bearer ${credential.slice(0, 20)}...`;
    const requestHeaders: Record<string, string> = {
      Authorization: maskedCredential,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };
    const bodyStr = JSON.stringify(payload);
    const requestInfo = {
      url: this.apiUrl,
      headers: requestHeaders,
      bodyPreview: truncateForLog(bodyStr, 300),
    };

    // Debug logging
    console.log('\n=== POSTECH API Request ===');
    console.log(`URL: ${this.apiUrl}`);
    console.log(`Auth Mode: ${this.authMode}`);
    console.log(`Body: ${truncateForLog(bodyStr, 500)}`);
    console.log('===========================\n');

    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          ...authHeaders,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'x-role-ratelimit-allowed': 'true',
          'x-role-ratelimit-token-limit': '22000000',
          'x-role-ratelimit-token-limit-interval': 'MONTHLY',
          'x-role-ratelimit-token-usage': '2000167',

          Origin: this.baseUrl,
          Referer: `${this.baseUrl}/home`,
          'Cache-Control': 'no-store',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
        },
        body: bodyStr,
        signal: controller.signal,
      });

      if (response.status === 401) {
        const errorBody = await response.text().catch(() => '');
        throw new PostechClientError('Authentication failed. Please re-login.', 401, requestInfo, {
          status: response.status,
          statusText: response.statusText,
          bodyPreview: truncateForLog(errorBody, 300),
        });
      }

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');

        // Check for JSON parsing error and retry
        if (
          errorBody.includes('failed to parse stringified json') &&
          retryCount < this.maxRetries
        ) {
          console.log(
            `\n⚠️ JSON parsing error detected. Retrying in ${this.retryDelayMs / 1000}s... (attempt ${retryCount + 1}/${this.maxRetries})`
          );
          clearTimeout(timeoutId);
          await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
          yield* this.streamQuery(credential, payload, retryCount + 1);
          return;
        }

        throw new PostechClientError(
          `HTTP error: ${response.status} ${response.statusText}`,
          response.status,
          requestInfo,
          {
            status: response.status,
            statusText: response.statusText,
            bodyPreview: truncateForLog(errorBody, 300),
          }
        );
      }

      if (!response.body) {
        throw new PostechClientError('No response body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          // Process any remaining data in buffer
          if (buffer.trim()) {
            const chunk = this.parseSSELine(buffer.trim());
            if (chunk) {
              // Check for JSON parse error in final chunk
              if (
                chunk.type === 'json_parse_error' &&
                chunk.threadId &&
                retryCount < this.maxRetries
              ) {
                console.log(
                  `\n⚠️ JSON parsing error in SSE. Retrying with threadId ${chunk.threadId}... (attempt ${retryCount + 1}/${this.maxRetries})`
                );
                await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
                const retryPayload = { ...payload, chat_threads_id: chunk.threadId };
                yield* this.streamQuery(credential, retryPayload, retryCount + 1);
                return;
              }
              yield chunk;
            }
          }
          break;
        }

        // Decode chunk and add to buffer
        buffer += decoder.decode(value, { stream: true });

        // Process complete lines from buffer
        while (buffer.includes('\n')) {
          const newlineIndex = buffer.indexOf('\n');
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);

          if (line) {
            const chunk = this.parseSSELine(line);
            if (chunk) {
              // JSON parsing error from backend - retry with threadId
              if (
                chunk.type === 'json_parse_error' &&
                chunk.threadId &&
                retryCount < this.maxRetries
              ) {
                console.log(
                  `\n⚠️ JSON parsing error in SSE. Retrying with threadId ${chunk.threadId}... (attempt ${retryCount + 1}/${this.maxRetries})`
                );
                reader.cancel(); // Close current stream
                await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
                const retryPayload = { ...payload, chat_threads_id: chunk.threadId };
                yield* this.streamQuery(credential, retryPayload, retryCount + 1);
                return;
              }
              yield chunk;
            }
          }
        }
      }

      yield { type: 'done' };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new PostechClientError('Request timed out', undefined, requestInfo);
      }
      // Re-throw PostechClientError as-is
      if (error instanceof PostechClientError) {
        throw error;
      }
      // Handle generic fetch errors (network issues, DNS, etc.)
      // Extract cause for detailed error info
      const cause = (error as { cause?: Error }).cause;
      const causeInfo = cause ? `\nCause: ${cause.name}: ${cause.message}` : '';
      const errorMessage = error instanceof Error ? error.message : String(error);

      throw new PostechClientError(
        `Network error: ${errorMessage}${causeInfo}`,
        undefined,
        requestInfo,
        undefined
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Parse SSE line and extract text content.
   * Also detects JSON parsing errors and extracts thread ID for retry.
   */
  private parseSSELine(line: string): StreamChunk | null {
    if (!line.startsWith('data:')) {
      return null;
    }

    const jsonStr = line.slice(5).trim();
    if (!jsonStr) return null;

    try {
      const parsed: SSEData = JSON.parse(jsonStr);
      const documents = parsed.data?.documents;

      if (documents && documents.length > 0) {
        const doc = documents[0];
        const text = doc.replies?.text;
        const threadId = doc.chat_threads_id;

        if (text) {
          // Detect JSON parsing error from backend
          if (text.includes('failed to parse stringified json')) {
            return {
              type: 'json_parse_error',
              error: text,
              threadId,
            };
          }
          return { type: 'text', content: text, threadId };
        }

        // Return threadId even if no text (for tracking)
        if (threadId) {
          return { type: 'text', content: '', threadId };
        }
      }
    } catch {
      // Non-JSON line, ignore
    }

    return null;
  }

  /**
   * Build request payload from messages and configuration.
   */
  static buildPayload(
    text: string,
    userInfo: UserInfo,
    model: ModelConfig,
    threadId?: number
  ): PostechRequestPayload {
    const paramFilters: PostechRequestPayload['param_filters'] = {
      dept_code: [userInfo.deptCode],
      sclpst_code: [userInfo.sclpstCode],
      email_1: [userInfo.email],
    };

    // Add optional fields if present
    if (userInfo.userName) {
      paramFilters.user_id = [userInfo.userName];
    }
    if (userInfo.name) {
      paramFilters.nm = [userInfo.name];
    }

    const payload: PostechRequestPayload = {
      app_type: 'browser',
      device_type: 'pc',
      users_id: userInfo.userId,
      chat_rooms_id: userInfo.chatRoomId,
      llms: {
        model_config: {
          provider: model.provider,
          model_name: model.modelName,
          deployment_name: model.deploymentName,
        },
      },
      param_filters: paramFilters,
      queries: {
        type: 'text',
        text,
      },
      scenarios_id: userInfo.scenarioId,
      sse_status_enabled: true,
    };

    if (threadId !== undefined) {
      payload.chat_threads_id = threadId;
    }

    return payload;
  }

  /**
   * Create a file object for A2 API from text content.
   * Uses data URI format to embed content directly.
   *
   * @param name - File name (e.g., "App.tsx")
   * @param content - File content as string
   * @param id - Optional unique ID (defaults to name)
   */
  static createFileFromContent(
    name: string,
    content: string,
    id?: string
  ): { id: string; name: string; url: string } {
    // Encode content as base64 data URI
    const base64Content = Buffer.from(content, 'utf-8').toString('base64');
    const mimeType = PostechClient.getMimeType(name);
    const dataUri = `data:${mimeType};base64,${base64Content}`;

    return {
      id: id || name,
      name,
      url: dataUri,
    };
  }

  /**
   * Get MIME type from file extension.
   */
  private static getMimeType(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    const mimeTypes: Record<string, string> = {
      'ts': 'text/typescript',
      'tsx': 'text/typescript',
      'js': 'text/javascript',
      'jsx': 'text/javascript',
      'json': 'application/json',
      'py': 'text/x-python',
      'java': 'text/x-java',
      'c': 'text/x-c',
      'cpp': 'text/x-c++',
      'h': 'text/x-c',
      'go': 'text/x-go',
      'rs': 'text/x-rust',
      'md': 'text/markdown',
      'txt': 'text/plain',
      'html': 'text/html',
      'css': 'text/css',
      'xml': 'application/xml',
      'yaml': 'application/x-yaml',
      'yml': 'application/x-yaml',
    };
    return mimeTypes[ext] || 'text/plain';
  }

  /**
   * Simple query for a2 API endpoints (API key mode).
   * Uses simpler payload format: { message, stream, files }
   *
   * @param apiKey - API key for X-Api-Key header
   * @param message - The message to send
   * @param model - Model name ('gemini', 'gpt', 'claude')
   * @param stream - Whether to stream response (default: false)
   * @param files - Optional file attachments with { id, name, url } (url is required by A2 API)
   */
  async *streamQueryA2(
    apiKey: string,
    message: string,
    model: 'gemini' | 'gpt' | 'claude' = 'gemini',
    stream: boolean = true,
    files: Array<{ id: string; name: string; url: string }> = []
  ): AsyncGenerator<StreamChunk> {
    // GPT: a1, Gemini: a2, Claude: a3
    const apiVersion = model === 'gpt' ? 1 : model === 'gemini' ? 2 : 3;
    const a2Url = `${this.baseUrl}/agent/api/a${apiVersion}/${model}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    const payload = {
      message,
      stream,
      files,
    };
    const bodyStr = JSON.stringify(payload);

    console.log('\n=== A2 API Request ===');
    console.log(`URL: ${a2Url}`);
    console.log(`Model: ${model}`);
    console.log(`Message: ${message.slice(0, 100)}...`);
    if (files.length > 0) {
      console.log(`Files attached: ${files.length} (${files.map(f => f.name).join(', ')})`);
    }
    console.log('======================\n');

    try {
      const response = await fetch(a2Url, {
        method: 'POST',
        headers: {
          'X-Api-Key': apiKey,
          'Content-Type': 'application/json',
          Accept: stream ? 'text/event-stream' : 'application/json',
        },
        body: bodyStr,
        signal: controller.signal,
      });

      if (response.status === 401) {
        throw new PostechClientError('Invalid API key', 401);
      }

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new PostechClientError(
          `A2 API error: ${response.status} ${response.statusText}\n→ URL: ${a2Url}\n→ Body: ${bodyStr}`,
          response.status,
          { url: a2Url, headers: { 'X-Api-Key': '...' }, bodyPreview: bodyStr },
          { status: response.status, statusText: response.statusText, bodyPreview: errorBody }
        );
      }

      if (stream && response.body) {
        // Handle SSE streaming
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            if (buffer.trim()) {
              yield { type: 'text', content: buffer };
            }
            break;
          }

          buffer += decoder.decode(value, { stream: true });

          // Process complete lines
          while (buffer.includes('\n')) {
            const newlineIndex = buffer.indexOf('\n');
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);

            if (line.startsWith('data:')) {
              const data = line.slice(5).trim();
              if (data) {
                try {
                  const parsed = JSON.parse(data);
                  if (parsed.replies) {
                    yield { type: 'text', content: parsed.replies };
                  }
                } catch {
                  // Plain text chunk
                  yield { type: 'text', content: data };
                }
              }
            }
          }
        }
      } else {
        // Non-streaming response
        const data = (await response.json()) as { replies?: string };
        if (data.replies) {
          yield { type: 'text', content: data.replies };
        }
      }

      yield { type: 'done' };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new PostechClientError('Request timed out');
      }
      if (error instanceof PostechClientError) {
        throw error;
      }
      throw new PostechClientError(
        `Network error: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Simple non-streaming query for a2 API.
   */
  async queryA2(
    apiKey: string,
    message: string,
    model: 'gemini' | 'gpt' | 'claude' = 'gemini'
  ): Promise<string> {
    const a2Url = `${this.baseUrl}/agent/api/a${model === 'gpt' ? 1 : model === 'gemini' ? 2 : 3}/${model}`;

    const response = await fetch(a2Url, {
      method: 'POST',
      headers: {
        'X-Api-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message,
        stream: false,
        files: [],
      }),
    });

    if (!response.ok) {
      throw new PostechClientError(
        `A2 API error: ${response.status} ${response.statusText}`,
        response.status
      );
    }

    const data = (await response.json()) as { replies?: string };
    return data.replies || '';
  }
}
