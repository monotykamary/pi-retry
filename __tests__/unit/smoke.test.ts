/**
 * Native-seam smoke tests.
 *
 * pi-retry no longer injects hidden turns. The extension wraps three
 * AgentSession.prototype members (bindExtensions, _isRetryableError,
 * _prepareRetry) and drives pi's native retry: extended classification,
 * veto past the max-delay failure cap, and injected backoff settings.
 * These tests invoke the wrapped prototype methods with lightweight fake
 * `this` sessions and the real native retry implementation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Agent } from "@earendil-works/pi-agent-core";
import { DEFAULT_RETRY_CONFIG, type PiRetryConfig } from "../../src/config.js";
import {
  recordRetrySessionAgent,
  registerRetrySession,
  unregisterRetrySession,
  type AgentSessionLike,
} from "../../src/session-registry.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Helpers ──

const registeredManagers: Array<{ manager: object; owner: object }> = [];

function track(manager: object, owner: object): void {
  registeredManagers.push({ manager, owner });
}

afterEach(() => {
  for (const { manager, owner } of registeredManagers.splice(0)) {
    unregisterRetrySession(manager, owner);
  }
});

function errorMessage(text: string): any {
  return { role: "assistant", stopReason: "error", errorMessage: text, content: [] };
}

function userMessage(): any {
  return { role: "user", content: [{ type: "text", text: "go" }] };
}

function createMockAPI() {
  const handlers: Record<string, Function[]> = {};
  const commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};

  const api = {
    events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
    on(event: string, handler: Function) {
      (handlers[event] ??= []).push(handler);
    },
    registerCommand(name: string, opts: { handler: (args: string, ctx: any) => Promise<void> }) {
      commands[name] = opts;
    },
  } as unknown as ExtensionAPI;

  return { api, handlers, commands };
}

/**
 * Fake `this` for the wrapped prototype methods, shaped like the private
 * surface native _prepareRetry touches on pi 0.86.x/0.87.x.
 */
