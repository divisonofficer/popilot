/**
 * Session Service for Popilot
 * Manages conversation sessions with persistence
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type { Session, SessionMetadata, Message } from '../types.js';

export interface SessionServiceConfig {
  sessionsDir?: string;
  maxSessions?: number;
}

/**
 * Manages conversation sessions with file-based persistence.
 */
export class SessionService {
  private sessionsDir: string;
  private maxSessions: number;
  private currentSession: Session | null = null;

  constructor(config?: SessionServiceConfig) {
    this.sessionsDir = config?.sessionsDir ?? path.join(os.homedir(), '.popilot', 'sessions');
    this.maxSessions = config?.maxSessions ?? 50;

    // Ensure sessions directory exists
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });
    }
  }

  /**
   * Create a new session.
   */
  createSession(model: string): Session {
    const session: Session = {
      id: this.generateSessionId(),
      messages: [],
      model,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.currentSession = session;
    return session;
  }

  /**
   * Generate a unique session ID.
   */
  private generateSessionId(): string {
    const timestamp = Date.now().toString(36);
    const random = crypto.randomBytes(4).toString('hex');
    return `session-${timestamp}-${random}`;
  }

  /**
   * Get current session or create new one.
   */
  getCurrentSession(model: string): Session {
    if (!this.currentSession) {
      this.currentSession = this.createSession(model);
    }
    return this.currentSession;
  }

  /**
   * Add message to current session.
   */
  addMessage(message: Message): void {
    if (!this.currentSession) {
      throw new Error('No active session');
    }

    this.currentSession.messages.push(message);
    this.currentSession.updatedAt = new Date();
  }

  /**
   * Set thread ID for current session (for POSTECH API conversation continuity).
   */
  setThreadId(threadId: number): void {
    if (!this.currentSession) {
      throw new Error('No active session');
    }

    this.currentSession.threadId = threadId;
  }

  /**
   * Save current session to disk.
   */
  async saveSession(): Promise<string> {
    if (!this.currentSession) {
      throw new Error('No active session to save');
    }

    const filepath = path.join(this.sessionsDir, `${this.currentSession.id}.json`);
    const data = JSON.stringify(this.currentSession, null, 2);
    await fs.promises.writeFile(filepath, data, 'utf-8');

    // Cleanup old sessions if needed
    await this.cleanupOldSessions();

    return filepath;
  }

  /**
   * Load session from disk.
   */
  async loadSession(sessionId: string): Promise<Session> {
    const filepath = path.join(this.sessionsDir, `${sessionId}.json`);

    try {
      const data = await fs.promises.readFile(filepath, 'utf-8');
      const session = JSON.parse(data) as Session;

      // Convert date strings back to Date objects
      session.createdAt = new Date(session.createdAt);
      session.updatedAt = new Date(session.updatedAt);

      this.currentSession = session;
      return session;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Session not found: ${sessionId}`);
      }
      throw error;
    }
  }

  /**
   * List all saved sessions.
   */
  async listSessions(): Promise<SessionMetadata[]> {
    const files = await fs.promises.readdir(this.sessionsDir);
    const sessions: SessionMetadata[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      try {
        const filepath = path.join(this.sessionsDir, file);
        const data = await fs.promises.readFile(filepath, 'utf-8');
        const session = JSON.parse(data) as Session;

        sessions.push({
          id: session.id,
          model: session.model,
          messageCount: session.messages.length,
          createdAt: session.createdAt.toString(),
          updatedAt: session.updatedAt.toString(),
        });
      } catch {
        // Skip invalid session files
      }
    }

    // Sort by updated date, newest first
    sessions.sort((a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );

    return sessions;
  }

  /**
   * Delete a session.
   */
  async deleteSession(sessionId: string): Promise<void> {
    const filepath = path.join(this.sessionsDir, `${sessionId}.json`);

    try {
      await fs.promises.unlink(filepath);

      // Clear current session if it was deleted
      if (this.currentSession?.id === sessionId) {
        this.currentSession = null;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  /**
   * Clear current session without deleting saved file.
   */
  clearCurrentSession(): void {
    this.currentSession = null;
  }

  /**
   * Cleanup old sessions to keep under maxSessions limit.
   */
  private async cleanupOldSessions(): Promise<void> {
    const sessions = await this.listSessions();

    if (sessions.length > this.maxSessions) {
      // Delete oldest sessions
      const toDelete = sessions.slice(this.maxSessions);
      for (const session of toDelete) {
        await this.deleteSession(session.id);
      }
    }
  }

  /**
   * Get summary of current session for display.
   */
  getSessionSummary(): string | null {
    if (!this.currentSession) return null;

    const { messages, model, createdAt } = this.currentSession;
    const userMessages = messages.filter((m) => m.role === 'user').length;
    const assistantMessages = messages.filter((m) => m.role === 'assistant').length;

    return `Model: ${model}, Messages: ${userMessages} user / ${assistantMessages} assistant, Started: ${createdAt.toLocaleString()}`;
  }

  /**
   * Export session to markdown format.
   */
  exportToMarkdown(session?: Session): string {
    const s = session ?? this.currentSession;
    if (!s) throw new Error('No session to export');

    const lines: string[] = [
      `# Chat Session: ${s.id}`,
      `**Model:** ${s.model}`,
      `**Created:** ${s.createdAt.toLocaleString()}`,
      `**Updated:** ${s.updatedAt.toLocaleString()}`,
      '',
      '---',
      '',
    ];

    for (const msg of s.messages) {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      const roleLabel = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
      lines.push(`## ${roleLabel}\n`);
      lines.push(content);
      lines.push('\n---\n');
    }

    return lines.join('\n');
  }
}
