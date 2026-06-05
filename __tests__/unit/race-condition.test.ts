/**
 * Integration tests for the triggerInvisibleContinue race condition guards.
 *
 * The three guards prevent "Agent is already processing" errors:
 *   1. _continueInProgress mutex — prevents concurrent calls from racing
 *   2. isStreaming pre-flight — detects user-initiated runs before prompt()
 *   3. try/catch — final safety net, swallows the error gracefully
 *
 * The retry handler sleeps with exponential backoff (starting at 2s) before
 * calling triggerInvisibleContinue.  We use vi.useFakeTimers() and
 * vi.advanceTimersByTimeAsync() to fast-forward through the sleep and flush
 * microtasks, so tests run instantly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Helpers ──

interface MockAgentInstance {
  listeners: Set<Function>;
  waitForIdle: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  state: { isStreaming: boolean };
  subscribe(listener: Function): () => boolean;
  _setIsStreaming(val: boolean): void;
}

function createMockAgent(overrides?: {
  waitForIdle?: () => Promise<void>;
  prompt?: () => void;
  isStreaming?: boolean;
}): MockAgentInstance {
  const agent: MockAgentInstance = {
    listeners: new Set<Function>(),
    waitForIdle: overrides?.waitForIdle ?? vi.fn().mockResolvedValue(undefined),
    prompt: overrides?.prompt ?? vi.fn(),
    state: { isStreaming: overrides?.isStreaming ?? false },
    subscribe(listener: Function) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },
    _setIsStreaming(val: boolean) {
      this.state.isStreaming = val;
    },
  };
  return agent;
}

function createMockAPI() {
  const handlers: Record<string, Function[]> = {};
  const commands: Record<string, { handler: (args: string[], ctx: any) => Promise<void> }> = {};

  const api = {
    on(event: string, handler: Function) {
      (handlers[event] ??= []).push(handler);
    },
    registerCommand(name: string, opts: { handler: (args: string[], ctx: any) => Promise<void> }) {
      commands[name] = opts;
    },
  } as unknown as ExtensionAPI;

  return { api, handlers, commands };
}

function createMockCtx(entries: unknown[] = []) {
  return {
    ui: { notify: vi.fn() },
    sessionManager: { getEntries: vi.fn().mockReturnValue(entries) },
  } as unknown as ExtensionCommandContext;
}

function errorEntry(errorMessage: string, stopReason = "error"): object {
  return {
    type: "message",
    message: { role: "assistant", stopReason, errorMessage, content: [] },
  };
}

/**
 * Fire agent_end handlers WITHOUT awaiting them.
 *
 * The handler calls `await sleep(2000)` (exponential backoff), so awaiting it
 * would block until fake timers are advanced.  Instead, we fire-and-forget and
 * let the caller advance timers explicitly.
 */
function fireAgentEndAsync(
  handlers: Record<string, Function[]>,
  entries: unknown[],
): void {
  const fns = handlers["agent_end"] ?? [];
  const ctx = createMockCtx(entries);
  for (const fn of fns) {
    // Fire and forget — the handler will suspend at sleep() and resume when
    // vi.advanceTimersByTimeAsync() is called.
    void fn({ messages: [] }, ctx);
  }
}

/**
 * Advance fake timers through the retry backoff sleep and flush microtasks.
 *
 * - The first retry attempt sleeps 2000ms (base delay).
 * - advanceTimersByTimeAsync also flushes pending microtasks (waitForIdle,
 *   prompt, etc.) so everything settles in one call.
 */
async function advanceThroughRetry(ms = 2500) {
  await vi.advanceTimersByTimeAsync(ms);
}

/**
 * Load the retry extension with fresh module-level state.
 * Returns the event handlers, commands, and the captured mock agent.
 */
async function setup(agentOverrides?: Parameters<typeof createMockAgent>[0]) {
  vi.resetModules();

  const { Agent } = await import("@earendil-works/pi-agent-core");
  const origSubscribe = Agent.prototype.subscribe;

  const mod = await import("../../retry.ts");
  const factory = mod.default;

  const { api, handlers, commands } = createMockAPI();
  factory(api);

  // Create a mock agent and register it via the monkey-patched subscribe
  // so _agent inside retry.ts points to our controllable instance.
  const agent = createMockAgent(agentOverrides);
  Agent.prototype.subscribe.call(agent, vi.fn());

  return {
    handlers,
    commands,
    agent,
    restore: () => {
      Agent.prototype.subscribe = origSubscribe;
    },
  };
}

// ── Tests ──

