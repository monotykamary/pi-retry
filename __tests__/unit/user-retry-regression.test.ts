/**
 * Regression tests for reported retry behaviors, rebased onto the native seam.
 *
 * - Manual /retry continues even after the automatic retry cap is exhausted.
 * - Per-category counters are independent: exhausting one category's cap does
 *   not block retries for a different error category.
 * - The delegated backoff schedule matches the configured base/multiplier/cap.
 * - Resetting one session's counters never leaks into sibling sessions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Agent } from "@earendil-works/pi-agent-core";
import { DEFAULT_RETRY_CONFIG } from "../../src/config.js";
import {
  recordRetrySessionAgent,
  registerRetrySession,
  unregisterRetrySession,
  getRetrySession,
  type AgentSessionLike,
} from "../../src/session-registry.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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
    restore: () => {
      prototype._prepareRetry = realPrepare;
    },
  };
}

function createFakeSession(options: { manager: object }) {
  const agent = {
    state: { messages: [userMessage()] as any[] },
  } as Agent;
  return {
    sessionManager: options.manager,
    agent,
    settingsManager: {
      getRetrySettings: vi.fn(() => ({
        enabled: true,
        maxRetries: 3,
        baseDelayMs: 2000,
        maxAgentDelayMs: 60000,
      })),
    },
    _retryAttempt: 0,
    _emit: vi.fn(),
    model: undefined,
  } as unknown as AgentSessionLike & {
    _retryAttempt: number;
    _emit: ReturnType<typeof vi.fn>;
    agent: Agent;
    settingsManager: { getRetrySettings: ReturnType<typeof vi.fn> };
  };
}

function registerManaged(
  manager: object,
  owner: object,
  config = DEFAULT_RETRY_CONFIG,
  managedRetry = true,
  isChild = false,
  agent?: Agent,
  session?: AgentSessionLike,
) {
  recordRetrySessionAgent(manager, agent ?? ({} as Agent), session);
  track(manager, owner);
  return registerRetrySession(manager, owner, {
    isChild,
    managedRetry,
    config,
  })!.binding;
}

async function prepare(ext: Awaited<ReturnType<typeof loadExtension>>, session: AgentSessionLike, message: unknown): Promise<boolean> {
  const promise = (ext.prototype._prepareRetry as any).call(session, message);
  await vi.advanceTimersByTimeAsync(130_000);
  return promise;
}

describe("reported retry regressions (native seam)", () => {
  // Manual /retry is explicit intent: it bypasses the classifier and veto, so
  // a session that exhausted its automatic retries stays manually recoverable.
  it("allows manual /retry continue after the automatic cap is exhausted", async () => {
    const ext = await loadExtension();
    try {
      const manager = {};
      const cap = 100;
      const session = createFakeSession({ manager });
      registerManaged(manager, ext.api as unknown as object, {
        baseDelayMs: cap,
        maxDelayMs: cap,
        multiplier: 2,
        maxRetriesAtMaxDelay: 3,
      }, true, false, session.agent, session);
      const failure = errorMessage("Connection error");

      for (let i = 0; i < 3; i++) {
        expect(await prepare(ext, session, failure)).toBe(true);
      }
      expect(await prepare(ext, session, failure)).toBe(false);

      // Manual continue: pop the error and continue, no backoff, no veto.
      const user = userMessage();
      session.agent.state.messages = [user, failure];
      (session as any)._omitRecoveryAttempt = vi.fn(() => {
        session.agent.state.messages = [user];
      });
      session.agent.continue = vi.fn(async () => {});

      const ctx = { sessionManager: manager, ui: { notify: vi.fn() } };
      await ext.commands["retry"].handler("", ctx);
      expect((session as any)._omitRecoveryAttempt).toHaveBeenCalledWith(failure);
      expect(session.agent.continue).toHaveBeenCalledTimes(1);
    } finally {
      ext.restore();
    }
  });

  // Counters are per category: a connection storm must not eat the credit
  // retry budget (and vice versa).
  it("keeps per-category caps independent", async () => {
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
      const connection = errorMessage("Connection error");
      const credit = errorMessage("not enough credits");

      for (let i = 0; i < 3; i++) {
        expect(await prepare(ext, session, connection)).toBe(true);
      }
      expect(await prepare(ext, session, connection)).toBe(false);

      // A different category still gets its full budget.
      expect(await prepare(ext, session, credit)).toBe(true);
    } finally {
      ext.restore();
    }
  });

  // The delegated schedule must match base * multiplier^(N-1) with the cap.
  it("follows the configured backoff schedule through native delays", async () => {
    const ext = await loadExtension();
    try {
      const manager = {};
      registerManaged(manager, ext.api as unknown as object, {
        baseDelayMs: 2000,
        maxDelayMs: 8000,
        multiplier: 2,
        maxRetriesAtMaxDelay: 3,
      });
      const session = createFakeSession({ manager });
      const failure = errorMessage("Connection error");

      const expected = [2000, 4000, 8000, 8000, 8000];
      for (const delay of expected) {
        const promise = (ext.prototype._prepareRetry as any).call(session, failure);
        await vi.advanceTimersByTimeAsync(delay);
        expect(await promise).toBe(true);
        expect(session._emit).toHaveBeenLastCalledWith(
          expect.objectContaining({ delayMs: delay }),
        );
      }
      // Three at-cap attempts (8000) are scheduled; the next one is vetoed.
      expect(await (ext.prototype._prepareRetry as any).call(session, failure)).toBe(false);
    } finally {
      ext.restore();
    }
  });

  // Session isolation: resetting session A's counters must not resurrect
  // session B's veto budget.
  it("keeps sibling sessions' veto budgets isolated through /retry reset", async () => {
    const ext = await loadExtension();
    try {
      const managerA = {};
      const managerB = {};
      const capConfig = {
        baseDelayMs: 100,
        maxDelayMs: 100,
        multiplier: 2,
        maxRetriesAtMaxDelay: 3,
      };
      const sessionA = createFakeSession({ manager: managerA });
      const sessionB = createFakeSession({ manager: managerB });
      registerManaged(managerA, ext.api as unknown as object, capConfig, true, false, sessionA.agent, sessionA);
      registerManaged(managerB, ext.api as unknown as object, capConfig, true, false, sessionB.agent, sessionB);
      const failure = errorMessage("Connection error");

      for (let i = 0; i < 3; i++) {
        expect(await prepare(ext, sessionA, failure)).toBe(true);
      }
      expect(await prepare(ext, sessionA, failure)).toBe(false);

      const ctxB = { sessionManager: managerB, ui: { notify: vi.fn() } };
      await ext.commands["retry"].handler("reset", ctxB);
      expect(getRetrySession(managerA)!.retry.failuresAtCap.connection ?? 0).toBe(3);
      expect(getRetrySession(managerB)!.retry.failuresAtCap.connection ?? 0).toBe(0);

      // Session B still has its full budget after A's reset.
      expect(await prepare(ext, sessionB, failure)).toBe(true);
      // Session A remains capped.
      expect(await prepare(ext, sessionA, failure)).toBe(false);
    } finally {
      ext.restore();
    }
  });
});
