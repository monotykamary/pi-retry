/**
 * Retry logic utilities
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";

/**
 * Configuration for exponential backoff
 */
export interface BackoffConfig {
  baseDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
}

/**
 * Default backoff configuration
 */
export const DEFAULT_BACKOFF_CONFIG: BackoffConfig = {
  baseDelayMs: 2000,
  maxDelayMs: 60000,
  multiplier: 2,
};

/**
 * Calculate delay with exponential backoff and cap
 */
export function calculateDelay(attempt: number, config: BackoffConfig = DEFAULT_BACKOFF_CONFIG): number {
  const delay = config.baseDelayMs * Math.pow(config.multiplier, attempt - 1);
  return Math.min(delay, config.maxDelayMs);
}

/**
 * Format duration for display
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(0);
  return `${minutes}m ${seconds}s`;
}

/**
 * Type guard for user message with content
 */
export function isUserMessageWithContent(
  message: AgentMessage
): message is Extract<AgentMessage, { role: "user" }> & { content: (TextContent | ImageContent)[] | string } {
  return message.role === "user" && "content" in message;
}

/**
 * Type guard for text content
 */
export function isTextContent(
  c: TextContent | ImageContent | unknown
): c is { type: "text"; text: string } {
  return typeof c === "object" && c !== null && "type" in c && c.type === "text" && "text" in c;
}

/**
 * Extract text content from message content array
 */
export function extractTextContent(
  content: (TextContent | ImageContent)[] | string | undefined
): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter(isTextContent)
    .map(c => c.text)
    .join("");
}

/**
 * Get the last assistant message from session entries
 */
export function getLastAssistantMessage(entries: unknown[]): AgentMessage | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type?: string; message?: AgentMessage };
    if (entry.type === "message" && entry.message?.role === "assistant") {
      return entry.message;
    }
  }
  return undefined;
}

/**
 * Retry state manager for tracking attempts
 */
export class RetryState {
  private attempt = 0;
  private isRetrying = false;
  private lastErrorMessage = "";

  getAttempt(): number {
    return this.attempt;
  }

  getIsRetrying(): boolean {
    return this.isRetrying;
  }

  getLastErrorMessage(): string {
    return this.lastErrorMessage;
  }

  startRetry(errorMessage: string): void {
    this.isRetrying = true;
    this.attempt++;
    this.lastErrorMessage = errorMessage;
  }

  endRetry(): void {
    this.isRetrying = false;
  }

  reset(): void {
    this.attempt = 0;
    this.isRetrying = false;
    this.lastErrorMessage = "";
  }

  succeed(): void {
    this.attempt = 0;
    this.isRetrying = false;
    this.lastErrorMessage = "";
  }
}

/**
 * State manager for tracking max_tokens continuations.
 *
 * Unlike RetryState (which caps nothing but counts retries), continuations are
 * also uncapped — each one produces valid output and the model naturally
 * terminates when done, so there is no reason to impose a limit.
 */
export class ContinuationState {
  private count = 0;
  private isContinuing = false;

  getCount(): number {
    return this.count;
  }

  getIsContinuing(): boolean {
    return this.isContinuing;
  }

  startContinuation(): void {
    this.isContinuing = true;
    this.count++;
  }

  endContinuation(): void {
    this.isContinuing = false;
  }

  /**
   * Called when a turn completes without hitting max_tokens.
   * Resets the counter since the model finished normally.
   */
  complete(): void {
    this.count = 0;
    this.isContinuing = false;
  }

  reset(): void {
    this.count = 0;
    this.isContinuing = false;
  }
}
