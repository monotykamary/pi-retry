/**
 * Error pattern matching utilities for retry extensions
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { calculateDelay as _calculateDelay, formatDuration as _formatDuration } from "./retry-logic.js";

// Re-export retry utilities from error-patterns for convenience
export { _calculateDelay as calculateDelay, _formatDuration as formatDuration };

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

// Patterns handled by pi's built-in retry (we may want to skip these)
export const BUILTIN_HANDLED_PATTERNS = [
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
 * Check if error is handled by pi's built-in retry
 */
export function isBuiltinHandledError(errorMessage: string): boolean {
  return BUILTIN_HANDLED_PATTERNS.some(pattern => pattern.test(errorMessage));
}

/**
 * Get error category for logging/display
 */
export function getErrorCategory(errorMessage: string): '400-413' | 'connection' | 'builtin' | 'other' {
  if (ERROR_400_413_PATTERNS.some(p => p.test(errorMessage))) return '400-413';
  if (CONNECTION_ERROR_PATTERNS.some(p => p.test(errorMessage))) return 'connection';
  if (BUILTIN_HANDLED_PATTERNS.some(p => p.test(errorMessage))) return 'builtin';
  return 'other';
}

// Re-export getLastAssistantMessage for convenience
export { getLastAssistantMessage } from './retry-logic.js';
