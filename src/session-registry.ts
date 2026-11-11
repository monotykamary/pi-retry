import { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Agent } from "@earendil-works/pi-agent-core";

const REGISTRY_SYMBOL = Symbol.for("pi-retry.session-registry.v1");
const BIND_PATCH_SYMBOL = Symbol.for("pi-retry.bind-extensions-patch.v1");
const PREPARE_PATCH_SYMBOL = Symbol.for("pi-retry.prepare-retry-patch.v1");

type SessionManagerKey = object;
type ExtensionOwner = object;

type AgentSessionLike = {
  /** Session manager object exposed by AgentSession. */
  sessionManager?: SessionManagerKey;
  /** Agent instance driven by AgentSession. */
  agent?: Agent;
  /** Native retry method wrapped through a structural SDK view. */
  _prepareRetry?: (message: unknown) => Promise<boolean>;
  /** Canonical context omission hook introduced by pi 0.87. */
  _omitRecoveryAttempt?: (message: unknown) => void;
  /** Resolves once the whole session lifecycle (not just the Agent run) is idle. */
  waitForIdle?: () => Promise<void>;
};

/** The SDK identity captured before an extension registers its own policy. */
interface SessionRecord {
  /** The actual AgentSession instance for this manager. */
  session: AgentSessionLike;
  /** The Agent owned by the session. */
  agent: Agent;
}

/** Per-session retry ownership and native-hook policy. */
export interface RetrySessionBinding {
  /** The session's stable manager object used as a local identity key. */
  sessionManager: SessionManagerKey;
  /** The actual Agent instance for hidden continuation requests. */
  agent: Agent;
  /** The extension API instance that owns this binding. */
  owner: ExtensionOwner;
  /** Whether this session selected the configured child retry policy. */
  isChild: boolean;
  /** Whether pi-retry should suppress the SDK's native retry scheduler. */
  suppressNativeRetry: boolean;
  /** Whether the child-specific extension policy is enabled. */
  childRetryEnabled: boolean;
  /** Owner-local controller state shared by duplicate factory registrations. */
  sessionState?: unknown;
}

/** Shared state kept across extension module reloads in one Node process. */
interface RetrySessionRegistry {
  /** Session manager to AgentSession identity records. */
  records: WeakMap<SessionManagerKey, SessionRecord>;
  /** Session manager to extension-owned policy bindings. */
  bindings: WeakMap<SessionManagerKey, RetrySessionBinding>;
  /** AgentSession prototypes whose bindExtensions hook is already wrapped. */
  bindPatchedPrototypes: WeakSet<object>;
  /** AgentSession prototypes whose _prepareRetry hook is already wrapped. */
  preparePatchedPrototypes: WeakSet<object>;
}

/**
 * Return the process-wide registry without exposing it as a mutable global
 * variable. Symbol.for keeps concurrent extension factories on one registry.
 *
 * @returns Shared retry session registry.
 */
function sharedRegistry(): RetrySessionRegistry {
  const globalObject = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = globalObject[REGISTRY_SYMBOL];
  if (existing && typeof existing === "object") {
    return existing as RetrySessionRegistry;
  }
  const registry: RetrySessionRegistry = {
    records: new WeakMap(),
    bindings: new WeakMap(),
    bindPatchedPrototypes: new WeakSet(),
    preparePatchedPrototypes: new WeakSet(),
  };
  globalObject[REGISTRY_SYMBOL] = registry;
  return registry;
}

/**
 * Install the narrow SDK hooks needed for exact session ownership.
 *
 * @returns True when the supported SDK seam is present and wrapped.
 */
