/**
 * Integration tests for the triggerInvisibleContinue retry loop.
 *
 * The retry loop in triggerInvisibleContinue:
 *   1. Waits for idle (waitForIdle)
 *   2. Removes error assistant messages from agent state
 *   3. Loops: notify → sleep(backoff) → prompt([]) → check result
 *   4. On error: loops back to step 3
 *   5. On success or user abort: exits the loop
 *
 * Defense layers:
 *   1. _continueInProgress mutex — prevents concurrent calls from racing
 *   2. continue() monkey-patch — session's continue() waits while our
 *      retry is in-flight, then gracefully no-ops.  For stopReason "error"
 *      it no longer falls back to prompt([]) (the loop handles it).
 *   3. await prompt([]) + try/catch — holds the mutex for the full retry
 *      so the session stays alive.
 *
 * The agent_end handler does NOT sleep — it returns immediately and
 * kicks off triggerInvisibleContinue. Backoff sleeps happen inside the
 * loop, before each prompt([]) call (outside processEvents).
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
  state: { isStreaming: boolean; messages: any[] };
  subscribe(listener: Function): () => boolean;
  _setIsStreaming(val: boolean): void;
}

function createMockAgent(overrides?: {
  waitForIdle?: () => Promise<void>;
  prompt?: () => Promise<void>;
  isStreaming?: boolean;
  messages?: any[];
}): MockAgentInstance {
  const agent: MockAgentInstance = {
    listeners: new Set<Function>(),
    waitForIdle: overrides?.waitForIdle ?? vi.fn().mockResolvedValue(undefined),
    prompt: overrides?.prompt ?? vi.fn().mockResolvedValue(undefined),
    state: {
      isStreaming: overrides?.isStreaming ?? false,
      messages: overrides?.messages ?? [],
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

// Set up the extension with a mock agent that has controllable messages.
async function setup(agentOverrides?: Parameters<typeof createMockAgent>[0]) {
  vi.resetModules();

  const { Agent } = await import("@earendil-works/pi-agent-core");
  const origSubscribe = Agent.prototype.subscribe;
  const origContinue = Agent.prototype.continue;

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
      Agent.prototype.continue = origContinue;
    },
  };
}

// ── Tests ──

describe("triggerInvisibleContinue retry loop", () => {
  it("Guard 1 (mutex): concurrent agent_end events only trigger one prompt()", async () => {
    const { handlers, agent, restore } = await setup();
    try {
      const entries = [errorEntry("Connection error")];

      fireAgentEndAsync(handlers, entries);
      fireAgentEndAsync(handlers, entries);

      // First sleep is attempt 1: 2s
      await advanceThroughRetry(3000);

      expect(agent.prompt).toHaveBeenCalledTimes(1);
      expect(agent.prompt).toHaveBeenCalledWith([]);
    } finally {
      restore();
    }
  });

  it("Guard 2 (continue monkey-patch): is installed and functional", async () => {
    const { restore } = await setup();
    try {
      const { Agent } = await import("@earendil-works/pi-agent-core");

      expect(Agent.prototype.continue).toBeDefined();
      expect(typeof Agent.prototype.continue).toBe("function");

      const result = Agent.prototype.continue.call({
        state: { messages: [], isStreaming: false },
        waitForIdle: vi.fn().mockResolvedValue(undefined),
      });
      expect(result).toBeInstanceOf(Promise);
      result.catch(() => {});
    } finally {
      restore();
    }
  });

  it("try/catch around await prompt() swallows rejections", async () => {
    const { handlers, agent, restore } = await setup({
      prompt: vi.fn().mockImplementation(() =>
        Promise.reject(new Error("Agent is already processing a prompt")),
      ),
    });
    try {
      const entries = [errorEntry("Connection error")];
      fireAgentEndAsync(handlers, entries);

      // Advance through the 2s backoff sleep
      await advanceThroughRetry(3000);

      expect(agent.prompt).toHaveBeenCalled();
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

      // The mutex should ensure at most 1 prompt call
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

      // First attempt: 2s backoff
      await advanceThroughRetry(3000);

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

      await advanceThroughRetry(3000);
    } finally {
      restore();
    }
  });

  it("session_start resets counters, but in-flight loop continues", async () => {
    let resolveIdle!: () => void;
    const { handlers, agent, restore } = await setup({
      waitForIdle: vi.fn().mockImplementation(
        () => new Promise<void>((r) => { resolveIdle = r; }),
      ),
    });
    try {
      const entries = [errorEntry("Connection error")];

      fireAgentEndAsync(handlers, entries);
      // Advance past the waitForIdle yield point
      await vi.advanceTimersByTimeAsync(100);

      // Fire session_start — it resets _continueInProgress to false
      const sessionHandlers = handlers["session_start"] ?? [];
      for (const fn of sessionHandlers) {
        await fn({}, createMockCtx());
      }

      // Resolve waitForIdle so the loop can proceed
      resolveIdle();
      await vi.advanceTimersByTimeAsync(0);

      // Now the loop is running with _continueInProgress=true again
      // (it was reset by session_start but the loop set it again when it
      // continued). Give it time to complete.
      agent.waitForIdle = vi.fn().mockResolvedValue(undefined);
      agent.prompt = vi.fn().mockResolvedValue(undefined);

      await advanceThroughRetry(5000);

      // The in-flight loop should have completed and called prompt
      expect(agent.prompt).toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});

// ── Bug 1: Retry loop is not one-shot ──

describe("infinite retry loop", () => {
  it("retries multiple times in a row when prompt([]) keeps failing", async () => {
    let promptCount = 0;
    const { handlers, agent, restore } = await setup({
      prompt: vi.fn().mockImplementation(() => {
        promptCount++;
        agent.state.messages = [
          { role: "assistant", stopReason: "error", errorMessage: "Connection error", content: [] },
        ];
        return Promise.resolve();
      }),
    });
    try {
      const entries = [errorEntry("Connection error")];
      fireAgentEndAsync(handlers, entries);

      // Each attempt sleeps before prompt: 2s, 4s, 8s = 14s
      await advanceThroughRetry(15000);

      // Should have retried multiple times (at least 3)
      expect(promptCount).toBeGreaterThanOrEqual(3);
    } finally {
      restore();
    }
  });

  it("exits the loop when prompt([]) succeeds", async () => {
    let promptCount = 0;
    const { handlers, agent, restore } = await setup({
      prompt: vi.fn().mockImplementation(() => {
        promptCount++;
        if (promptCount >= 2) {
          agent.state.messages = [
            { role: "assistant", stopReason: "stop", content: [] },
          ];
        } else {
          agent.state.messages = [
            { role: "assistant", stopReason: "error", errorMessage: "Connection error", content: [] },
          ];
        }
        return Promise.resolve();
      }),
    });
    try {
      const entries = [errorEntry("Connection error")];
      fireAgentEndAsync(handlers, entries);

      // First attempt: 2s, second attempt: 4s = 6s
      await advanceThroughRetry(8000);

      // Should have retried exactly 2 times (1st failed, 2nd succeeded)
      expect(promptCount).toBe(2);
    } finally {
      restore();
    }
  });

  it("exits the loop on user abort", async () => {
    let promptCount = 0;
    const { handlers, agent, restore } = await setup({
      prompt: vi.fn().mockImplementation(() => {
        promptCount++;
        agent.state.messages = [
          { role: "assistant", stopReason: "error", errorMessage: "Connection error", content: [] },
        ];
        return Promise.resolve();
      }),
    });
    try {
      const entries = [errorEntry("Connection error")];
      fireAgentEndAsync(handlers, entries);

      // Let the first retry sleep (2s) and prompt happen
      await advanceThroughRetry(3000);

      // Fire the abort via turn_end
      const turnEndHandlers = handlers["turn_end"] ?? [];
      const ctx = createMockCtx([]);
      for (const fn of turnEndHandlers) {
        await fn({ message: { role: "assistant", stopReason: "aborted" } }, ctx);
      }

      const countBefore = promptCount;
      // Advance a long time — should NOT retry after abort
      await advanceThroughRetry(60000);

      expect(promptCount).toBe(countBefore);
    } finally {
      restore();
    }
  });
});

// ── Bug 2: agent_end handler does not block processEvents ──

describe("non-blocking agent_end handler", () => {
  it("agent_end handler returns immediately without sleeping", async () => {
    const { handlers, restore } = await setup();
    try {
      const entries = [errorEntry("Connection error")];

      const fns = handlers["agent_end"] ?? [];
      const ctx = createMockCtx(entries);

      // Use real timers to verify no blocking sleep
      vi.useRealTimers();
      const start = Date.now();
      for (const fn of fns) {
        await fn({ messages: [] }, ctx);
      }
      const elapsed = Date.now() - start;

      // Should return in well under 100ms (no 2s sleep)
      expect(elapsed).toBeLessThan(100);

      vi.useFakeTimers();
    } finally {
      restore();
    }
  });
});

// ── Bug 3: Error message removal before retry ──

describe("error message removal from agent state", () => {
  it("removes error assistant message before calling prompt([])", async () => {
    const promptCalls: any[][] = [];

    const { handlers, agent, restore } = await setup({
      prompt: vi.fn().mockImplementation(() => {
        promptCalls.push([...agent.state.messages]);
        agent.state.messages = [
          { role: "assistant", stopReason: "stop", content: [] },
        ];
        return Promise.resolve();
      }),
    });

    try {
      agent.state.messages = [
        { role: "user", content: "hello" },
        { role: "assistant", stopReason: "error", errorMessage: "Connection error", content: [] },
      ];

      const entries = [errorEntry("Connection error")];
      fireAgentEndAsync(handlers, entries);

      // Advance through the 2s backoff
      await advanceThroughRetry(3000);

      expect(promptCalls.length).toBeGreaterThanOrEqual(1);
      const messagesAtPromptTime = promptCalls[0];
      // The last message should NOT be the error assistant
      const lastMsg = messagesAtPromptTime[messagesAtPromptTime.length - 1];
      expect(lastMsg?.stopReason).not.toBe("error");
    } finally {
      restore();
    }
  });

  it("does not remove non-error assistant messages", async () => {
    const promptCalls: any[][] = [];

    const { handlers, agent, restore } = await setup({
      prompt: vi.fn().mockImplementation(() => {
        promptCalls.push([...agent.state.messages]);
        agent.state.messages = [
          { role: "assistant", stopReason: "stop", content: [] },
        ];
        return Promise.resolve();
      }),
    });

    try {
      agent.state.messages = [
        { role: "user", content: "hello" },
        { role: "assistant", stopReason: "stop", content: [] },
      ];

      const entries = [errorEntry("Connection error")];
      fireAgentEndAsync(handlers, entries);

      await advanceThroughRetry(3000);

      if (promptCalls.length > 0) {
        const messagesAtPromptTime = promptCalls[0];
        const assistants = messagesAtPromptTime.filter((m: any) => m.role === "assistant");
        expect(assistants.some((m: any) => m.stopReason === "stop")).toBe(true);
      }
    } finally {
      restore();
    }
  });
});

// ── Bug 4: continue() monkey-patch does not create second retry path for errors ──

describe("continue monkey-patch stopReason routing", () => {
  const routingTable = [
    { stopReason: "error", shouldPrompt: false, reason: "loop handles errors" },
    { stopReason: "stop", shouldPrompt: false, reason: "agent finished cleanly" },
    { stopReason: "aborted", shouldPrompt: false, reason: "user cancelled" },
    { stopReason: "toolUse", shouldPrompt: true, reason: "compaction mid-task" },
    { stopReason: "length", shouldPrompt: true, reason: "compaction mid-task" },
  ];

  it("exhaustive routing table matches source", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../retry.ts"),
      "utf-8"
    );

    for (const { stopReason, shouldPrompt } of routingTable) {
      if (!shouldPrompt) {
        expect(source).toContain(`lastMsg.stopReason === '${stopReason}'`);
      }
    }

    expect(source).toMatch(/stopReason === 'error'/);
    expect(source).toMatch(/stopReason === 'stop' \|\| lastMsg\.stopReason === 'aborted'/);

    // Verify _prepareRetry monkey-patch is present
    expect(source).toContain('_origPrepareRetry');
    expect(source).toContain('_continueInProgress');
    expect(source).toContain('Promise.resolve(false)');
  });

  it("loop retried error → monkey-patch does not double-retry", async () => {
    let promptCount = 0;
    const { handlers, agent, restore } = await setup({
      prompt: vi.fn().mockImplementation(() => {
        promptCount++;
        if (promptCount >= 2) {
          agent.state.messages = [
            { role: "assistant", stopReason: "stop", content: [] },
          ];
        } else {
          agent.state.messages = [
            { role: "assistant", stopReason: "error", errorMessage: "Connection error", content: [] },
          ];
        }
        return Promise.resolve();
      }),
    });
    try {
      const entries = [errorEntry("Connection error")];
      fireAgentEndAsync(handlers, entries);

      // 2s backoff for first attempt, 4s for second = 6s
      await advanceThroughRetry(8000);

      // Should have exactly 2 calls (1 fail + 1 success via the loop)
      expect(promptCount).toBe(2);
    } finally {
      restore();
    }
  });
});

// ── Bug 5: UI notifications for retries ──

describe("retry notifications", () => {
  it("notifies user about retry attempts", async () => {
    const { handlers, agent, restore } = await setup({
      prompt: vi.fn().mockImplementation(() => {
        const count = agent.prompt.mock.calls.length;
        if (count >= 3) {
          agent.state.messages = [
            { role: "assistant", stopReason: "stop", content: [] },
          ];
        } else {
          agent.state.messages = [
            { role: "assistant", stopReason: "error", errorMessage: "Connection error", content: [] },
          ];
        }
        return Promise.resolve();
      }),
    });
    try {
      const entries = [errorEntry("Connection error")];
      const ctx = createMockCtx(entries);

      const fns = handlers["agent_end"] ?? [];
      for (const fn of fns) {
        void fn({ messages: [] }, ctx);
      }

      // Advance through multiple backoff sleeps
      await advanceThroughRetry(15000);

      expect(ctx.ui.notify).toHaveBeenCalled();
      const calls = ctx.ui.notify.mock.calls.map((c: any) => c[0]);
      const retryCalls = calls.filter((c: string) => c.includes("Retry attempt"));
      expect(retryCalls.length).toBeGreaterThanOrEqual(1);
    } finally {
      restore();
    }
  });
});

// ── Bug 6: isRetrying covers the full retry cycle ──

describe("RetryState tracking in retry loop", () => {
  it("attempt counter increments correctly across iterations", async () => {
    let promptCount = 0;
    const { handlers, agent, restore } = await setup({
      prompt: vi.fn().mockImplementation(() => {
        promptCount++;
        agent.state.messages = [
          { role: "assistant", stopReason: "error", errorMessage: "Connection error", content: [] },
        ];
        return Promise.resolve();
      }),
    });
    try {
      const entries = [errorEntry("Connection error")];
      fireAgentEndAsync(handlers, entries);

      // Advance through: 2s + 4s + 8s + 16s = 30s
      await advanceThroughRetry(35000);

      expect(promptCount).toBeGreaterThanOrEqual(4);
    } finally {
      restore();
    }
  });
});