function createFakeSession(options: {
  manager: object;
  agent?: Partial<Agent>;
  settings?: Record<string, unknown>;
  retryAttempt?: number;
}) {
  const agent = {
    state: { messages: [userMessage()] as any[] },
    ...(options.agent ?? {}),
  } as Agent;
  const session = {
    sessionManager: options.manager,
    agent,
    settingsManager: {
      getRetrySettings: vi.fn(() => ({
        enabled: options.settings?.enabled ?? true,
        maxRetries: options.settings?.maxRetries ?? 3,
        baseDelayMs: options.settings?.baseDelayMs ?? 2000,
        maxAgentDelayMs: options.settings?.maxAgentDelayMs ?? 60000,
      })),
    },
    _retryAttempt: options.retryAttempt ?? 0,
    _emit: vi.fn(),
    model: undefined,
  } as unknown as AgentSessionLike & {
    settingsManager: { getRetrySettings: ReturnType<typeof vi.fn> };
    _retryAttempt: number;
    _emit: ReturnType<typeof vi.fn>;
    agent: Agent;
  };
  return session;
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

/**
 * Import retry.ts with the current prototype state. The install wraps
 * whatever _prepareRetry is currently on the prototype, so tests install a
 * counting spy around the real native method first.
 */
async function loadExtension() {
  vi.resetModules();
  const { AgentSession } = await import("@earendil-works/pi-coding-agent");
  const prototype = AgentSession.prototype as unknown as Record<PropertyKey, any>;
  const realPrepare = prototype._prepareRetry;
  const delegateSpy = vi.fn(realPrepare);
  prototype._prepareRetry = delegateSpy;

  const mod = await import("../../retry.ts");
  const { api, handlers, commands } = createMockAPI();
  mod.default(api);

  return {
    api,
    handlers,
    commands,
    prototype,
    delegateSpy,
    AgentSession,
    restore: () => {
      prototype._prepareRetry = realPrepare;
    },
  };
}

function registerManaged(
  manager: object,
  owner: object,
  config: PiRetryConfig = DEFAULT_RETRY_CONFIG,
  managedRetry = true,
  isChild = false,
  agent?: Agent,
  session?: AgentSessionLike,
) {
  recordRetrySessionAgent(manager, agent ?? ({} as Agent), session);
  track(manager, owner);
  return registerRetrySession(manager, owner, { isChild, managedRetry, config })!.binding;
}

// ── Classification ──

describe("native seam: _isRetryableError wrap", () => {
  it("extends classification with pi-retry patterns for managed sessions", async () => {
    const ext = await loadExtension();
    try {
      const manager = {};
      registerManaged(manager, ext.api as unknown as object);
      const session = createFakeSession({ manager });
      const check = ext.prototype._isRetryableError as (this: AgentSessionLike, m: unknown) => boolean;

      expect(check.call(session, errorMessage("400 status code from provider"))).toBe(true);
      expect(check.call(session, errorMessage("413 status code: payload too large"))).toBe(true);
      expect(check.call(session, errorMessage("not enough credits"))).toBe(true);
      expect(check.call(session, errorMessage("something entirely unknown happened"))).toBe(true);
    } finally {
      ext.restore();
    }
  });

  it("keeps quota and overflow errors non-retryable for managed sessions", async () => {
    const ext = await loadExtension();
    try {
      const manager = {};
      registerManaged(manager, ext.api as unknown as object);
      const session = createFakeSession({ manager });
      const check = ext.prototype._isRetryableError as (this: AgentSessionLike, m: unknown) => boolean;

      expect(check.call(session, errorMessage("You exceeded your current quota"))).toBe(false);
      expect(check.call(session, errorMessage("prompt is too long: 250000 tokens > 200000"))).toBe(false);
    } finally {
      ext.restore();
    }
  });

  it("delegates to native classification for unmanaged sessions", async () => {
    const ext = await loadExtension();
    try {
      const manager = {};
      const session = createFakeSession({ manager });
      const check = ext.prototype._isRetryableError as (this: AgentSessionLike, m: unknown) => boolean;

      // pi-retry would retry both; native rejects 400 and accepts 5xx.
      expect(check.call(session, errorMessage("400 status code from provider"))).toBe(false);
      expect(check.call(session, errorMessage("500 Internal Server Error"))).toBe(true);
    } finally {
      ext.restore();
    }
  });
});

// ── Delegation ──

describe("native seam: _prepareRetry wrap", () => {
  it("delegates with injected backoff settings honoring multiplier and cap", async () => {
    const ext = await loadExtension();
    try {
      const manager = {};
      registerManaged(manager, ext.api as unknown as object, {
        baseDelayMs: 3000,
        maxDelayMs: 20000,
        multiplier: 3,
        maxRetriesAtMaxDelay: 3,
      });
      const session = createFakeSession({ manager, retryAttempt: 0 });
      session.agent.state.messages = [userMessage(), errorMessage("Connection error")];

      const prepared = (ext.prototype._prepareRetry as any).call(session, errorMessage("Connection error"));
      await advance(6000);
      expect(await prepared).toBe(true);

      // Attempt 1: compensation base = 3000 * (3/2)^0 = 3000 → delay 3000 * 2^0.
      expect(session._emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: "auto_retry_start", attempt: 1, delayMs: 3000, maxAttempts: 1_000_000 }),
      );
      // Native popped the trailing error from live state.
      expect(session.agent.state.messages).toHaveLength(1);
      // Native's counter advanced; pi-retry's huge maxRetries never preempts.
      expect(session._retryAttempt).toBe(1);

      // Attempt 2: compensation = round(3000 * 1.5) = 4500 → delay 9000.
      const second = (ext.prototype._prepareRetry as any).call(session, errorMessage("Connection error"));
      await advance(9000);
      expect(await second).toBe(true);
      expect(session._emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: "auto_retry_start", attempt: 2, delayMs: 9000 }),
      );

      // Cap: base compensation clamped to maxDelayMs (20000).
      session._retryAttempt = 4;
      const capped = (ext.prototype._prepareRetry as any).call(session, errorMessage("Connection error"));
      await advance(40000);
      expect(await capped).toBe(true);
      expect(session._emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: "auto_retry_start", attempt: 5, delayMs: 20000 }),
      );
    } finally {
      ext.restore();
    }
  });

  it("restores the original getRetrySettings after delegating", async () => {
    const ext = await loadExtension();
    try {
      const manager = {};
      registerManaged(manager, ext.api as unknown as object);
      const session = createFakeSession({ manager });
      const original = session.settingsManager.getRetrySettings;

      const prepared = (ext.prototype._prepareRetry as any).call(session, errorMessage("Connection error"));
      await advance(3000);
      expect(await prepared).toBe(true);
      expect(session.settingsManager.getRetrySettings).toBe(original);
    } finally {
      ext.restore();
    }
  });

  it("vetoes after maxRetriesAtMaxDelay at-cap failures without delegating", async () => {
    const ext = await loadExtension();
    try {
      const manager = {};
      // Every attempt's delay reaches the 100ms cap; three are allowed.
      registerManaged(manager, ext.api as unknown as object, {
        baseDelayMs: 100,
        maxDelayMs: 100,
        multiplier: 2,
        maxRetriesAtMaxDelay: 3,
      });
      const session = createFakeSession({ manager });
      const failure = errorMessage("Connection error");

      for (let attempt = 0; attempt < 3; attempt++) {
        const prepared = (ext.prototype._prepareRetry as any).call(session, failure);
        await advance(150);
        expect(await prepared).toBe(true);
      }
      expect(ext.delegateSpy).toHaveBeenCalledTimes(3);

      const vetoed = await (ext.prototype._prepareRetry as any).call(session, failure);
      expect(vetoed).toBe(false);
      expect(ext.delegateSpy).toHaveBeenCalledTimes(3);
      // The veto runs before delegation, so native's counter is untouched.
      expect(session._retryAttempt).toBe(3);
    } finally {
      ext.restore();
    }
  });

  it("passes non-retryable errors straight to native", async () => {
    const ext = await loadExtension();
    try {
      const manager = {};
      registerManaged(manager, ext.api as unknown as object);
      const session = createFakeSession({ manager, settings: { enabled: false } });

      const result = await (ext.prototype._prepareRetry as any).call(
        session,
        errorMessage("Invalid API key provided"),
      );
      // Native rejects classification; the wrap delegated without patching.
      expect(result).toBe(false);
      expect(session.settingsManager.getRetrySettings).toHaveBeenCalledTimes(1);
    } finally {
      ext.restore();
    }
  });
});

