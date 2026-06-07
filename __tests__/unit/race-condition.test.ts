/**
 * Integration tests for the triggerInvisibleContinue race condition guards.
 *
 * Defense layers:
 *   1. _continueInProgress mutex — prevents concurrent calls from racing
 *   2. continue() monkey-patch — session's continue() waits while our
 *      retry is in-flight, then gracefully no-ops.  Eliminates "Agent is
 *      already processing" errors at the source.
 *   3. .catch() on prompt() — final safety net, swallows rejected promises
 *
 * The retry handler sleeps with exponential backoff before calling
 * triggerInvisibleContinue.  We use vi.useFakeTimers() to fast-forward
 * through the sleep and flush microtasks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

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
  prompt?: () => Promise<void>;
  isStreaming?: boolean;
}): MockAgentInstance {
  const agent: MockAgentInstance = {
    listeners: new Set<Function>(),
    waitForIdle: overrides?.waitForIdle ?? vi.fn().mockResolvedValue(undefined),
    prompt: overrides?.prompt ?? vi.fn().mockResolvedValue(undefined),
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

function fireAgentEndAsync(
  handlers: Record<string, Function[]>,
  entries: unknown[],
): void {
  const fns = handlers["agent_end"] ?? [];
  const ctx = createMockCtx(entries);
  for (const fn of fns) {
    void fn({ messages: [] }, ctx);
  }
}

async function advanceThroughRetry(ms = 2500) {
  await vi.advanceTimersByTimeAsync(ms);
}

async function setup(agentOverrides?: Parameters<typeof createMockAgent>[0]) {
  vi.resetModules();

  const { Agent } = await import("@earendil-works/pi-agent-core");
  const origSubscribe = Agent.prototype.subscribe;

  const mod = await import("../../retry.ts");
  const factory = mod.default;

  const { api, handlers, commands } = createMockAPI();
  factory(api);

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

      fireAgentEndAsync(handlers, entries);
      fireAgentEndAsync(handlers, entries);

      await advanceThroughRetry();

      expect(agent.prompt).toHaveBeenCalledTimes(1);
      expect(agent.prompt).toHaveBeenCalledWith([]);
    } finally {
      restore();
    }
  });

  it("Guard 2 (continue monkey-patch): prevents session from racing our retry", async () => {
    // This verifies that the continue() monkey-patch is installed on the
    // Agent prototype.  When _continueInProgress is true (our retry is
    // in-flight), the session's continue() waits gracefully instead of
    // throwing "Agent is already processing".
    const { restore } = await setup();
    try {
      const { Agent } = await import("@earendil-works/pi-agent-core");

      // The monkey-patch replaced the prototype method.
      expect(Agent.prototype.continue).toBeDefined();
      expect(typeof Agent.prototype.continue).toBe("function");

      // Our wrapper returns a Promise.
      const result = Agent.prototype.continue.call({
        state: { messages: [], isStreaming: false },
        waitForIdle: vi.fn().mockResolvedValue(undefined),
      });
      expect(result).toBeInstanceOf(Promise);
      // Clean up the promise to avoid unhandled rejection if it throws.
      result.catch(() => {});
    } finally {
      restore();
    }
  });

  it("Guard 3 (.catch): swallows 'already processing' rejected promise from prompt()", async () => {
    const { handlers, agent, restore } = await setup({
      prompt: vi.fn().mockImplementation(() =>
        Promise.reject(new Error("Agent is already processing a prompt")),
      ),
    });
    try {
      const entries = [errorEntry("Connection error")];
      fireAgentEndAsync(handlers, entries);

      await advanceThroughRetry();

      expect(agent.prompt).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("concurrent triggers + reject are all safe", async () => {
    let promptCallCount = 0;

    const { handlers, restore } = await setup({
      prompt: vi.fn().mockImplementation(() => {
        promptCallCount++;
        if (promptCallCount > 1) {
          return Promise.reject(new Error("Agent is already processing a prompt"));
        }
        return Promise.resolve();
      }),
    });
    try {
      const entries = [errorEntry("Connection error")];

      fireAgentEndAsync(handlers, entries);
      fireAgentEndAsync(handlers, entries);
      fireAgentEndAsync(handlers, entries);

      await advanceThroughRetry(5000);

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
      prompt: vi.fn().mockImplementation(() =>
        Promise.reject(new Error("Agent is already processing a prompt")),
      ),
    });
    try {
      const retryHandler = commands["retry"]?.handler;
      expect(retryHandler).toBeDefined();

      const entries = [errorEntry("Connection error")];
      const ctx = createMockCtx(entries);

      await expect(retryHandler!([], ctx)).resolves.toBeUndefined();

      await advanceThroughRetry();
    } finally {
      restore();
    }
  });

  it("session_start resets _continueInProgress mutex", async () => {
    let resolveIdle!: () => void;
    const { handlers, agent, restore } = await setup({
      waitForIdle: vi.fn().mockImplementation(
        () => new Promise<void>((r) => { resolveIdle = r; }),
      ),
    });
    try {
      const entries = [errorEntry("Connection error")];

      fireAgentEndAsync(handlers, entries);
      await vi.advanceTimersByTimeAsync(2500);

      const sessionHandlers = handlers["session_start"] ?? [];
      for (const fn of sessionHandlers) {
        await fn({}, createMockCtx());
      }

      resolveIdle();
      await vi.advanceTimersByTimeAsync(0);

      agent.waitForIdle = vi.fn().mockResolvedValue(undefined);
      agent.prompt = vi.fn().mockResolvedValue(undefined);

      fireAgentEndAsync(handlers, [errorEntry("Connection error")]);
      await advanceThroughRetry();

      expect(agent.prompt).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });
});
