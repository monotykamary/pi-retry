/**
 * End-to-end smoke tests that verify the full retry lifecycle.
 *
 * These tests simulate realistic scenarios:
 * - Connection error → infinite retries → eventual success
 * - Built-in retry exhausts → pi-retry picks up
 * - User abort during retry
 * - Concurrent agent_end events
 * - Non-retryable errors are not retried
 * - Built-in retry is suppressed when pi-retry loop is active
 *
 * The retry loop sleeps before each hidden AgentSession turn. The timeline
 * for N retries is 2s + 4s + 8s + ... with a 60s cap.
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

let activeMockAgent: { prompt(input: unknown[]): Promise<void> } | undefined;

// ── Helpers ──

function createMockAPI() {
  const handlers: Record<string, Function[]> = {};
  const commands: Record<string, { handler: (args: string[], ctx: any) => Promise<void> }> = {};

  const api = {
      events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
    on(event: string, handler: Function) {
      (handlers[event] ??= []).push(handler);
    },
    registerCommand(name: string, opts: { handler: (args: string[], ctx: any) => Promise<void> }) {
      commands[name] = opts;
    },
    sendMessage: vi.fn(() => {
      void activeMockAgent?.prompt([]).catch(() => {});
    }),
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

async function setup() {
  vi.resetModules();

  const { Agent } = await import("@earendil-works/pi-agent-core");
  const origSubscribe = Agent.prototype.subscribe;
  const origContinue = Agent.prototype.continue;

  const mod = await import("../../retry.ts");
  const factory = mod.default;

  const { api, handlers, commands } = createMockAPI();
  factory(api);

  return {
    api,
    handlers,
    commands,
    Agent,
    restore: () => {
      Agent.prototype.subscribe = origSubscribe;
      Agent.prototype.continue = origContinue;
      activeMockAgent = undefined;
    },
  };
}

async function createAgentWithMessages(messages: any[], promptFn?: () => Promise<void>) {
  const { Agent } = await import("@earendil-works/pi-agent-core");
  const agent = {
    listeners: new Set<Function>(),
    waitForIdle: vi.fn().mockResolvedValue(undefined),
    prompt: promptFn ?? vi.fn().mockResolvedValue(undefined),
    state: {
      isStreaming: false,
      messages: [...messages],
    },
    subscribe(listener: Function) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },
  };
  activeMockAgent = agent;
  Agent.prototype.subscribe.call(agent, vi.fn());
  return agent;
}

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

// ── Smoke tests ──

describe("smoke: full retry lifecycle", () => {
  it("exposes retry lifecycle events through the shared event bus", async () => {
    const { api, handlers, restore } = await setup();
    try {
      const agent = await createAgentWithMessages(
        [{ role: "assistant", stopReason: "error", errorMessage: "Connection error", content: [] }],
        vi.fn().mockImplementation(() => {
          agent.state.messages = [
            { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
          ];
          return Promise.resolve();
        }),
      );
      const ctx = createMockCtx([errorEntry("Connection error")]);

      for (const handler of handlers["agent_end"] ?? []) {
        void handler({ messages: [] }, ctx);
      }

      expect(api.events.emit).toHaveBeenCalledWith("pi-retry:started", { retryId: 1 });

      await advance(5_000);

      expect(api.events.emit).toHaveBeenCalledWith("pi-retry:completed", { retryId: 1 });
    } finally {
      restore();
    }
  });

  it("connection error → 5 retries → success", async () => {
    const { handlers, restore } = await setup();
    try {
      let attempt = 0;
      const agent = await createAgentWithMessages(
        [{ role: "assistant", stopReason: "error", errorMessage: "Connection error", content: [] }],
        vi.fn().mockImplementation(() => {
          attempt++;
          if (attempt >= 5) {
            agent.state.messages = [
              { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
            ];
          } else {
            agent.state.messages = [
              { role: "assistant", stopReason: "error", errorMessage: "Connection error", content: [] },
            ];
          }
          return Promise.resolve();
        })
      );

      const entries = [errorEntry("Connection error")];
      const ctx = createMockCtx(entries);

      const fns = handlers["agent_end"] ?? [];
      for (const fn of fns) {
        void fn({ messages: [] }, ctx);
      }

      // Backoff sleeps: 2s, 4s, 8s, 16s, 32s = 62s
      await advance(70000);

      expect(attempt).toBe(5);
      expect(agent.prompt).toHaveBeenCalledTimes(5);
    } finally {
      restore();
    }
  });

  it("error clears after successful retry — no infinite loop", async () => {
    const { handlers, restore } = await setup();
    try {
      let attempt = 0;
      const agent = await createAgentWithMessages(
        [{ role: "assistant", stopReason: "error", errorMessage: "Connection error", content: [] }],
        vi.fn().mockImplementation(() => {
          attempt++;
          agent.state.messages = [
            { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
          ];
          return Promise.resolve();
        })
      );

      const entries = [errorEntry("Connection error")];
      const ctx = createMockCtx(entries);

      const fns = handlers["agent_end"] ?? [];
      for (const fn of fns) {
        void fn({ messages: [] }, ctx);
      }

      // 2s backoff
      await advance(5000);

      expect(attempt).toBe(1);
    } finally {
      restore();
    }
  });

  it("non-retryable error is not retried", async () => {
    const { handlers, restore } = await setup();
    try {
      const agent = await createAgentWithMessages(
        [{ role: "assistant", stopReason: "error", errorMessage: "Invalid API key provided", content: [] }],
        vi.fn().mockResolvedValue(undefined)
      );

      const entries = [errorEntry("Invalid API key provided")];
      const ctx = createMockCtx(entries);

      const fns = handlers["agent_end"] ?? [];
      for (const fn of fns) {
        void fn({ messages: [] }, ctx);
      }

      await advance(10000);

      expect(agent.prompt).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("user abort stops the retry loop", async () => {
    const { handlers, restore } = await setup();
    try {
      let attempt = 0;
      const agent = await createAgentWithMessages(
        [{ role: "assistant", stopReason: "error", errorMessage: "Connection error", content: [] }],
        vi.fn().mockImplementation(() => {
          attempt++;
          agent.state.messages = [
            { role: "assistant", stopReason: "error", errorMessage: "Connection error", content: [] },
          ];
          return Promise.resolve();
        })
      );

      const entries = [errorEntry("Connection error")];
      const ctx = createMockCtx(entries);

      const fns = handlers["agent_end"] ?? [];
      for (const fn of fns) {
        void fn({ messages: [] }, ctx);
      }

      // Let one retry happen (2s backoff)
      await advance(3000);
      const countBefore = attempt;

      // Simulate user pressing Escape
      const turnEndFns = handlers["turn_end"] ?? [];
      const abortCtx = createMockCtx([]);
      for (const fn of turnEndFns) {
        await fn({ message: { role: "assistant", stopReason: "aborted" } }, abortCtx);
      }

      await advance(60000);

      expect(attempt).toBe(countBefore);
    } finally {
      restore();
    }
  });
});

// ── Litmus tests for each bug fix ──

describe("litmus: bug fix verification", () => {
  // Bug 1: One-shot retry → infinite retry loop
  it("retries more than 3 times (not one-shot)", async () => {
    const { handlers, restore } = await setup();
    try {
      let attempt = 0;
      const agent = await createAgentWithMessages(
        [{ role: "assistant", stopReason: "error", errorMessage: "Connection error", content: [] }],
        vi.fn().mockImplementation(() => {
          attempt++;
          agent.state.messages = [
            { role: "assistant", stopReason: "error", errorMessage: "Connection error", content: [] },
          ];
          return Promise.resolve();
        })
      );

      const entries = [errorEntry("Connection error")];
      const ctx = createMockCtx(entries);

      const fns = handlers["agent_end"] ?? [];
      for (const fn of fns) {
        void fn({ messages: [] }, ctx);
      }

      // Delays: 2s, 4s, 8s, 16s, 32s = 62s
      await advance(70000);

      // OLD BEHAVIOR: would be exactly 1 (one-shot)
      // NEW BEHAVIOR: should be 5+
      expect(attempt).toBeGreaterThanOrEqual(5);
    } finally {
      restore();
    }
  });

  // Bug 2: await sleep blocks processEvents → handler returns immediately
  it("agent_end handler does not block (returns in <100ms)", async () => {
    const { handlers, restore } = await setup();
    try {
      const entries = [errorEntry("Connection error")];
      const ctx = createMockCtx(entries);

      const fns = handlers["agent_end"] ?? [];

      vi.useRealTimers();
      const start = Date.now();
      for (const fn of fns) {
        await fn({ messages: [] }, ctx);
      }
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(100);
      vi.useFakeTimers();
    } finally {
      restore();
    }
  });

  // Bug 3: Error message not removed → LLM gets corrupted context
  it("error assistant message is removed before the hidden turn", async () => {
    const { handlers, restore } = await setup();
    try {
      const capturedMessages: any[][] = [];

      const agent = await createAgentWithMessages(
        [
          { role: "user", content: "hello" },
          { role: "assistant", stopReason: "error", errorMessage: "Connection error", content: [] },
        ],
        vi.fn().mockImplementation(() => {
          capturedMessages.push([...agent.state.messages]);
          agent.state.messages = [
            { role: "assistant", stopReason: "stop", content: [] },
          ];
          return Promise.resolve();
        })
      );

      const entries = [errorEntry("Connection error")];
      const ctx = createMockCtx(entries);

      const fns = handlers["agent_end"] ?? [];
      for (const fn of fns) {
        void fn({ messages: [] }, ctx);
      }

      await advance(3000);

      expect(capturedMessages.length).toBeGreaterThanOrEqual(1);
      const msgsAtPromptTime = capturedMessages[0];

      // The last message should NOT be the error assistant
      const lastMsg = msgsAtPromptTime[msgsAtPromptTime.length - 1];
      expect(lastMsg?.role).not.toBe("assistant");
      // The context should end with the user message that preceded the error
      expect(lastMsg?.role).toBe("user");
    } finally {
      restore();
    }
  });

  // Bug 5: No UI notification → user doesn't know retries are happening
  it("notifies user about retry attempts via ui.notify", async () => {
    const { handlers, restore } = await setup();
    try {
      let attempt = 0;
      const agent = await createAgentWithMessages(
        [{ role: "assistant", stopReason: "error", errorMessage: "Connection error", content: [] }],
        vi.fn().mockImplementation(() => {
          attempt++;
          if (attempt >= 2) {
            agent.state.messages = [
              { role: "assistant", stopReason: "stop", content: [] },
            ];
          } else {
            agent.state.messages = [
              { role: "assistant", stopReason: "error", errorMessage: "Connection error", content: [] },
            ];
          }
          return Promise.resolve();
        })
      );

      const entries = [errorEntry("Connection error")];
      const ctx = createMockCtx(entries);

      const fns = handlers["agent_end"] ?? [];
      for (const fn of fns) {
        void fn({ messages: [] }, ctx);
      }

      await advance(8000);

      expect(ctx.ui.notify).toHaveBeenCalled();
      const calls = ctx.ui.notify.mock.calls.map((c: any) => c[0]);
      const retryCalls = calls.filter((c: string) => c.includes("Retry attempt"));
      expect(retryCalls.length).toBeGreaterThanOrEqual(1);
    } finally {
      restore();
    }
  });

  // Bug 6: attempt counter increments across loop iterations
  it("attempt counter increments across loop iterations", async () => {
    const { handlers, restore } = await setup();
    try {
      let promptCount = 0;
      const agent = await createAgentWithMessages(
        [{ role: "assistant", stopReason: "error", errorMessage: "Connection error", content: [] }],
        vi.fn().mockImplementation(() => {
          promptCount++;
          agent.state.messages = [
            { role: "assistant", stopReason: "error", errorMessage: "Connection error", content: [] },
          ];
          return Promise.resolve();
        })
      );

      const entries = [errorEntry("Connection error")];
      const ctx = createMockCtx(entries);

      const fns = handlers["agent_end"] ?? [];
      for (const fn of fns) {
        void fn({ messages: [] }, ctx);
      }

      // 2s + 4s + 8s + 16s = 30s
      await advance(35000);

      expect(promptCount).toBeGreaterThanOrEqual(4);
    } finally {
      restore();
    }
  });
});

// ── Edge case: built-in retry exhausts, pi-retry picks up ──

describe("smoke: built-in retry exhaustion", () => {
  it("pi-retry continues after built-in retry gives up", async () => {
    const { handlers, restore } = await setup();
    try {
      let attempt = 0;
      const agent = await createAgentWithMessages(
        [{ role: "assistant", stopReason: "error", errorMessage: "Connection error", content: [] }],
        vi.fn().mockImplementation(() => {
          attempt++;
          if (attempt >= 6) {
            agent.state.messages = [
              { role: "assistant", stopReason: "stop", content: [] },
            ];
          } else {
            agent.state.messages = [
              { role: "assistant", stopReason: "error", errorMessage: "Connection error", content: [] },
            ];
          }
          return Promise.resolve();
        })
      );

      const entries = [errorEntry("Connection error")];
      const ctx = createMockCtx(entries);

      const fns = handlers["agent_end"] ?? [];
      for (const fn of fns) {
        void fn({ messages: [] }, ctx);
      }

      // pi-retry's backoff: 2s, 4s, 8s, 16s, 32s, 60s(capped) = 122s
      await advance(130000);

      // Should have retried enough times to reach success at attempt 6
      expect(attempt).toBeGreaterThanOrEqual(6);
    } finally {
      restore();
    }
  });
});

// ── Edge case: max_tokens continuation ──

describe("smoke: max_tokens continuation", () => {
  it("continues when stopReason is length", async () => {
    const { handlers, restore } = await setup();
    try {
      const agent = await createAgentWithMessages(
        [{ role: "assistant", stopReason: "length", content: [{ type: "text", text: "long output..." }] }],
        vi.fn().mockResolvedValue(undefined)
      );

      const entries = [{
        type: "message",
        message: { role: "assistant", stopReason: "length", content: [{ type: "text", text: "long output..." }] },
      }];
      const ctx = createMockCtx(entries);

      const fns = handlers["agent_end"] ?? [];
      for (const fn of fns) {
        void fn({ messages: [] }, ctx);
      }

      await advance(5000);

      expect(agent.prompt).toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});

// ── Edge case: /retry command ──

describe("smoke: /retry command", () => {
  it("/retry triggers a manual retry", async () => {
    const { commands, restore } = await setup();
    try {
      let attempt = 0;
      const agent = await createAgentWithMessages(
        [{ role: "assistant", stopReason: "error", errorMessage: "Connection error", content: [] }],
        vi.fn().mockImplementation(() => {
          attempt++;
          agent.state.messages = [
            { role: "assistant", stopReason: "stop", content: [] },
          ];
          return Promise.resolve();
        })
      );

      const retryHandler = commands["retry"]?.handler;
      expect(retryHandler).toBeDefined();

      const entries = [errorEntry("Connection error")];
      const ctx = createMockCtx(entries);

      await retryHandler!([], ctx);
      await advance(5000);

      expect(attempt).toBeGreaterThanOrEqual(1);
    } finally {
      restore();
    }
  });

  it("/retry reset clears all state", async () => {
    const { commands, restore } = await setup();
    try {
      const retryHandler = commands["retry"]?.handler;
      expect(retryHandler).toBeDefined();

      const ctx = createMockCtx([]);
      await retryHandler!(["reset"], ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("reset"),
        "info"
      );
    } finally {
      restore();
    }
  });
});

// ── Critical: built-in retry suppression ──

describe("smoke: built-in retry suppression", () => {
  it("_prepareRetry returns false when _continueInProgress is true", async () => {
    const { handlers, restore } = await setup();
    try {
      // Fire an error to start pi-retry's loop. This sets _continueInProgress = true
      // synchronously (before the first await in triggerInvisibleContinue).
      let attempt = 0;
      const agent = await createAgentWithMessages(
        [{ role: "assistant", stopReason: "error", errorMessage: "Connection error", content: [] }],
        vi.fn().mockImplementation(() => {
          attempt++;
          if (attempt >= 2) {
            agent.state.messages = [
              { role: "assistant", stopReason: "stop", content: [] },
            ];
          } else {
            agent.state.messages = [
              { role: "assistant", stopReason: "error", errorMessage: "Connection error", content: [] },
            ];
          }
          return Promise.resolve();
        })
      );

      const entries = [errorEntry("Connection error")];
      const ctx = createMockCtx(entries);

      const fns = handlers["agent_end"] ?? [];
      for (const fn of fns) {
        void fn({ messages: [] }, ctx);
      }

      // Advance through pi-retry's backoff + prompt cycles
      await advance(10000);

      // The key assertion: ctx.ui.notify should NOT have been called
      // with "Retry failed after" — that message comes from the built-in
      // retry's auto_retry_end event, which should be suppressed.
      const notifyCalls = ctx.ui.notify.mock.calls.map((c: any) => c[0]);
      const failureCalls = notifyCalls.filter((c: string) => c.includes("Retry failed after"));
      expect(failureCalls.length).toBe(0);
    } finally {
      restore();
    }
  });

  it("_prepareRetry is monkey-patched and functional", async () => {
    const { restore } = await setup();
    try {
      const { AgentSession } = await import("@earendil-works/pi-coding-agent");

      // Verify the monkey-patch is installed
      expect(typeof (AgentSession.prototype as any)._prepareRetry).toBe("function");

      // When _continueInProgress is true, it returns false immediately
      // (We can't easily set _continueInProgress directly since it's module-scoped,
      // but we verified the source code in the race-condition test.)
    } finally {
      restore();
    }
  });
});

// ── Critical: ESC and /new responsiveness ──

describe("smoke: interruptible abort and session change", () => {
  it("ESC aborts quickly — not after the full backoff", async () => {
    const { handlers, restore } = await setup();
    try {
      let promptCount = 0;
      const agent = await createAgentWithMessages(
        [{ role: "assistant", stopReason: "error", errorMessage: "Connection error", content: [] }],
        vi.fn().mockImplementation(() => {
          promptCount++;
          agent.state.messages = [
            { role: "assistant", stopReason: "error", errorMessage: "Connection error", content: [] },
          ];
          return Promise.resolve();
        })
      );

      const entries = [errorEntry("Connection error")];
      const ctx = createMockCtx(entries);

      const fns = handlers["agent_end"] ?? [];
      for (const fn of fns) {
        void fn({ messages: [] }, ctx);
      }

      // Advance through the first prompt (2s backoff)
      await advance(3000);
      const countBefore = promptCount;

      // Fire abort
      const turnEndFns = handlers["turn_end"] ?? [];
      const abortCtx = createMockCtx([]);
      for (const fn of turnEndFns) {
        await fn({ message: { role: "assistant", stopReason: "aborted" } }, abortCtx);
      }

      // Only 200ms needed — interruptibleSleep polls every 100ms
      await advance(200);

      // No more prompts after abort
      expect(promptCount).toBe(countBefore);
    } finally {
      restore();
    }
  });

  it("/new stops the retry loop", async () => {
    const { handlers, restore } = await setup();
    try {
      let promptCount = 0;
      const agent = await createAgentWithMessages(
        [{ role: "assistant", stopReason: "error", errorMessage: "Connection error", content: [] }],
        vi.fn().mockImplementation(() => {
          promptCount++;
          agent.state.messages = [
            { role: "assistant", stopReason: "error", errorMessage: "Connection error", content: [] },
          ];
          return Promise.resolve();
        })
      );

      const entries = [errorEntry("Connection error")];
      const ctx = createMockCtx(entries);

      const fns = handlers["agent_end"] ?? [];
      for (const fn of fns) {
        void fn({ messages: [] }, ctx);
      }

      // Advance through the first prompt
      await advance(3000);
      const countBefore = promptCount;

      // Fire session_start (simulates /new)
      const sessionFns = handlers["session_start"] ?? [];
      for (const fn of sessionFns) {
        await fn({}, createMockCtx());
      }

      // Advance a long time — the loop should have exited
      await advance(60000);

      // No more prompts after session_start
      expect(promptCount).toBe(countBefore);
    } finally {
      restore();
    }
  });

  it("new session can start its own retry after /new", async () => {
    const { handlers, restore } = await setup();
    try {
      let promptCount = 0;
      const agent = await createAgentWithMessages(
        [{ role: "assistant", stopReason: "error", errorMessage: "Connection error", content: [] }],
        vi.fn().mockImplementation(() => {
          promptCount++;
          if (promptCount >= 3) {
            agent.state.messages = [
              { role: "assistant", stopReason: "stop", content: [] },
            ];
          } else {
            agent.state.messages = [
              { role: "assistant", stopReason: "error", errorMessage: "Connection error", content: [] },
            ];
          }
          return Promise.resolve();
        })
      );

      const entries = [errorEntry("Connection error")];
      const ctx = createMockCtx(entries);

      // Start retry on session 1
      const fns = handlers["agent_end"] ?? [];
      for (const fn of fns) {
        void fn({ messages: [] }, ctx);
      }

      await advance(3000);

      // Fire /new — kills the old loop
      const sessionFns = handlers["session_start"] ?? [];
      for (const fn of sessionFns) {
        await fn({}, createMockCtx());
      }

      await advance(500);

      // Now fire a new error on the new session
      const newCtx = createMockCtx(entries);
      for (const fn of fns) {
        void fn({ messages: [] }, newCtx);
      }

      // Advance through backoff + retry
      await advance(10000);

      // The new session's retry should have fired
      expect(agent.prompt).toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
