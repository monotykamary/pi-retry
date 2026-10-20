import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordRetrySessionAgent,
  registerRetrySession,
  unregisterRetrySession,
} from "../../src/session-registry.js";

// Keep this regression seam deterministic while exercising retry.ts's real driver.
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

let activeAgent: {
  prompt(input: unknown[]): Promise<unknown>;
  waitForIdle(): Promise<void>;
  state: { messages: any[] };
} | undefined;
// The fake owner lets the registry bind the test Agent to retry.ts.
let activeOwner: object | undefined;

/**
 * Build one session entry containing the assistant stop condition under test.
 *
 * @param stopReason Assistant stop reason represented by the entry.
 * @returns A session-manager-compatible message entry.
 */
function errorEntry(stopReason = "error") {
  return {
    type: "message",
    message: {
      role: "assistant",
      stopReason,
      errorMessage: stopReason === "error" ? "connection error" : undefined,
      content: stopReason === "length" ? [{ type: "text", text: "partial" }] : [],
    },
  };
}

/**
 * Create the smallest ExtensionAPI surface used by the ordinary retry driver.
 *
 * @returns Fake API, event handlers, and registered commands.
 */
function createApi() {
  const handlers: Record<string, Function[]> = {};
  const commands: Record<string, { handler: (args: string[], ctx: any) => Promise<void> }> = {};
  const api = {
    events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
    on(event: string, handler: Function) {
      (handlers[event] ??= []).push(handler);
    },
    registerCommand(name: string, options: { handler: (args: string[], ctx: any) => Promise<void> }) {
      commands[name] = options;
    },
    sendMessage: vi.fn((message: unknown) => {
      void activeAgent?.prompt([message]).catch(() => undefined);
    }),
  } as any;
  return { api, handlers, commands };
}

/**
 * Load retry.ts against a fresh fake extension runtime.
 *
 * @returns Test fixtures and a cleanup callback.
 */
async function setup() {
  vi.resetModules();
  const { AgentSession } = await import("@earendil-works/pi-coding-agent");
  const originalPrepareRetry = (AgentSession.prototype as any)._prepareRetry;
  const { default: retryExtension } = await import("../../retry.ts");
  const { api, handlers, commands } = createApi();
  retryExtension(api);
  const manager = { getEntries: vi.fn() };
  const owner = api as object;
  activeOwner = owner;
  const ui = { notify: vi.fn(), setStatus: vi.fn() };
  const ctx: any = { sessionManager: manager, ui };
  const restore = () => {
    unregisterRetrySession(manager, owner);
    (AgentSession.prototype as any)._prepareRetry = originalPrepareRetry;
    activeAgent = undefined;
    activeOwner = undefined;
  };
  return { api, commands, ctx, handlers, manager, restore, ui };
}

/**
 * Bind a fake Agent to the current session registry owner.
 *
 * @param manager Session-manager identity used by retry.ts.
 * @param responses Callback that updates the Agent after each hidden turn.
 * @returns The bound fake Agent.
 */
function attachAgent(manager: { getEntries: ReturnType<typeof vi.fn> }, responses: (agent: any) => void) {
  const agent = {
    prompt: vi.fn(() => {
      responses(agent);
      return Promise.resolve();
    }),
    waitForIdle: vi.fn().mockResolvedValue(undefined),
    state: {
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "connection error", content: [] }],
    },
  };
  activeAgent = agent;
  recordRetrySessionAgent(manager, agent as any);
  registerRetrySession(manager, activeOwner!, {
    isChild: false,
    suppressNativeRetry: true,
    childRetryEnabled: false,
  });
  return agent;
}

/**
 * Advance fake timers in short steps so interval-based cancellation is flushed.
 *
 * @param ms Amount of virtual time to advance.
 */
async function advance(ms: number) {
  for (let remaining = ms; remaining > 0; remaining -= 100) {
    await vi.advanceTimersByTimeAsync(Math.min(100, remaining));
  }
}