// ── Counter resets ──

describe("native seam: counter resets", () => {
  async function exhaustCap(ext: Awaited<ReturnType<typeof loadExtension>>, session: ReturnType<typeof createFakeSession>) {
    const failure = errorMessage("Connection error");
    for (let attempt = 0; attempt < 3; attempt++) {
      const prepared = (ext.prototype._prepareRetry as any).call(session, failure);
      await advance(150);
      await prepared;
    }
    expect(await (ext.prototype._prepareRetry as any).call(session, failure)).toBe(false);
    expect(ext.delegateSpy).toHaveBeenCalledTimes(3);
  }

  it("re-arms the cap after a successful turn_end", async () => {
    const ext = await loadExtension();
    try {
      const manager = {};
      registerManaged(manager, ext.api as unknown as object, {
        baseDelayMs: 100,
        maxDelayMs: 100,
        multiplier: 2,
        maxRetriesAtMaxDelay: 3,
      });
      const session = createFakeSession({ manager });
      await exhaustCap(ext, session);

      const ctx = { sessionManager: manager, signal: undefined, ui: { notify: vi.fn() } };
      for (const handler of ext.handlers["turn_end"] ?? []) {
        handler({ message: { role: "assistant", stopReason: "stop" } }, ctx);
      }

      ext.delegateSpy.mockClear();
      await exhaustCap(ext, session);
    } finally {
      ext.restore();
    }
  });

  it("re-arms the cap after fresh user input", async () => {
    const ext = await loadExtension();
    try {
      const manager = {};
      registerManaged(manager, ext.api as unknown as object, {
        baseDelayMs: 100,
        maxDelayMs: 100,
        multiplier: 2,
        maxRetriesAtMaxDelay: 3,
      });
      const session = createFakeSession({ manager });
      await exhaustCap(ext, session);

      const ctx = { sessionManager: manager, ui: { notify: vi.fn() } };
      for (const handler of ext.handlers["input"] ?? []) {
        handler({ prompt: "fresh question" }, ctx);
      }

      ext.delegateSpy.mockClear();
      await exhaustCap(ext, session);
    } finally {
      ext.restore();
    }
  });

  it("re-arms the cap after /retry reset", async () => {
    const ext = await loadExtension();
    try {
      const manager = {};
      registerManaged(manager, ext.api as unknown as object, {
        baseDelayMs: 100,
        maxDelayMs: 100,
        multiplier: 2,
        maxRetriesAtMaxDelay: 3,
      });
      const session = createFakeSession({ manager });
      await exhaustCap(ext, session);

      const ctx = { sessionManager: manager, ui: { notify: vi.fn() } };
      await ext.commands["retry"].handler("reset", ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith("All retry counters reset", "info");

      ext.delegateSpy.mockClear();
      await exhaustCap(ext, session);
    } finally {
      ext.restore();
    }
  });
});

// ── /retry manual continue ──

describe("native seam: /retry manual continue", () => {
  it("pops a trailing error durably and continues guarded", async () => {
    const ext = await loadExtension();
    try {
      const manager = { getEntries: vi.fn(() => []) };
      const user = userMessage();
      const error = errorMessage("Connection error");
      const session = createFakeSession({ manager });
      session.agent.state.messages = [user, error];
      (session as any)._omitRecoveryAttempt = vi.fn(() => {
        session.agent.state.messages = [user];
      });
      const continueFn = vi.fn(async () => {
        expect((session as any)._isAgentRunActive).toBe(true);
      });
      session.agent.continue = continueFn;
      registerManaged(manager, ext.api as unknown as object, DEFAULT_RETRY_CONFIG, true, false, session.agent, session);

      const ctx = { sessionManager: manager, ui: { notify: vi.fn() } };
      await ext.commands["retry"].handler("", ctx);

      expect((session as any)._omitRecoveryAttempt).toHaveBeenCalledWith(error);
      expect(continueFn).toHaveBeenCalledTimes(1);
      expect((session as any)._isAgentRunActive).toBe(false);
    } finally {
      ext.restore();
    }
  });

  it("continues directly from a user/tool boundary without popping", async () => {
    const ext = await loadExtension();
    try {
      const manager = { getEntries: vi.fn(() => []) };
      const session = createFakeSession({ manager });
      (session as any)._omitRecoveryAttempt = vi.fn();
      const continueFn = vi.fn(async () => {});
      session.agent.continue = continueFn;
      registerManaged(manager, ext.api as unknown as object, DEFAULT_RETRY_CONFIG, true, false, session.agent, session);

      const ctx = { sessionManager: manager, ui: { notify: vi.fn() } };
      await ext.commands["retry"].handler("", ctx);

      expect((session as any)._omitRecoveryAttempt).not.toHaveBeenCalled();
      expect(continueFn).toHaveBeenCalledTimes(1);
    } finally {
      ext.restore();
    }
  });

  it("refuses to continue from a non-error assistant message", async () => {
    const ext = await loadExtension();
    try {
      const manager = { getEntries: vi.fn(() => []) };
      const session = createFakeSession({ manager });
      session.agent.state.messages = [
        userMessage(),
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
      ];
      const continueFn = vi.fn(async () => {});
      session.agent.continue = continueFn;
      registerManaged(manager, ext.api as unknown as object, DEFAULT_RETRY_CONFIG, true, false, session.agent, session);

      const ctx = { sessionManager: manager, ui: { notify: vi.fn() } };
      await ext.commands["retry"].handler("", ctx);

      expect(continueFn).not.toHaveBeenCalled();
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Cannot continue from an assistant message"),
        "warning",
      );
    } finally {
      ext.restore();
    }
  });

  it("registers continue as an alias with the same handler", async () => {
    const ext = await loadExtension();
    try {
      expect(ext.commands["continue"]).toBeDefined();
      const manager = { getEntries: vi.fn(() => []) };
      const session = createFakeSession({ manager });
      session.agent.continue = vi.fn(async () => {});
      registerManaged(manager, ext.api as unknown as object, DEFAULT_RETRY_CONFIG, true, false, session.agent, session);

      const ctx = { sessionManager: manager, ui: { notify: vi.fn() } };
      await ext.commands["continue"].handler("", ctx);
      expect(session.agent.continue).toHaveBeenCalledTimes(1);
    } finally {
      ext.restore();
    }
  });

  it("reports status including native retry attempt", async () => {
    const ext = await loadExtension();
    try {
      const manager = { getEntries: vi.fn(() => []) };
      const session = createFakeSession({ manager, retryAttempt: 2 });
      session.agent.state.messages = [userMessage(), errorMessage("Connection error")];
      registerManaged(manager, ext.api as unknown as object, DEFAULT_RETRY_CONFIG, true, false, session.agent, session);

      const ctx = { sessionManager: manager, ui: { notify: vi.fn() } };
      await ext.commands["retry"].handler("status", ctx);

      const status = ctx.ui.notify.mock.calls[0][0] as string;
      expect(status).toContain("Native session retry attempt: 2");
      expect(status).toContain("Connection Errors");
    } finally {
      ext.restore();
    }
  });
});

