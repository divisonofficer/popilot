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
  constructor(message: string, public statusCode?: number) {
    super(message);
    this.name = 'PostechClientError';
  }
}

export interface PostechClientConfig {
  apiUrl: string;
  timeoutMs?: number;
}

/**
 * Async HTTP client for POSTECH GenAI API with SSE streaming support.
 */
export class PostechClient {
  private apiUrl: string;
  private timeoutMs: number;

  constructor(config: PostechClientConfig) {
    this.apiUrl = config.apiUrl;
    this.timeoutMs = config.timeoutMs ?? 60000;
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

    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (response.status === 401) {
        throw new PostechClientError('Authentication failed. Please re-login.', 401);
      }

      if (!response.ok) {
        throw new PostechClientError(
          `HTTP error: ${response.status} ${response.statusText}`,
          response.status
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
        throw new PostechClientError('Request timed out');
      }
      throw error;
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
    const payload: PostechRequestPayload = {
      app_type: 'browser',
      device_type: 'pc',
      users_id: userInfo.userId,
      chat_rooms_id: userInfo.chatRoomId,
      llms: {
        model_config: model,
      },
      param_filters: {
        dept_code: [userInfo.deptCode],
        sclpst_code: [userInfo.sclpstCode],
        email_1: [userInfo.email],
      },
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
