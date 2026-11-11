/**
 * Retry logic utilities
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Stable status key used to replace the active retry countdown row. */
export const RETRY_STATUS_KEY = "pi-retry-backoff";

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
 * Parse a positive delay written with ordered day, hour, minute, and second units.
 *
 * @param input Duration such as `40m30s` or `1h 15m`.
 * @returns Delay in milliseconds, or undefined for an invalid or unsafe duration.
 *
 * TEST:__tests__/unit/retry-after.test.ts[duration parsing]
 */
export function parseRetryDuration(input: string): number | undefined {
  const match = /^\s*(?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s\s*)?$/i.exec(input);
  if (!match || !match.slice(1).some(Boolean)) return undefined;

  // Reject unsafe arithmetic rather than silently scheduling an inaccurate delay.
  const milliseconds = match.slice(1).reduce(
    (total, value, index) => total + Number(value ?? 0) * [86_400_000, 3_600_000, 60_000, 1_000][index]!,
    0,
  );
  return Number.isSafeInteger(milliseconds) && milliseconds > 0 ? milliseconds : undefined;
}

/**
 * Add optional user instructions to the first hidden retry or continuation turn.
 *
 * @param message Default retry or continuation instruction.
 * @param additionalPrompt Extra instructions supplied with `/retry-after`.
 * @returns The provider-visible message, unchanged when no instructions were supplied.
 *
 * TEST:__tests__/unit/retry-after.test.ts[additional prompt]
 */
export function appendRetryInstructions(message: string, additionalPrompt?: string): string {
  return additionalPrompt ? `${message}\n\nAdditional user instructions:\n${additionalPrompt}` : message;
}

/**
 * Format the single status-bar line used while a retry backoff is active.
 *
 * @param attempt Ordinary retry attempt number shown to the user.
 * @param remainingMs Milliseconds remaining before the hidden retry turn.
 * @returns Stable status text whose changing duration can replace one UI row.
 */
export function formatRetryCountdown(attempt: number, remainingMs: number): string {
  return `Retry attempt ${attempt} - retrying in ${formatDuration(Math.max(0, remainingMs))}`;
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