// ── Child policy ──

describe("native seam: child sessions", () => {
  it("applies the child policy to a managed child session", async () => {
    const ext = await loadExtension();
    try {
      const manager = {};
      registerManaged(
        manager,
        ext.api as unknown as object,
        { baseDelayMs: 500, maxDelayMs: 700, multiplier: 3, maxRetriesAtMaxDelay: 2 },
        true,
        true,
      );
      const session = createFakeSession({ manager });
      session.agent.state.messages = [userMessage(), errorMessage("Connection error")];

      const prepared = (ext.prototype._prepareRetry as any).call(session, errorMessage("Connection error"));
      await advance(1000);
      expect(await prepared).toBe(true);
      // Attempt 1 with the child config: 500 * (3/2)^0 → 500.
      expect(session._emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: "auto_retry_start", attempt: 1, delayMs: 500 }),
      );
    } finally {
      ext.restore();
    }
  });

  it("leaves native retry untouched when the child policy is disabled", async () => {
    const ext = await loadExtension();
    try {
      const manager = {};
      registerManaged(
        manager,
        ext.api as unknown as object,
        DEFAULT_RETRY_CONFIG,
        false,
        true,
      );
      const session = createFakeSession({ manager, settings: { enabled: true, baseDelayMs: 250 } });
      session.agent.state.messages = [userMessage(), errorMessage("Connection error")];
      const originalSettings = session.settingsManager.getRetrySettings;

      const prepared = (ext.prototype._prepareRetry as any).call(session, errorMessage("Connection error"));
      await advance(300);
      expect(await prepared).toBe(true);
      // Native ran with the untouched settings manager: delay 250 * 2^0.
      expect(session._emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: "auto_retry_start", delayMs: 250, maxAttempts: 3 }),
      );
      expect(session.settingsManager.getRetrySettings).toBe(originalSettings);
    } finally {
      ext.restore();
    }
  });
});

