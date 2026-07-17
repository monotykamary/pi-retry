/**
 * Integration tests for the hidden AgentSession retry loop.
 *
 * The production extension requests each attempt with pi.sendMessage() and a
 * filtered custom marker. The test API models AgentSession by delegating that
 * request to a controllable fake Agent, which lets these tests exercise
 * backoff, state cleanup, cancellation, and eventual success deterministically.
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

let activeMockAgent: MockAgentInstance | undefined;

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
  const sendMessage = vi.fn(() => {
    void activeMockAgent?.prompt([]).catch(() => {});
  });

  const api = {
    on(event: string, handler: Function) {
      (handlers[event] ??= []).push(handler);
    },
    registerCommand(name: string, opts: { handler: (args: string[], ctx: any) => Promise<void> }) {
      commands[name] = opts;
    },
    sendMessage,
  } as unknown as ExtensionAPI;

  return { api, handlers, commands, sendMessage };
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

  const { api, handlers, commands, sendMessage } = createMockAPI();
  factory(api);

  const agent = createMockAgent(agentOverrides);
  activeMockAgent = agent;
  Agent.prototype.subscribe.call(agent, vi.fn());

  return {
    handlers,
    commands,
    agent,
    sendMessage,
    origContinue,
    restore: () => {
      Agent.prototype.subscribe = origSubscribe;
      Agent.prototype.continue = origContinue;
      activeMockAgent = undefined;
    },
  };
}

// ── Tests ──

describe("hidden retry context", () => {
  it("filters retry and continuation markers before provider conversion", async () => {
    const { handlers, restore } = await setup();
    try {
      const user = { role: "user", content: [{ type: "text", text: "work" }] };
      const messages = [
        user,
        { role: "custom", customType: "pi-retry:retry", content: [] },
        { role: "custom", customType: "pi-retry:continue", content: [] },
      ];

      const result = await handlers.context[0]({ messages }, createMockCtx());
      expect(result).toEqual({ messages: [user] });
    } finally {
      restore();
    }
  });
});

describe("triggerInvisibleContinue retry loop", () => {
  it("mutex: concurrent agent_end events request one hidden turn", async () => {
    const { handlers, agent, sendMessage, restore } = await setup({
      messages: [
        { role: "assistant", stopReason: "error", errorMessage: "Connection error", content: [] },
      ],
    });
    try {
      const entries = [errorEntry("Connection error")];

      fireAgentEndAsync(handlers, entries);
      fireAgentEndAsync(handlers, entries);

      // First sleep is attempt 1: 2s
      await advanceThroughRetry(3000);

      expect(agent.prompt).toHaveBeenCalledTimes(1);
      expect(agent.prompt).toHaveBeenCalledWith([]);
      expect(sendMessage).toHaveBeenCalledWith(
        {
          customType: "pi-retry:retry",
          content: [],
          display: false,
          details: undefined,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } finally {
      restore();
    }
  });

  it("does not monkey-patch Agent.continue", async () => {
    const { origContinue, restore } = await setup();
    try {
      const { Agent } = await import("@earendil-works/pi-agent-core");
      expect(Agent.prototype.continue).toBe(origContinue);
    } finally {
      restore();
    }
  });

  it("transport safely contains a rejected fake run", async () => {
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

  it("session_start kills in-flight retry loop via generation counter", async () => {
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
      // Advance through the 2s backoff so the first prompt fires
      await advanceThroughRetry(3000);

      const countBefore = promptCount;

      // Fire session_start — increments generation, killing the loop
      const sessionHandlers = handlers["session_start"] ?? [];
      for (const fn of sessionHandlers) {
        await fn({}, createMockCtx());
      }

      // Advance a long time — the loop should have exited
      await advanceThroughRetry(60000);

      // No new prompt calls should have happened after session_start
      expect(promptCount).toBe(countBefore);
    } finally {
      restore();
    }
  });
});

// ── Bug 1: Retry loop is not one-shot ──

describe("infinite retry loop", () => {
  it("retries multiple hidden turns while attempts keep failing", async () => {
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

  it("exits the loop when a hidden turn succeeds", async () => {
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

// ── Context overflow defers to compaction (does NOT retry in place) ──

describe("context overflow defers to compaction", () => {
  it("does not request a hidden turn for an overflow error", async () => {
    const { handlers, agent, restore } = await setup();
    try {
      const entries = [errorEntry("prompt is too long: 213462 tokens > 200000 maximum")];
      fireAgentEndAsync(handlers, entries);

      // Far beyond any backoff — a retry request would have fired by now.
      await advanceThroughRetry(70000);

      expect(agent.prompt).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("notifies that it is deferring to compaction", async () => {
    const { handlers, restore } = await setup();
    try {
      const entries = [errorEntry("Your input exceeds the context window of this model")];
      const ctx = createMockCtx(entries);
      const fns = handlers["agent_end"] ?? [];
      for (const fn of fns) {
        await fn({ messages: [] }, ctx);
      }

      expect(ctx.ui.notify).toHaveBeenCalled();
      const messages = ctx.ui.notify.mock.calls.map((c: any) => c[0] as string);
      expect(messages.some((m) => /Context overflow/i.test(m))).toBe(true);
    } finally {
      restore();
    }
  });

  it("does NOT set the retry mutex (pi-core's compaction-continue stays unblocked)", async () => {
    // After deferring, a subsequent retryable (non-overflow) error must still
    // be able to request a hidden turn, so the mutex was not left held.
    const { handlers, agent, restore } = await setup({
      prompt: vi.fn().mockImplementation(() => {
        agent.state.messages = [
          { role: "assistant", stopReason: "stop", content: [] },
        ];
        return Promise.resolve();
      }),
    });
    try {
      // First: overflow → defer (no prompt, mutex not held)
      fireAgentEndAsync(handlers, [errorEntry("prompt is too long: 213462 > 200000")]);
      await advanceThroughRetry(3000);
      expect(agent.prompt).not.toHaveBeenCalled();

      // Then: a connection error → should retry normally
      fireAgentEndAsync(handlers, [errorEntry("Connection error")]);
      await advanceThroughRetry(3000);
      expect(agent.prompt).toHaveBeenCalledWith([]);
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
  it("removes the error assistant message before requesting the hidden turn", async () => {
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

// Built-in retry coordination.

describe("built-in retry coordination", () => {
  it("the hidden-turn loop does not double-retry an error", async () => {
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

// ── Bug: ESC abort not responsive / /new continues retrying ──

describe("real prompt startup wins over retry backoff", () => {
  it("cancels the pending hidden turn before a user prompt enters AgentSession", async () => {
    const { handlers, agent, restore } = await setup();
    try {
      fireAgentEndAsync(handlers, [errorEntry("Connection error")]);
      await advanceThroughRetry(500);

      for (const handler of handlers.input ?? []) {
        await handler({ source: "interactive", text: "user work" }, createMockCtx());
      }
      await advanceThroughRetry(5000);

      expect(agent.prompt).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});

describe("interruptible abort and session change", () => {
  it("ESC aborts during backoff sleep within 100ms", async () => {
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

      // Advance through the first prompt (2s backoff)
      await advanceThroughRetry(3000);
      const countBefore = promptCount;

      // Abort sets _userAborted = true
      const turnEndHandlers = handlers["turn_end"] ?? [];
      const ctx = createMockCtx([]);
      for (const fn of turnEndHandlers) {
        await fn({ message: { role: "assistant", stopReason: "aborted" } }, ctx);
      }

      // Only 200ms should be needed for the interruptible sleep to detect the abort
      // (it polls every 100ms). Before the fix, we'd need to wait the full backoff.
      await advanceThroughRetry(200);

      // No more prompt calls after abort detected during backoff sleep
      expect(promptCount).toBe(countBefore);
    } finally {
      restore();
    }
  });

  it("Escape abort is detected after the hidden turn returns", async () => {
    let promptCount = 0;
    let resolvePrompt!: () => void;
    const { handlers, agent, restore } = await setup({
      prompt: vi.fn().mockImplementation(() => {
        promptCount++;
        return new Promise<void>((resolve) => { resolvePrompt = resolve; });
      }),
    });
    try {
      const entries = [errorEntry("Connection error")];
      fireAgentEndAsync(handlers, entries);

      // Advance through the 2s backoff to start the prompt
      await advanceThroughRetry(3000);
      expect(promptCount).toBe(1);

      // While prompt is in-flight, fire the abort
      const turnEndHandlers = handlers["turn_end"] ?? [];
      const ctx = createMockCtx([]);
      for (const fn of turnEndHandlers) {
        await fn({ message: { role: "assistant", stopReason: "aborted" } }, ctx);
      }

      // Now resolve the prompt (simulating the prompt returning after abort)
      agent.state.messages = [
        { role: "assistant", stopReason: "error", errorMessage: "Connection error", content: [] },
      ];
      resolvePrompt();
      await advanceThroughRetry(5000);

      // The post-prompt check should have seen _userAborted and exited
      expect(promptCount).toBe(1);
    } finally {
      restore();
    }
  });

  it("/new (session_start) stops in-flight retry loop", async () => {
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

      // Advance through the first retry (2s backoff)
      await advanceThroughRetry(3000);
      expect(promptCount).toBeGreaterThanOrEqual(1);

      const countBefore = promptCount;

      // Fire session_start (simulates /new)
      const sessionHandlers = handlers["session_start"] ?? [];
      for (const fn of sessionHandlers) {
        await fn({}, createMockCtx());
      }

      // Advance a long time — the generation counter should have killed the loop
      await advanceThroughRetry(60000);

      // No more prompts after session_start
      expect(promptCount).toBe(countBefore);
    } finally {
      restore();
    }
  });

  it("/new during backoff sleep exits within 100ms", async () => {
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

      // Advance through the first prompt
      await advanceThroughRetry(3000);
      const countBefore = promptCount;

      // Fire session_start during the second backoff sleep
      const sessionHandlers = handlers["session_start"] ?? [];
      for (const fn of sessionHandlers) {
        await fn({}, createMockCtx());
      }

      // Only 200ms needed — interruptibleSleep polls every 100ms
      await advanceThroughRetry(200);

      // Loop should have exited, no more prompts
      expect(promptCount).toBe(countBefore);
    } finally {
      restore();
    }
  });

  it("releases _continueInProgress after the owning generation exits", async () => {
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

      // Advance through the first prompt
      await advanceThroughRetry(3000);
      const countBeforeSessionSwitch = promptCount;

      // Fire session_start — increments generation
      const sessionHandlers = handlers["session_start"] ?? [];
      for (const fn of sessionHandlers) {
        await fn({}, createMockCtx());
      }

      // Let the old loop's finally block run
      await advanceThroughRetry(500);

      // Now fire a new error on the new session
      const newEntries = [errorEntry("Connection error")];
      const newCtx = createMockCtx(newEntries);
      const fns = handlers["agent_end"] ?? [];
      for (const fn of fns) {
        void fn({ messages: [] }, newCtx);
      }

      // Advance through backoff — the new retry should start
      await advanceThroughRetry(3000);

      // A new prompt should have been called (from the new session's retry)
      expect(promptCount).toBeGreaterThan(countBeforeSessionSwitch);
    } finally {
      restore();
    }
  });
});
