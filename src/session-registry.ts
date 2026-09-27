import { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import {
  getErrorCategory,
  hasRetryableError,
  isAssistantMessage,
  isContextOverflowError,
} from "./error-patterns.js";
import { calculateDelay, RetryState } from "./retry-logic.js";
import type { PiRetryConfig } from "./config.js";

const REGISTRY_SYMBOL = Symbol.for("pi-retry.session-registry.v1");
const BIND_PATCH_SYMBOL = Symbol.for("pi-retry.bind-extensions-patch.v1");
const PREPARE_PATCH_SYMBOL = Symbol.for("pi-retry.prepare-retry-patch.v1");
const RETRYABLE_PATCH_SYMBOL = Symbol.for("pi-retry.retryable-patch.v1");

type SessionManagerKey = object;
type ExtensionOwner = object;

/**
 * The private SDK surface pi-retry touches on each AgentSession. Verified
 * against pi 0.86.x/0.87.x; optional members degrade to plain behavior.
 */
export type AgentSessionLike = {
  /** Session manager object exposed by AgentSession. */
  sessionManager?: SessionManagerKey;
  /** Agent instance driven by AgentSession. */
  agent?: Agent;
  /** Settings manager consulted by native retry. */
  settingsManager?: Record<PropertyKey, unknown>;
  /** Native retry attempt counter (0 before the first retry). */
  _retryAttempt?: number;
  /** Native outer-run flag guarding isStreaming during manual continues. */
  _isAgentRunActive?: boolean;
  /** Durable error-pop helper (pi 0.87+). */
  _omitRecoveryAttempt?: (message: unknown, toolResults?: unknown[]) => void;
  /** Rebuilds live agent state from the session projection. */
  _refreshFinalizedContext?: () => void;
  /** Public session event subscription used for the lifecycle bridge. */
  subscribe?: (listener: (event: { type: string }) => void) => (() => void) | undefined;
};

/** The SDK identity captured before an extension registers its own policy. */
interface SessionRecord {
  /** The actual AgentSession instance for this manager. */
  session: AgentSessionLike;
  /** The Agent owned by the session. */
  agent: Agent;
}

/** Per-category counters plus per-category failures-at-cap tallies. */
export interface RetryTracker {
  /** One state per error category used by veto pacing and /retry status. */
  states: Record<string, RetryState>;
  /** Scheduled at-cap retries per category, driving the veto. */
  failuresAtCap: Record<string, number>;
}

/** Per-session retry ownership and native-hook policy. */
export interface RetrySessionBinding {
  /** The session's stable manager object used as a local identity key. */
  sessionManager: SessionManagerKey;
  /** The actual AgentSession instance behind this binding. */
  session: AgentSessionLike;
  /** The Agent instance owned by the session. */
  agent: Agent;
  /** The extension API instance that owns this binding. */
  owner: ExtensionOwner;
  /** Whether this session selected the configured child retry policy. */
  isChild: boolean;
  /** Whether pi-retry overrides classification and backoff for this session. */
  managedRetry: boolean;
  /** Effective retry policy (main or child) driving veto pacing and params. */
  config: PiRetryConfig;
  /** Per-category counters and failures-at-cap shared with /retry status. */
  retry: RetryTracker;
  /** Unsubscribe for the native auto_retry_* lifecycle bridge, when wired. */
  lifecycleUnsubscribe?: (() => void) | null;
}

/** Shared state kept across extension module reloads in one Node process. */
interface RetrySessionRegistry {
  /** Session manager to AgentSession identity records. */
  records: WeakMap<SessionManagerKey, SessionRecord>;
  /** Session manager to extension-owned policy bindings. */
  bindings: WeakMap<SessionManagerKey, RetrySessionBinding>;
  /** AgentSession prototypes whose hooks were wrapped at least once. */
  patchedPrototypes: WeakSet<object>;
}

/**
 * Return the process-wide registry without exposing it as a mutable global
 * variable. Symbol.for keeps concurrent extension factories on one registry.
 *
 * @returns Shared retry session registry.
 */
function sharedRegistry(): RetrySessionRegistry {
  // SAFETY: globalThis is the process-global object; the registry symbol only
  // ever holds values this module created (a RetrySessionRegistry).
  const globalObject = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = globalObject[REGISTRY_SYMBOL];
  if (existing && typeof existing === "object") {
    return existing as RetrySessionRegistry;
  }
  const registry: RetrySessionRegistry = {
    records: new WeakMap(),
    bindings: new WeakMap(),
    patchedPrototypes: new WeakSet(),
  };
  globalObject[REGISTRY_SYMBOL] = registry;
  return registry;
}

/**
 * Classify one assistant message with pi-retry's broader error patterns.
 *
 * Retryable = catch-all minus the permanent blacklist (which subsumes the
 * silenced set) minus quota exhaustion minus context overflow. Returning
 * false for overflow keeps pi's compaction recovery path authoritative.
 *
 * @param message Candidate assistant message.
 * @returns True when pi-retry would retry this error.
 */
export function classifyRetryable(message: unknown): boolean {
  if (!isAssistantMessage(message as AgentMessage)) return false;
  if (isContextOverflowError(message as AgentMessage)) return false;
  return hasRetryableError(message as AgentMessage);
}

/**
 * Decide whether one pending retry attempt is vetoed by the failure cap.
 *
 * Mirrors the legacy loop pacing, scoped per category: the candidate
 * attempt's computed delay is checked against maxDelayMs; once
 * maxRetriesAtMaxDelay at-cap attempts have been scheduled for this
 * category, the next at-cap attempt is refused without consuming an
 * attempt, exactly like the legacy loop's give-up before scheduling.
 *
 * @param binding Owned session binding carrying counters and config.
 * @param message Failing assistant message.
 * @returns True when the retry must not run.
 */
function vetoRetry(binding: RetrySessionBinding, message: unknown): boolean {
  const errorMessage = (message as { errorMessage?: string }).errorMessage || "Unknown error";
  const category = getErrorCategory(errorMessage);
  const state = binding.retry.states[category] ?? binding.retry.states.other;
  const candidate = state.getAttempt() + 1;
  const delay = calculateDelay(candidate, binding.config);
  const atCap = delay >= binding.config.maxDelayMs;
  if (atCap && (binding.retry.failuresAtCap[category] ?? 0) >= binding.config.maxRetriesAtMaxDelay) {
    return true;
  }
  state.startRetry(errorMessage);
  state.endRetry();
  if (atCap) {
    binding.retry.failuresAtCap[category] = (binding.retry.failuresAtCap[category] ?? 0) + 1;
  }
  return false;
}

/**
 * Build the native retry settings for one delegated attempt.
 *
 * Native reads settings before incrementing _retryAttempt, so the pending
 * attempt index is _retryAttempt + 1. retryDelayMs doubles from baseDelayMs
 * (fixed ×2), so a custom multiplier is compensated into the base:
 * round(base * (multiplier/2)^(N-1)) * 2^(N-1) = base * multiplier^(N-1).
 *
 * @param binding Owned session binding carrying the effective config.
 * @param session AgentSession about to run its native retry.
 * @returns Settings snapshot with pi-retry's backoff encoded.
 */
function piRetryAgentSettings(
  binding: RetrySessionBinding,
  session: AgentSessionLike,
): {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
  maxAgentDelayMs: number;
} {
  const prior = typeof session._retryAttempt === "number" ? session._retryAttempt : 0;
  const attempt = prior + 1;
  const base = Math.round(
    binding.config.baseDelayMs * (binding.config.multiplier / 2) ** (attempt - 1),
  );
  return {
    enabled: true,
    // The real stop condition is the veto; native's counter must not preempt it.
    maxRetries: 1_000_000,
    baseDelayMs: Math.min(base, binding.config.maxDelayMs),
    maxAgentDelayMs: binding.config.maxDelayMs,
  };
}

/** Patch-marker helper: only this module sets markers, always to `true`. */
function hasPatchMarker(fn: unknown, marker: symbol): boolean {
  // SAFETY: patch markers are symbols defined by this module on wrapped fns.
  return typeof fn === "function" && (fn as unknown as Record<PropertyKey, unknown>)[marker] === true;
}

/**
 * Wrap one SDK prototype member exactly once. The marker lives on the wrapped
 * function itself, so restoring the native member (tests, SDK updates) lets a
 * later install re-wrap, while duplicate factories share the existing wrap.
 *
 * @param prototype SDK prototype holding the member.
 * @param member Member name to wrap.
 * @param marker Patch identity symbol.
 * @param makeWrapper Builds the wrapper around the current implementation.
 * @returns True when the member is present and wrapped (or already was).
 */
function ensureWrapped(
  prototype: Record<PropertyKey, unknown>,
  member: string,
  marker: symbol,
  makeWrapper: (current: (...args: never[]) => unknown) => (...args: never[]) => unknown,
): boolean {
  const current = prototype[member];
  if (typeof current !== "function") return false;
  if (hasPatchMarker(current, marker)) return true;
  const wrapped = makeWrapper(current as (...args: never[]) => unknown);
  Object.defineProperty(wrapped, marker, { value: true });
  try {
    prototype[member] = wrapped;
  } catch {
    return false;
  }
  return true;
}

/**
 * Install the narrow SDK hooks: bindExtensions capture plus the retry-seam
 * wraps (_isRetryableError classification extension, _prepareRetry veto +
 * backoff params). Unowned sessions delegate straight through to native.
 *
 * @returns True when the supported SDK seam is present and wrapped.
 */
export function installRetrySdkHooks(): boolean {
  // SAFETY: the SDK prototype is augmented, not reshaped; wrapped members keep
  // their original signatures.
  const prototype = AgentSession.prototype as unknown as Record<PropertyKey, unknown>;
  const registry = sharedRegistry();

  const bindOk = ensureWrapped(prototype, "bindExtensions", BIND_PATCH_SYMBOL, (current) => {
    // SAFETY: pi 0.86.x/0.87.x both declare bindExtensions(): Promise<void>; the
    // wrapper forwards whatever the SDK returns.
    const currentBind = current as (this: AgentSessionLike, ...args: unknown[]) => Promise<void>;
    return function (this: AgentSessionLike, ...args: unknown[]): Promise<void> {
      const manager = this.sessionManager;
      const agent = this.agent;
      if (manager && agent) {
        registry.records.set(manager, { session: this, agent });
      }
      return currentBind.apply(this, args);
    };
  });

  const retryableOk = ensureWrapped(prototype, "_isRetryableError", RETRYABLE_PATCH_SYMBOL, (current) => {
    const currentCheck = current as (this: AgentSessionLike, message: unknown) => boolean;
    return function (this: AgentSessionLike, message: unknown): boolean {
      const manager = this.sessionManager;
      const binding = manager ? registry.bindings.get(manager) : undefined;
      if (binding?.managedRetry === true && classifyRetryable(message)) return true;
      return currentCheck.call(this, message);
    };
  });

  const prepareOk = ensureWrapped(prototype, "_prepareRetry", PREPARE_PATCH_SYMBOL, (current) => {
    const currentPrepare = current as (this: AgentSessionLike, message: unknown) => Promise<boolean>;
    return async function (this: AgentSessionLike, message: unknown): Promise<boolean> {
      const manager = this.sessionManager;
      const binding = manager ? registry.bindings.get(manager) : undefined;
      if (binding?.managedRetry !== true || !classifyRetryable(message)) {
        return currentPrepare.call(this, message);
      }
      // Veto before delegating so native's _retryAttempt stays untouched.
      if (vetoRetry(binding, message)) return false;
      const mgr = this.settingsManager as
        | { getRetrySettings?: (...args: unknown[]) => unknown }
        | undefined;
      if (!mgr || typeof mgr.getRetrySettings !== "function") {
        return currentPrepare.call(this, message);
      }
      const original = mgr.getRetrySettings;
      mgr.getRetrySettings = () => piRetryAgentSettings(binding, this);
      try {
        return await currentPrepare.call(this, message);
      } finally {
        mgr.getRetrySettings = original;
      }
    };
  });

  if (!bindOk || !retryableOk || !prepareOk) return false;
  registry.patchedPrototypes.add(prototype);
  return true;
}

/**
 * Resolve the Agent belonging to a session-local manager object.
 *
 * @param sessionManager Session manager object from ExtensionContext.
 * @returns The exact Agent instance, or undefined when the SDK was not mapped.
 */
export function getSessionAgent(sessionManager: unknown): Agent | undefined {
  if (!sessionManager || typeof sessionManager !== "object") return undefined;
  return sharedRegistry().records.get(sessionManager as SessionManagerKey)?.agent;
}

/**
 * Register this extension's policy for one session after its session_start hook.
 *
 * @param sessionManager Session manager object from ExtensionContext.
 * @param owner Extension API instance that owns the registration.
 * @param options Policy classification and effective retry config.
 * @returns Binding and ownership flag; a duplicate factory is never the owner.
 */
export function registerRetrySession(
  sessionManager: unknown,
  owner: ExtensionOwner,
  options: {
    isChild: boolean;
    managedRetry: boolean;
    config: PiRetryConfig;
  },
): { binding: RetrySessionBinding; owned: boolean } | undefined {
  if (!sessionManager || typeof sessionManager !== "object") return undefined;
  const manager = sessionManager as SessionManagerKey;
  const record = sharedRegistry().records.get(manager);
  if (!record) return undefined;
  const registry = sharedRegistry();
  const existing = registry.bindings.get(manager);
  if (existing && existing.owner !== owner) {
    return { binding: existing, owned: false };
  }
  const binding: RetrySessionBinding = existing ?? {
    sessionManager: manager,
    session: record.session,
    agent: record.agent,
    owner,
    isChild: options.isChild,
    managedRetry: options.managedRetry,
    config: options.config,
    retry: {
      states: {
        "400-413": new RetryState(),
        credit: new RetryState(),
        connection: new RetryState(),
        other: new RetryState(),
      },
      failuresAtCap: {},
    },
  };
  binding.session = record.session;
  binding.agent = record.agent;
  binding.isChild = options.isChild;
  binding.managedRetry = options.managedRetry;
  binding.config = options.config;
  registry.bindings.set(manager, binding);
  return { binding, owned: true };
}

/**
 * Read the extension binding for a session without classifying new sessions.
 *
 * @param sessionManager Session manager object from ExtensionContext.
 * @returns Existing binding, if this extension owns the session.
 */
export function getRetrySession(
  sessionManager: unknown,
): RetrySessionBinding | undefined {
  if (!sessionManager || typeof sessionManager !== "object") return undefined;
  return sharedRegistry().bindings.get(sessionManager as SessionManagerKey);
}

/**
 * Reset one binding's category counters and failures-at-cap tally.
 *
 * @param binding Owned session binding.
 */
export function resetRetryTracker(binding: RetrySessionBinding): void {
  for (const state of Object.values(binding.retry.states)) state.reset();
  binding.retry.failuresAtCap = {};
}

/**
 * Remove a binding during the owning session's shutdown event.
 *
 * @param sessionManager Session manager object from ExtensionContext.
 * @param owner Extension API instance that must still own the binding.
 */
export function unregisterRetrySession(sessionManager: unknown, owner: ExtensionOwner): void {
  if (!sessionManager || typeof sessionManager !== "object") return;
  const manager = sessionManager as SessionManagerKey;
  const registry = sharedRegistry();
  const binding = registry.bindings.get(manager);
  // Without a binding there is no owner proof, so leave the SDK identity
  // untouched. This also protects a stale duplicate after owner cleanup.
  if (!binding || binding.owner !== owner) return;
  registry.bindings.delete(manager);
  registry.records.delete(manager);
}

/**
 * Record the Agent/session pair used by lightweight test fixtures.
 *
 * This mirrors the side effect of the supported SDK bindExtensions hook without
 * constructing a full AgentSession. Production callers should let the SDK hook
 * populate the registry automatically.
 *
 * @param sessionManager Stable fixture session-manager identity.
 * @param agent Agent instance driven by that fixture session.
 * @param session Optional richer session stub (defaults to a minimal view).
 */
export function recordRetrySessionAgent(
  sessionManager: unknown,
  agent: Agent,
  session?: AgentSessionLike,
): void {
  if (!sessionManager || typeof sessionManager !== "object") return;
  sharedRegistry().records.set(sessionManager as SessionManagerKey, {
    session: session ?? { sessionManager: sessionManager as SessionManagerKey, agent },
    agent,
  });
}
