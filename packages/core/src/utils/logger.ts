/**
 * Debug Logger for Popilot
 * Logs all API requests/responses to .popilot/log folder
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export class DebugLogger {
  private logDir: string;
  private sessionId: string;
  private enabled: boolean;

  constructor(workingDir: string, enabled: boolean = true) {
    this.logDir = path.join(workingDir, '.popilot', 'log');
    this.sessionId = new Date().toISOString().replace(/[:.]/g, '-');
    this.enabled = enabled;

    if (this.enabled) {
      this.ensureLogDir();
    }
  }

  private ensureLogDir(): void {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  private getLogPath(type: string, iteration: number): string {
    // Use .json extension for request logs to validate JSON parsing
    const extension = type === 'request' ? 'json' : 'log';
    return path.join(this.logDir, `${this.sessionId}_${iteration.toString().padStart(3, '0')}_${type}.${extension}`);
  }

  /**
   * Log API request payload
   */
  logRequest(iteration: number, payload: unknown): void {
    if (!this.enabled) return;

    const logPath = this.getLogPath('request', iteration);
    const content = JSON.stringify(payload, null, 2);
    fs.writeFileSync(logPath, content, 'utf-8');
    console.log(`📝 Request logged: ${logPath}`);
  }

  /**
   * Log A2 API request (simpler format)
   */
  logA2Request(iteration: number, message: string, model: string, files: unknown[], threadId?: number | null): void {
    if (!this.enabled) return;

    const logPath = this.getLogPath('a2_request', iteration);
    const payload = {
      model,
      thread_id: threadId ?? null,
      message_length: message.length,
      message_preview: message.slice(0, 500) + (message.length > 500 ? '...' : ''),
      files_count: files.length,
      files: files.map((f: unknown) => {
        const file = f as { id?: string; name?: string; url?: string };
        return {
          id: file.id,
          name: file.name,
          url_length: file.url?.length ?? 0,
          url_preview: file.url?.slice(0, 100) + '...',
        };
      }),
      full_message: message,
      timestamp: new Date().toISOString(),
    };
    const content = JSON.stringify(payload, null, 2);
    fs.writeFileSync(logPath, content, 'utf-8');
    console.log(`📝 A2 Request logged: ${logPath} (${files.length} files, threadId=${threadId ?? 'null'})`);
  }

  /**
   * Log raw API response
   */
  logResponse(iteration: number, rawResponse: string): void {
    if (!this.enabled) return;

    const logPath = this.getLogPath('response', iteration);
    fs.writeFileSync(logPath, rawResponse, 'utf-8');
    console.log(`📝 Response logged: ${logPath}`);
  }

  /**
   * Log parsed tool calls
   */
  logToolCalls(iteration: number, toolCalls: unknown[]): void {
    if (!this.enabled) return;

    const logPath = this.getLogPath('tools', iteration);
    const content = JSON.stringify(toolCalls, null, 2);
    fs.writeFileSync(logPath, content, 'utf-8');
    console.log(`📝 Tool calls logged: ${logPath} (${toolCalls.length} calls)`);
  }

  /**
   * Log tool execution result
   */
  logToolResult(iteration: number, toolName: string, args: unknown, result: string): void {
    if (!this.enabled) return;

    const logPath = this.getLogPath(`tool_${toolName}`, iteration);
    const content = `=== Tool: ${toolName} ===
=== Args ===
${JSON.stringify(args, null, 2)}

=== Result ===
${result}
`;
    fs.writeFileSync(logPath, content, 'utf-8');
  }

  /**
   * Log error
   */
  logError(iteration: number, error: Error | string): void {
    if (!this.enabled) return;

    const logPath = this.getLogPath('error', iteration);
    const content = error instanceof Error
      ? `${error.name}: ${error.message}\n\n${error.stack}`
      : String(error);
    fs.writeFileSync(logPath, content, 'utf-8');
    console.log(`❌ Error logged: ${logPath}`);
  }

  /**
   * Log conversation state
   */
  logConversation(iteration: number, messages: unknown[]): void {
    if (!this.enabled) return;

    const logPath = this.getLogPath('conversation', iteration);
    const content = JSON.stringify(messages, null, 2);
    fs.writeFileSync(logPath, content, 'utf-8');
  }

  /**
   * Log iteration lifecycle event
   */
  logIteration(iteration: number, event: 'start' | 'end' | 'aborted', details?: string): void {
    if (!this.enabled) return;

    const logPath = this.getLogPath('lifecycle', iteration);
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${event.toUpperCase()}${details ? `: ${details}` : ''}\n`;

    // Append to lifecycle log
    fs.appendFileSync(logPath, line, 'utf-8');

    if (event === 'aborted') {
      console.log(`⚠️ Iteration ${iteration} aborted: ${details}`);
    }
  }

  /**
   * Log loop completion status
   */
  logLoopEnd(reason: 'completed' | 'max_iterations' | 'error' | 'unexpected', finalIteration: number, details?: string): void {
    if (!this.enabled) return;

    const logPath = this.getLogPath('loop_end', 0);
    const timestamp = new Date().toISOString();
    const content = `[${timestamp}] Loop ended
Reason: ${reason}
Final iteration: ${finalIteration}
Details: ${details || 'none'}
`;
    fs.writeFileSync(logPath, content, 'utf-8');
    console.log(`🏁 Loop ended: ${reason} at iteration ${finalIteration}${details ? ` - ${details}` : ''}`);
  }

  /**
   * Get log directory path
   */
  getLogDir(): string {
    return this.logDir;
  }

  /**
   * Log thread ID operations (for A2 API conversation continuity)
   */
  logThreadId(iteration: number, action: 'fetch' | 'use' | 'save', threadId: number | null, details?: string): void {
    if (!this.enabled) return;

    const logPath = this.getLogPath('thread_id', iteration);
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${action.toUpperCase()}: threadId=${threadId ?? 'null'}${details ? ` - ${details}` : ''}\n`;
    fs.appendFileSync(logPath, line, 'utf-8');
    console.log(`🧵 Thread ID ${action}: ${threadId ?? 'null'}${details ? ` (${details})` : ''}`);
  }

  /**
   * Get log statistics (file count and total size)
   */
  getLogStats(): { fileCount: number; totalSize: number; oldestFile?: string; newestFile?: string } {
    if (!fs.existsSync(this.logDir)) {
      return { fileCount: 0, totalSize: 0 };
    }

    const files = fs.readdirSync(this.logDir).filter(f => f.endsWith('.log') || f.endsWith('.json'));
    let totalSize = 0;
    let oldestTime = Infinity;
    let newestTime = 0;
    let oldestFile: string | undefined;
    let newestFile: string | undefined;

    for (const file of files) {
      const filepath = path.join(this.logDir, file);
      const stat = fs.statSync(filepath);
      totalSize += stat.size;

      if (stat.mtimeMs < oldestTime) {
        oldestTime = stat.mtimeMs;
        oldestFile = file;
      }
      if (stat.mtimeMs > newestTime) {
        newestTime = stat.mtimeMs;
        newestFile = file;
      }
    }

    return { fileCount: files.length, totalSize, oldestFile, newestFile };
  }

  /**
   * Archive all log files to a timestamped subfolder
   */
  archiveLogs(): { success: boolean; archiveDir?: string; fileCount?: number; error?: string } {
    if (!fs.existsSync(this.logDir)) {
      return { success: false, error: 'Log directory does not exist' };
    }

    const files = fs.readdirSync(this.logDir).filter(f =>
      (f.endsWith('.log') || f.endsWith('.json')) && !fs.statSync(path.join(this.logDir, f)).isDirectory()
    );

    if (files.length === 0) {
      return { success: false, error: 'No log files to archive' };
    }

    // Create archive directory with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const archiveDir = path.join(this.logDir, `archive_${timestamp}`);
    fs.mkdirSync(archiveDir, { recursive: true });

    // Move files to archive
    for (const file of files) {
      const src = path.join(this.logDir, file);
      const dest = path.join(archiveDir, file);
      fs.renameSync(src, dest);
    }

    console.log(`📦 Archived ${files.length} log files to ${archiveDir}`);
    return { success: true, archiveDir, fileCount: files.length };
  }

  /**
   * Delete all log files (not archived)
   */
  deleteLogs(): { success: boolean; fileCount?: number; error?: string } {
    if (!fs.existsSync(this.logDir)) {
      return { success: false, error: 'Log directory does not exist' };
    }

    const files = fs.readdirSync(this.logDir).filter(f => {
      const filepath = path.join(this.logDir, f);
      return (f.endsWith('.log') || f.endsWith('.json')) && !fs.statSync(filepath).isDirectory();
    });

    if (files.length === 0) {
      return { success: false, error: 'No log files to delete' };
    }

    // Delete files
    for (const file of files) {
      fs.unlinkSync(path.join(this.logDir, file));
    }

    console.log(`🗑️ Deleted ${files.length} log files`);
    return { success: true, fileCount: files.length };
  }

  /**
   * List archived folders
   */
  listArchives(): string[] {
    if (!fs.existsSync(this.logDir)) {
      return [];
    }

    return fs.readdirSync(this.logDir)
      .filter(f => f.startsWith('archive_') && fs.statSync(path.join(this.logDir, f)).isDirectory())
      .sort()
      .reverse(); // Newest first
  }
}
