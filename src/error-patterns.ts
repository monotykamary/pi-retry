/**
 * Error pattern matching utilities for retry extensions
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

// Custom message types for invisible triggers.
// These are sent with role="custom" and display=false, so pi's default
// convertToLlm filters them out.  The context event handler also strips
// them as insurance.

/** Custom type used for the invisible error-retry trigger. */
export const RETRY_TRIGGER_CUSTOM_TYPE = "__retry_trigger";

/** Custom type used for the invisible max_tokens continuation trigger. */
export const CONTINUATION_CUSTOM_TYPE = "__retry_continuation";

// 400/413 error patterns
const ERROR_400_413_PATTERNS = [
  /\b4(00|13)\b.*status code/i,
  /bad request/i,
  /payload too large/i,
];

// Connection error patterns
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
];

// Patterns handled by pi's built-in retry — used internally by getErrorCategory
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

/**
 * Type guard to check if message is an AssistantMessage
 */
export function isAssistantMessage(message: AgentMessage): message is Extract<AgentMessage, { role: "assistant" }> {
  return message.role === "assistant";
}

/**
 * Check if an assistant message has a 400 or 413 error
 */
export function has400or413Error(message: AgentMessage): boolean {
  if (!isAssistantMessage(message)) return false;
  if (message.stopReason !== "error" || !message.errorMessage) return false;
  
  const errorMsg = message.errorMessage;
  return ERROR_400_413_PATTERNS.some(pattern => pattern.test(errorMsg));
}

/**
 * Check if an assistant message has a connection error
 */
export function hasConnectionError(message: AgentMessage): boolean {
  if (!isAssistantMessage(message)) return false;
  if (message.stopReason !== "error" || !message.errorMessage) return false;
  
  const errorMsg = message.errorMessage;
  return CONNECTION_ERROR_PATTERNS.some(pattern => pattern.test(errorMsg));
}

/**
 * Get error category for logging/display
 */
export function getErrorCategory(errorMessage: string): '400-413' | 'connection' | 'other' {
  if (ERROR_400_413_PATTERNS.some(p => p.test(errorMessage))) return '400-413';
  if (CONNECTION_ERROR_PATTERNS.some(p => p.test(errorMessage))) return 'connection';
  return 'other';
}

/**
 * Check if an assistant message stopped because it hit max output tokens.
 * This is NOT an error — the model simply ran out of its token budget.
 * stopReason "length" maps to max_tokens/finish_reason_length across providers.
 */
export function hasMaxTokensStop(message: AgentMessage): boolean {
  if (!isAssistantMessage(message)) return false;
  return message.stopReason === "length";
}

// Re-export getLastAssistantMessage for convenience
export { getLastAssistantMessage } from './retry-logic.js';
