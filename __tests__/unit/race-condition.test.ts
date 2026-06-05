/**
 * Integration tests for the triggerInvisibleContinue race condition guards.
 *
 * Four-layer defense against "Agent is already processing" errors:
 *   1. _continueInProgress mutex — prevents concurrent calls from racing
 *   2. waitForIdle + settle loop — waits for session to fully finish
 *   3. isStreaming pre-flight — detects user-initiated runs before prompt()
 *   4. .catch() on prompt() — final safety net, swallows rejected promises
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
  state: { isStreaming: boolean; messages: AgentMessage[]; tools: unknown[] };
  subscribe(listener: Function): () => boolean;
  _setIsStreaming(val: boolean): void;
}

function createMockAgent(overrides?: {
  waitForIdle?: () => Promise<void>;
  prompt?: () => Promise<void>;
  isStreaming?: boolean;
  messages?: AgentMessage[];
}): MockAgentInstance {
  const agent: MockAgentInstance = {
    listeners: new Set<Function>(),
    waitForIdle: overrides?.waitForIdle ?? vi.fn().mockResolvedValue(undefined),
    prompt: overrides?.prompt ?? vi.fn().mockResolvedValue(undefined),
    state: {
      isStreaming: overrides?.isStreaming ?? false,
      messages: overrides?.messages ?? [],
      tools: [],
    },
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

  it("Guard 2 (settle loop): waits for session to finish its own continue() calls", async () => {
    // Simulate: session's built-in retry calls continue() after our waitForIdle resolves.
    // The session sets isStreaming=true when it starts a new run via continue().
    let waitForIdleCallCount = 0;
    const { handlers, agent, restore } = await setup({
      waitForIdle: vi.fn().mockImplementation(async () => {
        waitForIdleCallCount++;
        // First waitForIdle: simulate the session's continue() starting a
        // new run (sets isStreaming=true).  It will finish on the next call.
        if (waitForIdleCallCount === 1) {
          agent._setIsStreaming(true);
        } else {
          // Second+ call: the session's run has finished
          agent._setIsStreaming(false);
        }
      }),
    });
    try {
      const entries = [errorEntry("Connection error")];
      fireAgentEndAsync(handlers, entries);

      await advanceThroughRetry(5000);

      // Our code should have waited for the session's run to finish
      // (isStreaming went back to false) before calling prompt().
      expect(agent.waitForIdle).toHaveBeenCalledTimes(2);
      expect(agent.prompt).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("Guard 2 (settle loop): bails out when session handles the retry itself", async () => {
    // The session's continue() starts a new run that doesn't finish —
    // our code should detect the ongoing stream and not call prompt().
    const { handlers, agent, restore } = await setup({
      waitForIdle: vi.fn().mockImplementation(async () => {
        // Session started a new run and it's still streaming — our code
        // should detect this and bail.
        agent._setIsStreaming(true);
      }),
    });
    try {
      const entries = [errorEntry("Connection error")];
      fireAgentEndAsync(handlers, entries);

      await advanceThroughRetry(5000);

      // The settle loop kept seeing isStreaming=true → never called prompt()
      expect(agent.prompt).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("Guard 3 (isStreaming): skips prompt() when user started a new run", async () => {
    const { handlers, agent, restore } = await setup({
      waitForIdle: vi.fn().mockImplementation(async () => {
        agent._setIsStreaming(true);
      }),
    });
    try {
      const entries = [errorEntry("Connection error")];
      fireAgentEndAsync(handlers, entries);

      await advanceThroughRetry();

      expect(agent.prompt).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("Guard 4 (.catch): swallows 'already processing' rejected promise from prompt()", async () => {
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

  it("combines all guards: concurrent triggers + session retry + reject are all safe", async () => {
    let promptCallCount = 0;

    const { handlers, agent, restore } = await setup({
      waitForIdle: vi.fn().mockImplementation(async () => {
        agent._setIsStreaming(true);
      }),
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

  it("strips the error assistant message from the transcript before retrying", async () => {
    const errorAssistant = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "Connection error",
      content: [],
    } as unknown as AgentMessage;
    const userMsg = {
      role: "user",
      content: [{ type: "text", text: "hello" }],
    } as unknown as AgentMessage;

    const { handlers, agent, restore } = await setup({
      messages: [userMsg, errorAssistant],
    });
    try {
      const entries = [errorEntry("Connection error")];
      fireAgentEndAsync(handlers, entries);

      await advanceThroughRetry();

      // The error assistant message should have been stripped
      expect(agent.state.messages.length).toBe(1);
      expect(agent.state.messages[0].role).toBe("user");
      expect(agent.prompt).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("restores the error assistant message if prompt fails", async () => {
    const errorAssistant = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "Connection error",
      content: [],
    } as unknown as AgentMessage;
    const userMsg = {
      role: "user",
      content: [{ type: "text", text: "hello" }],
    } as unknown as AgentMessage;

    const { handlers, agent, restore } = await setup({
      prompt: vi.fn().mockImplementation(() =>
        Promise.reject(new Error("Agent is already processing a prompt")),
      ),
      messages: [userMsg, errorAssistant],
    });
    try {
      const entries = [errorEntry("Connection error")];
      fireAgentEndAsync(handlers, entries);

      await advanceThroughRetry();

      // prompt failed — the error assistant message should be restored
      expect(agent.state.messages.length).toBe(2);
      expect(agent.state.messages[1].role).toBe("assistant");
      expect(agent.prompt).toHaveBeenCalledTimes(1);
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
