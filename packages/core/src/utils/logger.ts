/**
 * Debug Logger for Popilot
 * Logs all API requests/responses to .popilot_log folder
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export class DebugLogger {
  private logDir: string;
  private sessionId: string;
  private enabled: boolean;

  constructor(workingDir: string, enabled: boolean = true) {
    this.logDir = path.join(workingDir, '.popilot_log');
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
}
