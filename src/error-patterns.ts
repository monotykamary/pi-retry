/**
 * Error pattern matching utilities for retry extensions
 *
 * Philosophy: retry EVERY error by default.  The only things we skip are a
 * tiny blacklist of known permanent failures (e.g. invalid API key, model
 * does not exist).  Everything else — 400s, connection issues, credit errors,
 * stream exhaustion, provider hiccups, unknown errors — is retried.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const RETRY_TRIGGER_CUSTOM_TYPE = "pi-retry:retry";
export const CONTINUATION_CUSTOM_TYPE = "pi-retry:continue";

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

// Context-overflow error patterns. Mirrors pi-core's OVERFLOW_PATTERNS in
// @earendil-works/pi-ai/dist/utils/overflow.js so that pi-retry defers to
// compaction exactly when pi-core's _checkCompaction will detect overflow and
// compact + retry. kept in sync manually — pi-ai is not a direct dependency.
//
// Why these are NOT retried by pi-retry: a hidden retry turn would re-send
// the same oversized context, so it overflows again → infinite loop
// (pi-retry's loop is uncapped for errors). pi-core instead compacts and
// retries once via agent.continue(); with static compaction (pi-vcc) that
// reliably reduces context, so the single retry succeeds.
const OVERFLOW_ERROR_PATTERNS = [
  /prompt is too long/i,
  /request_too_large/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,
  /input token count.*exceeds the maximum/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /too large for model with \d+ maximum context length/i,
  /model_context_window_exceeded/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /context[_ ]length[_ ]exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
  /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i,
];

// Patterns that look like overflow but are actually rate limiting / throttling.
// Mirrors pi-core's NON_OVERFLOW_PATTERNS. Excluded from overflow detection so
// throttling errors are still retried (they are not context-size problems).
const NON_OVERFLOW_PATTERNS = [
  /^(Throttling error|Service unavailable):/i,
  /rate limit/i,
  /too many requests/i,
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

// Quota / session-limit / budget exhaustion — hard stops:
// retrying is pointless until the user upgrades, tops up a budget, or waits
// out a reset window measured in hours/days. Distinct from per-minute rate
// limits and pay-as-you-go balance errors, which stay retryable.
//
// Evidence (real provider messages):
// - Claude Code:  "You've hit your limit · resets 4pm (Asia/Kuala_Lumpur)"
//                 "Claude usage limit reached. Your limit will reset at 3pm"
//                 "5-hour limit reached · resets 12pm"
// - Codex:        "You've hit your usage limit. Upgrade to Plus"
//                 "You've exceeded your usage limit."
// + ChatGPT subscription plan caps (surfaced from chatgpt.com backend,
//   observed via codex providers): "You have hit your ChatGPT usage limit
//   (plus plan). Try again in ~5330 min." — plan name in parens varies
//   (go/plus/pro/team); also arrives as HTTP 429 "The usage limit has been
//   reached" with error.type `usage_limit_reached`
// - OpenAI:       code "insufficient_quota" — "You exceeded your current
//                 quota, please check your plan and billing details"
// - Gemini:       same sentence in 429 RESOURCE_EXHAUSTED responses; only
//                 reaches us after pi's built-in 429 retry gives up
//   + Google AI Pro/Ultra subscription caps: "You have exhausted your
//     capacity on this model. Your quota will reset after 8h44m7s." (Code
//     Assist), "You have reached the quota limit for Claude Sonnet 4.5
//     (Thinking). You can resume using this model at …" (Antigravity)
// - OpenRouter:   "Rate limit exceeded: free-models-per-day. ..."
// - Alibaba:      "Allocated quota exceeded, please increase your quota limit"
//                 (429 Throttling.AllocationQuota / insufficient_quota) — TPM
//                 token rate limiting, transient, auto-recovers in minutes;
//                 stays retryable. Matched only when prefixed by a hard-cap
//                 window: "hour|week|month allocated quota exceeded" (Coding
//                 Plan) and "free allocated quota exceeded" (free quota drained)
// - Copilot:      "You have exceeded your premium request allowance"
// - LiteLLM:      "Budget has been exceeded! Current cost: …, Max budget: …"
// - Kimi:         "Your account {org}<{ak}> is suspended, please check your
//                 plan and billing details" (exceeded_current_quota_error)
// - z.ai GLM:     "Usage limit reached for 5 hour. Your limit will reset at
//                 …" (5-hour window, matches usage-limit-reached above) and
//                 429 code 1113 "Insufficient balance or no resource package.
//                 Please recharge." (Coding Plan quota drained — unlike plain
//                 balance errors this needs a window reset or plan change)
//
// Deliberately retryable (verified, kept out): DeepSeek 402 "Insufficient
// Balance" and 429 "Rate Limit Reached" (concurrency), Kimi TPD org limits
// and "exceeded your current token quota" (balance), Alibaba "Allocated quota
// exceeded" (429 Throttling.AllocationQuota — TPM rate limiting, recovers in
// minutes). See the note on hasQuotaExhaustedError below.
export const QUOTA_EXHAUSTED_PATTERNS = [
  // Session / usage limits with reset windows (Claude, Codex, ChatGPT plans)
  /hit your (?:[a-z]+ )?usage limit/i, // "…hit your usage limit", "…hit your ChatGPT usage limit (plus plan)" — the optional word is the provider name; "hit your rate limit" intentionally NOT matched (burst limit stays retryable)
  /hit your limit/i,
  /usage_limit_reached/i, // Codex backend 429 error.type surfaced in the body
  /usage\s*limit\s*(has\s*been\s*)?reached/i,
  /hour\s*limit\s*reached/i, // "5-hour limit reached" — must NOT hit DeepSeek 429 "Rate Limit Reached"
  /limit\s*will\s*reset\s*at/i,
  /session\s*(limit|quota)/i,
  /exceeded your usage limit/i,
  // Billing / plan quotas (OpenAI insufficient_quota, Gemini RESOURCE_EXHAUSTED)
  /insufficient[_\s]quota/i,
  /exceeded your current quota/i, // Kimi's "...current token quota" (balance, retryable) intentionally not matched
  // Hard allotments
  /free.models.per.day/i, // OpenRouter free-tier daily pool
  // Alibaba: bare "Allocated quota exceeded" (429 Throttling.AllocationQuota /
  // insufficient_quota) is TPM token rate limiting — transient, auto-recovers
  // in minutes, retryable — NOT matched here. Only the Coding Plan window
  // quotas (hour/week/month) and free-quota exhaustion are true hard caps.
  /hour\s*allocated\s*quota/i, // "hour allocated quota exceeded" (Coding Plan)
  /week\s*allocated\s*quota/i, // "week allocated quota exceeded" (Coding Plan)
  /month\s*allocated\s*quota/i, // "month allocated quota exceeded" (Coding Plan)
  /free\s*allocated\s*quota/i, // "free allocated quota exceeded" (free quota drained)
  /premium\s*request\s*allowance/i, // GitHub Copilot monthly allowance
  /monthly\s*(limit|quota|budget|allowance)/i,
  // Budget exhaustion (LiteLLM and similar proxies/gateways)
  /out of budget/i,
  /budget\s*(has\s*been\s*)?(exceeded|exhausted|limit)/i,
  /max(imum)?\s*budget\s*(exceeded|reached|limit)/i,
  /spending\s*limit/i,
  // Google subscription caps (Gemini Code Assist, Antigravity)
  /exhausted your capacity/i, // "You have exhausted your capacity on this model."
  /quota will reset after/i, // "Your quota will reset after 8h44m7s."
  /reached the quota limit/i, // Antigravity "You have reached the quota limit for Gemini 3 Pro (High)"
  /you can resume using this model/i, // Antigravity resume tail when the lead-in is truncated
  // z.ai / GLM Coding Plan window exhaustion (429 code 1113)
  /no resource package/i, // "Insufficient balance or no resource package. Please recharge."
  // Suspended accounts (Kimi exceeded_current_quota_error suspended form)
  /account\b[^.]*\bis\s*suspended/i,
  // Generic
  /quota\s*(exhausted|depleted)/i,
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

/**
 * Returns true for an error assistant message whose errorMessage indicates a
 * context-overflow (input exceeded the model's context window).
 *
 * Mirrors pi-core's isContextOverflow Case 1 (error-message patterns). The
 * silent-overflow cases (stopReason "stop"/"length") are not errors and are
 * never seen here — pi-core handles those in _checkCompaction directly.
 *
 * Callers should treat a true result as "defer to compaction, do NOT retry" —
 * see OVERFLOW_ERROR_PATTERNS for rationale.
 */