export function installRetrySdkHooks(): boolean {
  const prototype = AgentSession.prototype as unknown as Record<PropertyKey, unknown>;
  const bindExtensions = prototype.bindExtensions;
  const prepareRetry = prototype._prepareRetry;
  if (typeof bindExtensions !== "function" || typeof prepareRetry !== "function") {
    return false;
  }

  const registry = sharedRegistry();
  if (!registry.bindPatchedPrototypes.has(prototype) || !(bindExtensions as unknown as Record<PropertyKey, unknown>)[BIND_PATCH_SYMBOL]) {
    const currentBind = bindExtensions as (this: AgentSessionLike, ...args: unknown[]) => unknown;
    if (!(currentBind as unknown as Record<PropertyKey, unknown>)[BIND_PATCH_SYMBOL]) {
      const wrappedBind = function (this: AgentSessionLike, ...args: unknown[]): unknown {
        const manager = this.sessionManager;
        const agent = this.agent;
        if (manager && agent) {
          registry.records.set(manager, { session: this, agent });
        }
        return currentBind.apply(this, args);
      };
      Object.defineProperty(wrappedBind, BIND_PATCH_SYMBOL, { value: true });
      try {
        prototype.bindExtensions = wrappedBind;
      } catch {
        return false;
      }
    }
    registry.bindPatchedPrototypes.add(prototype);
  }

  if (!registry.preparePatchedPrototypes.has(prototype) || !(prepareRetry as unknown as Record<PropertyKey, unknown>)[PREPARE_PATCH_SYMBOL]) {
    const currentPrepare = prepareRetry as (this: AgentSessionLike, message: unknown) => Promise<boolean>;
    if (!(currentPrepare as unknown as Record<PropertyKey, unknown>)[PREPARE_PATCH_SYMBOL]) {
      const wrappedPrepare = function (this: AgentSessionLike, message: unknown): Promise<boolean> {
        const manager = this.sessionManager;
        const binding = manager ? registry.bindings.get(manager) : undefined;
        if (binding?.suppressNativeRetry === true) {
          return Promise.resolve(false);
        }
        return currentPrepare.call(this, message);
      };
      Object.defineProperty(wrappedPrepare, PREPARE_PATCH_SYMBOL, { value: true });
      try {
        prototype._prepareRetry = wrappedPrepare;
      } catch {
        return false;
      }
    }
    registry.preparePatchedPrototypes.add(prototype);
  }

  return true;
}

/**
 * Check whether the SDK runs the `agent_before_settle` boundary, which
 * message-free retries use to omit a failed response and continue.
 *
 * @returns True when AgentSession dispatches the settle boundary.
 *
 * TEST:__tests__/integration/native-child-lifecycle.test.ts[message-free retries]
 */
export function supportsSettleBoundary(): boolean {
  const prototype = AgentSession.prototype as unknown as Record<PropertyKey, unknown>;
  return typeof prototype._runBeforeSettleBoundary === "function";
}

/**
 * Resolve the Agent belonging to a session-local manager object.
 *
 * @param sessionManager Session manager object from ExtensionContext.
 * @returns The exact Agent instance, or undefined when the SDK was not mapped.
 */
export function getSessionAgent(sessionManager: unknown): Agent | undefined {
  if (!sessionManager || typeof sessionManager !== "object") return undefined;
  return sharedRegistry().records.get(sessionManager)?.agent;
}

/**
 * Wait until a session has finished its current run, including the work that
 * follows it.
 *
 * `Agent.waitForIdle()` only covers the low-level run. That run is published
 * after `AgentSession._prepareRun()` completes, so right after
 * `pi.sendMessage()` the Agent can still look idle, and a retry loop that waits
 * on it moves on before the hidden turn even starts and loses its backoff
 * state. The same wrapper also emits `agent_settled` after the run, and a
 * message sent during that emission is deferred until it ends. The session's
 * `waitForIdle()` is flagged busy synchronously by a send, covers the settle
 * phase and compaction, and also settles when the run fails to start, so it is
 * the correct barrier before and after a hidden retry send.
 *
 * TEST:__tests__/unit/session-registry.test.ts[waitForSessionIdle]
 * TEST:__tests__/integration/detached-backoff.test.ts[detached retry loop backoff]
 *
 * @param sessionManager Session manager object from ExtensionContext.
 * @param agent Agent the caller is driving; used as the fallback barrier.
 * @returns Resolves when the session (or, without a mapped session, the Agent) is idle.
 */