describe("reported retry regressions", () => {
  // A continuation is not an ordinary retry and must not consume its exponential slot.
  it("keeps ordinary retry backoff independent from a max-token continuation", async () => {
    const { api, handlers, manager, ctx, restore } = await setup();
    try {
      let calls = 0;
      const sent: Array<{ kind: string; at: number }> = [];
      const agent = attachAgent(manager, currentAgent => {
        calls++;
        if (calls === 1) {
          currentAgent.state.messages = [{ role: "assistant", stopReason: "length", content: [{ type: "text", text: "partial" }] }];
        } else if (calls === 2) {
          currentAgent.state.messages = [{ role: "assistant", stopReason: "error", errorMessage: "connection error", content: [] }];
        } else {
          currentAgent.state.messages = [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }];
        }
      });
      api.sendMessage.mockImplementation((message: any) => {
        sent.push({ kind: message.customType, at: Date.now() });
        void agent.prompt();
      });
      (ctx.sessionManager.getEntries as any).mockReturnValue([errorEntry()]);
      for (const handler of handlers["agent_end"] ?? []) {
        void handler({ messages: [] }, ctx);
      }
      await advance(20_000);

      // The two ordinary retries should be separated by 4s, not by an 8s slot consumed by continuation.
      const retryTimes = sent.filter(message => message.kind === "pi-retry:retry").map(message => message.at);
      expect(retryTimes.map(time => time - retryTimes[0]!)).toEqual([0, 8_000]);
    } finally {
      restore();
    }
  });

  // TEST:__tests__/unit/user-retry-regression.test.ts[ordinary retry countdown status]
  it("updates and clears one footer status row during ordinary backoff", async () => {
    const { handlers, manager, ctx, restore, ui } = await setup();
    try {
      const agent = attachAgent(manager, currentAgent => {
        currentAgent.state.messages = [
          { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
        ];
      });
      (ctx.sessionManager.getEntries as any).mockReturnValue([errorEntry()]);
      for (const handler of handlers["agent_end"] ?? []) {
        void handler({ messages: [] }, ctx);
      }

      await advance(100);
      expect(ui.setStatus).toHaveBeenCalledWith(
        "pi-retry-backoff",
        "Retry attempt 1 - retrying in 2.0s",
      );
      await advance(1_900);
      expect(ui.setStatus).toHaveBeenLastCalledWith("pi-retry-backoff", undefined);
      expect(ui.notify).not.toHaveBeenCalledWith(
        expect.stringContaining("Retry attempt 1"),
        "info",
      );
      expect(agent.prompt).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  // The ordinary driver already owns a completed loop before manual retry starts.
  // TEST:__tests__/unit/user-retry-regression.test.ts[manual retry after ordinary cap]
  it("allows manual retry after the ordinary retry cap", async () => {
    const { commands, handlers, manager, ctx, restore } = await setup();
    try {
      const agent = attachAgent(manager, currentAgent => {
        currentAgent.state.messages = [
          { role: "assistant", stopReason: "error", errorMessage: "connection error", content: [] },
        ];
      });
      (ctx.sessionManager.getEntries as any).mockReturnValue([errorEntry()]);
      for (const handler of handlers["agent_end"] ?? []) {
        void handler({ messages: [] }, ctx);
      }
      await advance(250_000);
      const attemptsBeforeManual = agent.prompt.mock.calls.length;

      // pi passes command args as a string, not an array.
      await commands["retry"]!.handler("", ctx);
      await advance(3_000);

      expect(agent.prompt.mock.calls.length).toBe(attemptsBeforeManual + 1);
    } finally {
      restore();
    }
  });
});

describe("prompt-scoped session classification", () => {
  // A session first classified from its startup prompt can be reclassified by
  // the run's effective prompt; it must not keep the other policy's controller.
  // TEST:__tests__/unit/user-retry-regression.test.ts[prompt-scoped reclassification]
  it("replaces the main-policy controller when a later prompt matches a child rule", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-retry-classify-"));
    const { api, handlers, manager, ctx, restore } = await setup();
    try {
      mkdirSync(join(root, ".pi"), { recursive: true });
      writeFileSync(join(root, ".pi", "settings.json"), JSON.stringify({
        piRetry: {
          baseDelayMs: 50_000,
          maxDelayMs: 50_000,
          subagents: {
            baseDelayMs: 1_000,
            maxDelayMs: 1_000,
            match: { systemPromptRegex: [{ pattern: "^<worker/>$", flags: "m" }] },
          },
        },
      }));
      const agent = { state: { messages: [] as any[] } };
      recordRetrySessionAgent(manager, agent as any);
      Object.assign(ctx, { cwd: root, mode: "print", getSystemPrompt: () => "plain prompt" });

      for (const handler of handlers["session_start"] ?? []) await handler({}, ctx);
      for (const handler of handlers["before_agent_start"] ?? []) {
        await handler({ systemPrompt: "<worker/>" }, ctx);
      }

      (ctx.sessionManager.getEntries as any).mockReturnValue([errorEntry()]);
      for (const handler of handlers["agent_end"] ?? []) {
        void handler({ messages: [] }, ctx);
      }
      await advance(1_000);

      // The child policy's 1s delay applies, not the main policy's 50s delay.
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
      expect(api.sendMessage.mock.calls[0]![0]).toMatchObject({ customType: "pi-retry:retry" });
    } finally {
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