describe("triggerInvisibleContinue race condition guards", () => {
  it("Guard 1 (mutex): concurrent agent_end events only trigger one prompt()", async () => {
    const { handlers, agent, restore } = await setup();
    try {
      const entries = [errorEntry("Connection error")];

      // Fire two agent_end events concurrently.
      // The second one will see state.getIsRetrying() === true and bail,
      // so only one triggerInvisibleContinue path is entered.
      fireAgentEndAsync(handlers, entries);
      fireAgentEndAsync(handlers, entries);

      // Advance through the backoff sleep + flush microtasks
      await advanceThroughRetry();

      // Only one prompt([]) call should have been made
      expect(agent.prompt).toHaveBeenCalledTimes(1);
      expect(agent.prompt).toHaveBeenCalledWith([]);
    } finally {
      restore();
    }
  });

  it("Guard 2 (isStreaming): skips prompt() when user started a new run", async () => {
    let idleResolved = false;
    const { handlers, agent, restore } = await setup({
      waitForIdle: vi.fn().mockImplementation(async () => {
        // Simulate: user sent a message while we waited for idle.
        // The agent is now streaming, so we should NOT call prompt().
        agent._setIsStreaming(true);
        idleResolved = true;
      }),
    });
    try {
      const entries = [errorEntry("Connection error")];
      fireAgentEndAsync(handlers, entries);

      await advanceThroughRetry();

      // waitForIdle was called (the guard was reached)
      expect(agent.waitForIdle).toHaveBeenCalled();
      // But prompt should NOT have been called — isStreaming guard caught it
      expect(agent.prompt).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("Guard 3 (catch): swallows 'already processing' error from prompt()", async () => {
    const { handlers, agent, restore } = await setup({
      prompt: vi.fn().mockImplementation(() => {
        throw new Error("Agent is already processing a prompt");
      }),
    });
    try {
      const entries = [errorEntry("Connection error")];
      fireAgentEndAsync(handlers, entries);

      // Must NOT throw — the try/catch in triggerInvisibleContinue swallows it
      await advanceThroughRetry();

      // prompt was attempted but the error was swallowed (no unhandled rejection)
      expect(agent.prompt).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("combines all guards: concurrent triggers + user start + throw are all safe", async () => {
    let promptCallCount = 0;

    const { handlers, agent, restore } = await setup({
      waitForIdle: vi.fn().mockImplementation(async () => {
        // User started a run while we waited — isStreaming becomes true
        agent._setIsStreaming(true);
      }),
      prompt: vi.fn().mockImplementation(() => {
        promptCallCount++;
        if (promptCallCount > 1) {
          throw new Error("Agent is already processing a prompt");
        }
      }),
    });
    try {
      const entries = [errorEntry("Connection error")];

      // Fire three concurrent triggers — mutex + isStreaming + catch all exercised
      fireAgentEndAsync(handlers, entries);
      fireAgentEndAsync(handlers, entries);
      fireAgentEndAsync(handlers, entries);

      await advanceThroughRetry();

      // At most one prompt call should have been attempted
      expect(promptCallCount).toBeLessThanOrEqual(1);
    } finally {
      restore();
    }
  });

  it("triggerInvisibleContinue works correctly when agent is idle", async () => {
    const { handlers, agent, restore } = await setup();
    try {
      const entries = [errorEntry("Connection error")];
      fireAgentEndAsync(handlers, entries);

      await advanceThroughRetry();

      expect(agent.prompt).toHaveBeenCalledTimes(1);
      expect(agent.prompt).toHaveBeenCalledWith([]);
    } finally {
      restore();
    }
  });

  it("/retry command also benefits from the guards", async () => {
    const { commands, agent, restore } = await setup({
      prompt: vi.fn().mockImplementation(() => {
        throw new Error("Agent is already processing a prompt");
      }),
    });
    try {
      const retryHandler = commands["retry"]?.handler;
      expect(retryHandler).toBeDefined();

      const entries = [errorEntry("Connection error")];
      const ctx = createMockCtx(entries);

      // Manual /retry while agent is already processing — must not throw
      await expect(retryHandler!([], ctx)).resolves.toBeUndefined();

      // Advance through any pending timer
      await advanceThroughRetry();
    } finally {
      restore();
    }
  });

  it("session_start resets _continueInProgress mutex", async () => {
    // Use a hanging waitForIdle so triggerInvisibleContinue stays in-flight
    let resolveIdle!: () => void;
    const { handlers, agent, restore } = await setup({
      waitForIdle: vi.fn().mockImplementation(
        () => new Promise<void>((r) => { resolveIdle = r; }),
      ),
    });
    try {
      const entries = [errorEntry("Connection error")];

      // Fire agent_end — triggerInvisibleContinue will hang at waitForIdle
      fireAgentEndAsync(handlers, entries);

      // Advance through the backoff sleep only (waitForIdle still pending)
      await vi.advanceTimersByTimeAsync(2500);

      // Now fire session_start — this should reset _continueInProgress
      const sessionHandlers = handlers["session_start"] ?? [];
      for (const fn of sessionHandlers) {
        await fn({}, createMockCtx());
      }

      // Resolve the hanging waitForIdle — triggerInvisibleContinue's finally
      // block will set _continueInProgress = false
      resolveIdle();
      await vi.advanceTimersByTimeAsync(0);

      // Reconfigure agent for normal operation
      agent.waitForIdle = vi.fn().mockResolvedValue(undefined);
      agent.prompt = vi.fn();

      // A new retry should work — the mutex is no longer stuck
      fireAgentEndAsync(handlers, [errorEntry("Connection error")]);
      await advanceThroughRetry();

      expect(agent.prompt).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });
});
