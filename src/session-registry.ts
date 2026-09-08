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
  /** Whether the session has pi-subagents' standalone child marker. */
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
 * Register this extension's policy for one session after its session_start hook.
 *
 * @param sessionManager Session manager object from ExtensionContext.
 * @param owner Extension API instance that owns the registration.
 * @param options Child marker and native scheduler policy.
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
 */
export function recordRetrySessionAgent(
  sessionManager: unknown,
  agent: Agent,
): void {
  if (!sessionManager || typeof sessionManager !== "object") return;
  sharedRegistry().records.set(sessionManager as SessionManagerKey, {
    session: { sessionManager: sessionManager as SessionManagerKey, agent },
    agent,
  });
}