// ── Lifecycle bridge ──

describe("native seam: lifecycle event bridge", () => {
  it("mirrors native auto_retry events onto pi.events", async () => {
    const ext = await loadExtension();
    try {
      const manager = {};
      const listeners: Array<(event: { type: string }) => void> = [];
      const session = createFakeSession({ manager });
      (session as any).subscribe = vi.fn((listener: (event: { type: string }) => void) => {
        listeners.push(listener);
        return () => {};
      });
      recordRetrySessionAgent(manager, {} as Agent, session);
      track(manager, ext.api as unknown as object);

      const ctx = { sessionManager: manager, ui: { notify: vi.fn() } };
      for (const handler of ext.handlers["session_start"] ?? []) {
        await handler({}, ctx);
      }
      expect(listeners).toHaveLength(1);

      listeners[0]({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "x" });
      listeners[0]({ type: "auto_retry_end", success: true, attempt: 1 });
      listeners[0]({ type: "auto_retry_end", success: false, attempt: 2, finalError: "Retry cancelled" });

      expect(ext.api.events.emit).toHaveBeenCalledWith("pi-retry:started", { retryId: 1 });
      expect(ext.api.events.emit).toHaveBeenCalledWith("pi-retry:completed", { retryId: 1 });
      expect(ext.api.events.emit).toHaveBeenCalledWith("pi-retry:cancelled", { retryId: 1 });
    } finally {
      ext.restore();
    }
  });
});

// ── Non-retryable notification ──

describe("native seam: non-retryable notifications", () => {
  it("notifies on quota errors and skips silenced ones", async () => {
    const ext = await loadExtension();
    try {
      const manager = {
        getEntries: vi.fn()
          .mockReturnValueOnce([{ type: "message", message: errorMessage("You exceeded your current quota, please check your plan and billing") }])
          .mockReturnValue([
            { type: "message", message: errorMessage("You exceeded your current quota, please check your plan and billing") },
            { type: "message", message: errorMessage("Cannot continue from message role: assistant") },
          ]),
      };
      registerManaged(manager, ext.api as unknown as object);
      const ctx = {
        sessionManager: manager,
        ui: { notify: vi.fn() },
        signal: undefined,
      };

      for (const handler of ext.handlers["agent_end"] ?? []) {
        handler(
          { messages: [errorMessage("You exceeded your current quota, please check your plan and billing")] },
          ctx,
        );
        handler({ messages: [errorMessage("Cannot continue from message role: assistant")] }, ctx);
      }

      expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Quota/limit exhausted"),
        "error",
      );
    } finally {
      ext.restore();
    }
  });
});