export async function waitForSessionIdle(
  sessionManager: unknown,
  agent: Agent,
): Promise<void> {
  const record = sessionManager && typeof sessionManager === "object"
    ? sharedRegistry().records.get(sessionManager)
    : undefined;
  // Only trust the session when it still owns this exact Agent; a replaced
  // session must not make an old loop wait on a different lifecycle.
  if (record && record.agent === agent && typeof record.session.waitForIdle === "function") {
    await record.session.waitForIdle();
    return;
  }
  await agent.waitForIdle();
}

/**
 * Register this extension's policy for one session after its session_start hook.
 *
 * @param sessionManager Session manager object from ExtensionContext.
 * @param owner Extension API instance that owns the registration.
 * @param options Policy classification and native scheduler policy.
 * @returns Binding and ownership flag; a duplicate factory is never the owner.
 */
export function registerRetrySession(
  sessionManager: unknown,
  owner: ExtensionOwner,
  options: {
    isChild: boolean;
    suppressNativeRetry: boolean;
    childRetryEnabled: boolean;
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
    agent: record.agent,
    owner,
    ...options,
  };
  binding.agent = record.agent;
  binding.isChild = options.isChild;
  binding.suppressNativeRetry = options.suppressNativeRetry;
  binding.childRetryEnabled = options.childRetryEnabled;
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
 * Record the Agent/session-manager pair used by lightweight test fixtures.
 *
 * This mirrors the side effect of the supported SDK bindExtensions hook without
 * constructing a full AgentSession. Production callers should let the SDK hook
 * populate the registry automatically.
 *
 * @param sessionManager Stable fixture session-manager identity.
 * @param agent Agent instance driven by that fixture session.
 * @param session Optional SDK session-shaped object for canonical-context tests.
 * @returns Nothing; the identity is stored in the process-wide registry.
 */
export function recordRetrySessionAgent(
  sessionManager: unknown,
  agent: Agent,
  session: AgentSessionLike = { sessionManager: sessionManager as SessionManagerKey, agent },
): void {
  if (!sessionManager || typeof sessionManager !== "object") return;
  sharedRegistry().records.set(sessionManager as SessionManagerKey, {
    session,
    agent,
  });
}

/**
 * Remove the trailing failed assistant response from the next retry context.
 *
 * Pi 0.87+ builds provider context from SessionManager projections rather than
 * from direct assignments to `agent.state.messages`. Its private recovery hook
 * records a context edit while retaining the failed response in raw history;
 * older SDKs, lightweight fixtures, and a throwing hook fall back to the former
 * live-state edit.
 *
 * @param sessionManager Session manager identity exposed by ExtensionContext.
 * @param agent Agent whose trailing response is being retried.
 * @returns Nothing; the response is omitted from the next provider projection.
 *
 * TEST:__tests__/unit/session-registry.test.ts[uses canonical retry omission, falls back when the canonical omission hook throws]
 */
export function removeErrorFromRetryContext(
  sessionManager: unknown,
  agent: Agent,
): void {
  const messages = agent.state.messages;
  const lastMessage = messages[messages.length - 1];
  if (lastMessage?.role !== "assistant" || lastMessage.stopReason !== "error") {
    return;
  }

  const record = sessionManager && typeof sessionManager === "object"
    ? sharedRegistry().records.get(sessionManager as SessionManagerKey)
    : undefined;
  const omitRecoveryAttempt = record?.session._omitRecoveryAttempt;
  if (record && typeof omitRecoveryAttempt === "function") {
    try {
      omitRecoveryAttempt.call(record.session, lastMessage);
      return;
    } catch {
      // The private hook can throw (for example when a projected message has no
      // source entry). The retry loop is started with `void`, so a throw here would
      // become an unhandled rejection; fall back to the live-state edit instead.
    }
  }

  // Compatibility path for pi versions before canonical SessionManager context,
  // and fallback when the canonical hook throws.
  agent.state.messages = messages.slice(0, -1);
}