export function isContextOverflowError(message: AgentMessage): boolean {
  if (!isAssistantMessage(message)) return false;
  if (message.stopReason !== "error" || !message.errorMessage) return false;
  if (NON_OVERFLOW_PATTERNS.some(p => p.test(message.errorMessage!))) return false;
  return OVERFLOW_ERROR_PATTERNS.some(p => p.test(message.errorMessage!));
}

// ── Universal retry check ──

/**
 * Returns true for ANY assistant message with stopReason === "error"
 * except a tiny blacklist of known permanent failures.
 */
export function hasRetryableError(message: AgentMessage): boolean {
  if (!isAssistantMessage(message)) return false;
  if (message.stopReason !== "error" || !message.errorMessage) return false;
  return !isNonRetryableError(message);
}

/**
 * Returns true only for known permanent failures (invalid API key, missing model, etc.)
 */
export function isNonRetryableError(message: AgentMessage): boolean {
  if (!isAssistantMessage(message)) return false;
  if (message.stopReason !== "error" || !message.errorMessage) return false;
  return (
    NON_RETRYABLE_PATTERNS.some(p => p.test(message.errorMessage!)) ||
    QUOTA_EXHAUSTED_PATTERNS.some(p => p.test(message.errorMessage!))
  );
}

/**
 * Returns true for quota / session-limit / budget exhaustion errors where
 * retrying is pointless until the user acts (upgrade, top up a budget) or a
 * long reset window passes (hours/days). Treated as non-retryable.
 *
 * Deliberately NOT matched: per-minute rate limits (429s) and pay-as-you-go
 * balance errors (DeepSeek "Insufficient Balance", OpenRouter "Insufficient
 * credits", Kimi "exceeded your current token quota") — those stay retryable
 * so a mid-session top-up auto-resumes.
 */
export function hasQuotaExhaustedError(message: AgentMessage): boolean {
  if (!isAssistantMessage(message)) return false;
  if (message.stopReason !== "error" || !message.errorMessage) return false;
  return QUOTA_EXHAUSTED_PATTERNS.some(p => p.test(message.errorMessage!));
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

export function getErrorCategory(errorMessage: string): '400-413' | 'credit' | 'connection' | 'builtin' | 'quota' | 'other' {
  if (QUOTA_EXHAUSTED_PATTERNS.some(p => p.test(errorMessage))) return 'quota';
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
