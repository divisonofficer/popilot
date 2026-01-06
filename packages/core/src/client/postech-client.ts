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

export interface PostechClientConfig {
  apiUrl: string;
  baseUrl?: string;
  timeoutMs?: number;
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
  private timeoutMs: number;

  constructor(config: PostechClientConfig) {
    this.apiUrl = config.apiUrl;
    this.baseUrl = config.baseUrl ?? 'https://genai.postech.ac.kr';
    this.timeoutMs = config.timeoutMs ?? 60000;
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
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'Origin': this.baseUrl,
        'Referer': `${this.baseUrl}/home`,
        'Cache-Control': 'no-store',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
      },
    });

    if (!response.ok) {
      throw new PostechClientError(
        `Failed to get AI agents: ${response.status} ${response.statusText}`,
        response.status
      );
    }

    const data = await response.json() as {
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
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'Origin': this.baseUrl,
        'Referer': `${this.baseUrl}/home`,
        'Cache-Control': 'no-store',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
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
    const data = await response.json() as UserProfileResponse;
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
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'Origin': this.baseUrl,
        'Referer': `${this.baseUrl}/home`,
        'Cache-Control': 'no-store',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
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
            'Authorization': 'Bearer ...',
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/plain, */*',
            'Origin': this.baseUrl,
            'Referer': `${this.baseUrl}/home`,
            'Cache-Control': 'no-store',
          },
          bodyPreview: `{"aiAgentsId": ${aiAgentsId}}`,
        },
        { status: response.status, statusText: response.statusText, bodyPreview: errorBody }
      );
    }

    const data = await response.json() as {
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
   */
  async *streamQuery(
    token: string,
    payload: PostechRequestPayload
  ): AsyncGenerator<StreamChunk> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    // Prepare request info for logging
    const requestHeaders = {
      Authorization: `Bearer ${token.slice(0, 20)}...`, // Mask token
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
    console.log(`Body: ${truncateForLog(bodyStr, 500)}`);
    console.log('===========================\n');

    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'Origin': this.baseUrl,
          'Referer': `${this.baseUrl}/home`,
          'Cache-Control': 'no-store',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
        },
        body: bodyStr,
        signal: controller.signal,
      });

      if (response.status === 401) {
        const errorBody = await response.text().catch(() => '');
        throw new PostechClientError(
          'Authentication failed. Please re-login.',
          401,
          requestInfo,
          {
            status: response.status,
            statusText: response.statusText,
            bodyPreview: truncateForLog(errorBody, 300),
          }
        );
      }

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
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
            if (chunk) yield chunk;
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
            if (chunk) yield chunk;
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
      const causeInfo = cause
        ? `\nCause: ${cause.name}: ${cause.message}`
        : '';
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
        const text = documents[0].replies?.text;
        if (text) {
          return { type: 'text', content: text };
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
}
