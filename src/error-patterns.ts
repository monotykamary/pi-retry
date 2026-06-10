/**
 * Error pattern matching utilities for retry extensions
 *
 * Philosophy: retry EVERY error by default.  The only things we skip are a
 * tiny blacklist of known permanent failures (e.g. invalid API key, model
 * does not exist).  Everything else — 400s, connection issues, credit errors,
 * stream exhaustion, provider hiccups, unknown errors — is retried.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

// ── Specific pattern groups (used for categorisation / messaging) ──

const ERROR_400_413_PATTERNS = [
  /\b4(00|13)\b.*status code/i,
  /bad request/i,
  /payload too large/i,
];

const CREDIT_ERROR_PATTERNS = [
  /not enough credits/i,
  /insufficient credits/i,
  /insufficient balance/i,
  /out of credits/i,
  /payment required/i,
  /\b402\b.*status code/i,
];

export const CONNECTION_ERROR_PATTERNS = [
  /connection\s*error/i,
  /network\s*error/i,
  /fetch\s*failed/i,
  /socket\s*(hang\s*up|error|timeout)/i,
  /econnreset/i,
  /econnrefused/i,
  /etimedout/i,
  /enotfound/i,
  /dns\s*lookup\s*failed/i,
  /request\s*ended\s*without\s*sending\s*any\s*chunks/i,
  /upstream\s*connect/i,
  /other\s*side\s*closed/i,
  /reset\s*before\s*headers/i,
  /broken\s*pipe/i,
  /unexpected\s*end\s*of\s*file/i,
  /tls\s*handshake\s*(error|timeout)/i,
  /ssl\s*connection\s*error/i,
  /timeout\s*(awaiting|waiting\s*for)\s*response/i,
  /request\s*timeout/i,
  // Stream exhaustion (e.g. "Max outbound streams is 100, 100 open")
  /max outbound streams/i,
  /streams?\s*(exhausted|limit)/i,
];

// Patterns handled by pi's built-in retry — used for categorisation only
const BUILTIN_HANDLED_PATTERNS = [
  /overloaded/i,
  /rate\s*limit/i,
  /too\s*many\s*requests/i,
  /429/i,
  /5\d{2}/,
  /service\s*unavailable/i,
  /server\s*error/i,
  /internal\s*error/i,
  /retry\s*delay/i,
];

// ── Blacklist: errors that are truly permanent and should NOT be retried ──

const NON_RETRYABLE_PATTERNS = [
  /invalid\s*api\s*key/i,
  /invalid\s*authentication/i,
  /api\s*key\s*(not\s*found|missing|revoked)/i,
  /model\s*not\s*found/i,
  /unknown\s*model/i,
  /no\s*such\s*model/i,
  /model\s*does\s*not\s*exist/i,
  /unsupported\s*model/i,
  /cannot continue from message role/i,
];

// Errors that are non-retryable AND should be silently ignored (no notification)
const SILENCED_PATTERNS = [
  /cannot continue from message role/i,
];

// ── Type guard ──

export function isAssistantMessage(message: AgentMessage): message is Extract<AgentMessage, { role: "assistant" }> {
  return message.role === "assistant";
}

// ── Specific category checks (for diagnostics / messaging) ──

export function has400or413Error(message: AgentMessage): boolean {
  if (!isAssistantMessage(message)) return false;
  if (message.stopReason !== "error" || !message.errorMessage) return false;
  return ERROR_400_413_PATTERNS.some(p => p.test(message.errorMessage!));
}

export function hasCreditError(message: AgentMessage): boolean {
  if (!isAssistantMessage(message)) return false;
  if (message.stopReason !== "error" || !message.errorMessage) return false;
  return CREDIT_ERROR_PATTERNS.some(p => p.test(message.errorMessage!));
}

export function hasConnectionError(message: AgentMessage): boolean {
  if (!isAssistantMessage(message)) return false;
  if (message.stopReason !== "error" || !message.errorMessage) return false;
  return CONNECTION_ERROR_PATTERNS.some(p => p.test(message.errorMessage!));
}

// ── Universal retry check ──

/**
 * Returns true for ANY assistant message with stopReason === "error"
 * except a tiny blacklist of known permanent failures.
 */
export function hasRetryableError(message: AgentMessage): boolean {
  if (!isAssistantMessage(message)) return false;
  if (message.stopReason !== "error" || !message.errorMessage) return false;
  return !NON_RETRYABLE_PATTERNS.some(p => p.test(message.errorMessage!));
}

/**
 * Returns true only for known permanent failures (invalid API key, missing model, etc.)
 */
export function isNonRetryableError(message: AgentMessage): boolean {
  if (!isAssistantMessage(message)) return false;
  if (message.stopReason !== "error" || !message.errorMessage) return false;
  return NON_RETRYABLE_PATTERNS.some(p => p.test(message.errorMessage!));
}

/**
 * Returns true for errors that are non-retryable and should be silently
 * ignored (no UI notification). These are provider-level refusals that
 * the user cannot act on and that would only add noise.
 */
export function isSilencedError(message: AgentMessage): boolean {
  if (!isAssistantMessage(message)) return false;
  if (message.stopReason !== "error" || !message.errorMessage) return false;
  return SILENCED_PATTERNS.some(p => p.test(message.errorMessage!));
}

// ── Categorisation (for UI messages) ──

export function getErrorCategory(errorMessage: string): '400-413' | 'credit' | 'connection' | 'builtin' | 'other' {
  if (ERROR_400_413_PATTERNS.some(p => p.test(errorMessage))) return '400-413';
  if (CREDIT_ERROR_PATTERNS.some(p => p.test(errorMessage))) return 'credit';
  if (CONNECTION_ERROR_PATTERNS.some(p => p.test(errorMessage))) return 'connection';
  if (BUILTIN_HANDLED_PATTERNS.some(p => p.test(errorMessage))) return 'builtin';
  return 'other';
}

// ── Max tokens (not an error — continuation) ──

export function hasMaxTokensStop(message: AgentMessage): boolean {
  if (!isAssistantMessage(message)) return false;
  return message.stopReason === "length";
}

// Re-export getLastAssistantMessage for convenience
export { getLastAssistantMessage } from './retry-logic.js';
