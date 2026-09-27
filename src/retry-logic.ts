/**
 * Retry logic utilities
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Configuration for exponential backoff
 */export interface BackoffConfig {
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
