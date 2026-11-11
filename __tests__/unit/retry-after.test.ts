import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseRetryDuration } from "../../src/retry-logic.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * Build a journal entry for one assistant error.
 *
 * @param errorMessage Provider error text to classify.
 * @returns A session-manager-compatible assistant entry.
 */
function errorEntry(errorMessage = "connection error") {
  return {
    type: "message",
    message: { role: "assistant", stopReason: "error", errorMessage, content: [] },
  };
}

/**
 * Create an extension session with a real retry driver and a fake agent.
 *
 * @param options Error category and whether to use the inline controller.
 * @returns Test API, commands, event handlers, agent, UI, and cleanup.
 */
async function setup(options: { error?: string; inline?: boolean } = {}) {
  vi.resetModules();
  const { AgentSession } = await import("@earendil-works/pi-coding-agent");
  const originalPrepareRetry = (AgentSession.prototype as any)._prepareRetry;
  const registry = await import("../../src/session-registry.js");
  const { ChildRetryController } = await import("../../src/child-retry.js");
  const { DEFAULT_RETRY_CONFIG } = await import("../../src/config.js");
  const { default: retryExtension } = await import("../../retry.ts");
  const handlers: Record<string, Function[]> = {};
  const commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
  const terminalListeners = new Set<(data: string) => unknown>();
  const entry = errorEntry(options.error);
  const agent = {
    state: { messages: [entry.message] as any[] },
    waitForIdle: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockImplementation(async () => {
      agent.state.messages = [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }];
    }),
  };
  const api = {
    events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
    on(event: string, handler: Function) { (handlers[event] ??= []).push(handler); },
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
      commands[name] = command;
    },
    sendMessage: vi.fn((message: unknown) => { void agent.prompt(message); }),
  } as any;
  retryExtension(api);
  const manager = { getEntries: vi.fn(() => [entry]) };
  registry.recordRetrySessionAgent(manager, agent as any);
  const registered = registry.registerRetrySession(manager, api, {
    isChild: options.inline === true,
    suppressNativeRetry: true,
    childRetryEnabled: options.inline === true,
  });
  if (options.inline) {
    registered!.binding.sessionState = new ChildRetryController(api, agent as any, {
      ...DEFAULT_RETRY_CONFIG,
      enabled: true,
      match: { systemPromptRegex: [] },
    });
  }
  const ui = {
    notify: vi.fn(),
    setStatus: vi.fn(),
    onTerminalInput: vi.fn((listener: (data: string) => unknown) => {
      terminalListeners.add(listener);
      return () => terminalListeners.delete(listener);
    }),
  };
  const ctx: any = { sessionManager: manager, ui, mode: "tui" };
  const restore = () => {
    registry.unregisterRetrySession(manager, api);
    (AgentSession.prototype as any)._prepareRetry = originalPrepareRetry;
  };
  return { agent, api, commands, ctx, entry, handlers, manager, restore, terminalListeners, ui };
}

/**
 * Deliver an event to the test extension without blocking its retry loop.
 *
 * @param handlers Registered extension event handlers.
 * @param name Event name to deliver.
 * @param ctx Context for the session receiving the event.
 * @param event Event payload supplied to each handler.
 */
function emit(handlers: Record<string, Function[]>, name: string, ctx: any, event: unknown = {}) {
  for (const handler of handlers[name] ?? []) void handler(event, ctx);
}

describe("duration parsing", () => {
  // TEST:src/retry-logic.ts[parseRetryDuration]
  it.each([
    ["40m30s", 2_430_000],
    ["30s", 30_000],
    ["1h 15m", 4_500_000],
    ["1D2H3M4S", 93_784_000],
    [" 2m  ", 120_000],
  ])("parses %s", (input, expected) => {
    expect(parseRetryDuration(input)).toBe(expected);
  });

  // TEST:src/retry-logic.ts[parseRetryDuration]
  it.each(["", " ", "0s", "-1s", "5", "1m1m", "30s1m", "1.5h", "2hours", "1s garbage", "999999999999999999d"])(
    "rejects invalid or unsafe duration %s",
    input => expect(parseRetryDuration(input)).toBeUndefined(),
  );
});

describe("scheduled retry lifecycle", () => {
  // TEST:retry.ts[retry-after, tickScheduledRetry, triggerInvisibleContinue]
  it("replaces active automatic backoff and retries only after 40m30s", async () => {
    const { agent, commands, ctx, handlers, restore, ui } = await setup();
    try {
      emit(handlers, "agent_end", ctx);
      await vi.advanceTimersByTimeAsync(500);
      await commands["retry-after"]!.handler("40m30s", ctx);
      await vi.advanceTimersByTimeAsync(2_429_999);
      expect(agent.prompt).not.toHaveBeenCalled();
      expect(ui.setStatus).toHaveBeenCalledWith("pi-retry-scheduled", expect.stringContaining("Scheduled retry in"));
      await vi.advanceTimersByTimeAsync(5);
      expect(agent.prompt).toHaveBeenCalledTimes(1);
      expect(ui.setStatus.mock.calls.filter(([key]) => key === "pi-retry-scheduled").at(-1))
        .toEqual(["pi-retry-scheduled", undefined]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(agent.prompt).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  // TEST:retry.ts[retry-after, cancelScheduledRetry]
  it("keeps a valid schedule after invalid input, replaces it, and cancels it", async () => {
    const { agent, commands, ctx, restore, ui } = await setup();
    try {
      await commands["retry-after"]!.handler("2s", ctx);
      await commands["retry-after"]!.handler("wrong", ctx);
      expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("Invalid duration"), "warning");
      await commands["retry-after"]!.handler("4s", ctx);
      await vi.advanceTimersByTimeAsync(2_500);
      expect(agent.prompt).not.toHaveBeenCalled();
      await commands["retry-after"]!.handler("cancel", ctx);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(agent.prompt).not.toHaveBeenCalled();
      expect(ui.setStatus).toHaveBeenLastCalledWith("pi-retry-scheduled", undefined);
    } finally {
      restore();
    }
  });

  // TEST:retry.ts[handleRetryCommand, cancelScheduledRetry]
  it("keeps the timer for /retry status and cancels it for /retry reset", async () => {
    const { agent, commands, ctx, restore, ui } = await setup();
    try {
      await commands["retry-after"]!.handler("2s", ctx);
      await commands.retry!.handler("status", ctx);
      expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("Retry Status"), "info");
      await commands.retry!.handler("reset", ctx);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(agent.prompt).not.toHaveBeenCalled();
      expect(ui.notify).toHaveBeenCalledWith("All retry counters reset", "info");
    } finally {
      restore();
    }
  });

  // TEST:retry.ts[retry-after, handleRetryCommand]
  it("runs a normal manual retry instead when /retry cancels the timer", async () => {
    const { agent, commands, ctx, restore } = await setup();
    try {
      await commands["retry-after"]!.handler("20s", ctx);
      await commands.retry!.handler("", ctx);
      await vi.advanceTimersByTimeAsync(2_100);
      expect(agent.prompt).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(25_000);
      expect(agent.prompt).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  // TEST:retry.ts[retry-after, cancelScheduledRetry]
  it.each(["input", "session_shutdown", "escape", "success"])("cancels on %s", async reason => {
    const { agent, commands, ctx, handlers, restore, terminalListeners, ui } = await setup();
    try {
      await commands["retry-after"]!.handler("2s", ctx);
      if (reason === "escape") {
        for (const listener of [...terminalListeners]) listener("\x1b");
      } else if (reason === "success") {
        emit(handlers, "turn_end", ctx, { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } });
      } else {
        emit(handlers, reason, ctx);
      }
      await vi.advanceTimersByTimeAsync(3_000);
      expect(agent.prompt).not.toHaveBeenCalled();
      expect(ui.setStatus).toHaveBeenLastCalledWith("pi-retry-scheduled", undefined);
      expect(terminalListeners.size).toBe(0);
    } finally {
      restore();
    }
  });

  // TEST:retry.ts[fireScheduledRetry, triggerForContext]
  it("waits for an in-flight retry to settle without sending a duplicate", async () => {
    const { agent, commands, ctx, handlers, restore } = await setup();
    try {
      let release: (() => void) | undefined;
      let calls = 0;
      agent.prompt.mockImplementation(async () => {
        agent.state.messages = [errorEntry().message];
      });
      agent.waitForIdle.mockImplementation(() => {
        calls++;
        return calls === 2 ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve();
      });
      emit(handlers, "agent_end", ctx);
      await vi.advanceTimersByTimeAsync(2_100);
      expect(agent.prompt).toHaveBeenCalledTimes(1);
      await commands["retry-after"]!.handler("1s", ctx);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(agent.prompt).toHaveBeenCalledTimes(1);
      release?.();
      await vi.advanceTimersByTimeAsync(10);
      expect(agent.prompt).toHaveBeenCalledTimes(2);
    } finally {
      restore();
    }
  });
});

describe("quota retry", () => {
  // TEST:retry.ts[handleRetryCommand, triggerInvisibleContinue]
  it("tries once after a quota wait and stops if the quota is still exhausted", async () => {
    const { agent, commands, ctx, entry, restore } = await setup({ error: "You've hit your limit" });
    try {
      agent.prompt.mockImplementation(async () => { agent.state.messages = [entry.message]; });
      await commands["retry-after"]!.handler("1s", ctx);
      await vi.advanceTimersByTimeAsync(999);
      expect(agent.prompt).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10);
      expect(agent.prompt).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(180_000);
      expect(agent.prompt).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  // TEST:retry.ts[retry-after], src/error-patterns.ts[isPermanentError]
  it.each(["Invalid API key", "Invalid API key: you've hit your limit"])("does not schedule permanent errors: %s", async error => {
    const { agent, commands, ctx, restore, ui } = await setup({ error });
    try {
      await commands["retry-after"]!.handler("1s", ctx);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(agent.prompt).not.toHaveBeenCalled();
      expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("Fix permanent errors"), "warning");
    } finally {
      restore();
    }
  });
});

describe("additional prompt", () => {
  // TEST:retry.ts[retry-after, triggerInvisibleContinue], src/child-retry.ts[runSchedule]
  it.each([false, true])("sends extra instructions for inline=%s", async inline => {
    const { agent, api, commands, ctx, restore } = await setup({ inline });
    try {
      await commands["retry-after"]!.handler("1s  1h15m is the deadline.\n请检查更新后的配置。", ctx);
      await vi.advanceTimersByTimeAsync(999);
      expect(agent.prompt).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10);
      expect(api.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "Retry the previous request.\n\nAdditional user instructions:\n1h15m is the deadline.\n请检查更新后的配置。",
          display: false,
        }),
        expect.anything(),
      );
    } finally {
      restore();
    }
  });

  // TEST:retry.ts[retry-after, cancelScheduledRetry]
  it("replaces both the delay and the instructions when rescheduled", async () => {
    const { agent, api, commands, ctx, restore } = await setup();
    try {
      await commands["retry-after"]!.handler("1s Old instructions", ctx);
      await commands["retry-after"]!.handler("2s New instructions", ctx);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(agent.prompt).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(510);
      expect(api.sendMessage.mock.calls[0][0].content).toContain("New instructions");
      expect(api.sendMessage.mock.calls[0][0].content).not.toContain("Old instructions");
    } finally {
      restore();
    }
  });

  // TEST:retry.ts[triggerInvisibleContinue], src/retry-logic.ts[appendRetryInstructions]
  it("adds instructions only to the first hidden turn if the retry fails again", async () => {
    const { agent, api, commands, ctx, entry, restore } = await setup();
    try {
      agent.prompt.mockImplementationOnce(async () => { agent.state.messages = [entry.message]; });
      await commands["retry-after"]!.handler("1s Use the fallback endpoint", ctx);
      await vi.advanceTimersByTimeAsync(1_005);
      expect(api.sendMessage.mock.calls[0][0].content).toContain("Use the fallback endpoint");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(api.sendMessage).toHaveBeenCalledTimes(2);
      expect(api.sendMessage.mock.calls[1][0].content).toBe("Retry the previous request.");
    } finally {
      restore();
    }
  });

  // TEST:retry.ts[handleRetryCommand], src/child-retry.ts[handleAgentEnd]
  it.each([false, true])("includes instructions when continuing inline=%s", async inline => {
    const { api, commands, ctx, entry, restore } = await setup({ inline });
    try {
      entry.message.stopReason = "length";
      entry.message.errorMessage = "";
      await commands["retry-after"]!.handler("1s Start with a summary", ctx);
      await vi.advanceTimersByTimeAsync(1_005);
      expect(api.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("Additional user instructions:\nStart with a summary") }),
        expect.anything(),
      );
    } finally {
      restore();
    }
  });
});

describe("inline retry", () => {
  // TEST:src/child-retry.ts[handleAgentEnd, retryManually]
  it("replaces an inline automatic backoff and retries at the requested time", async () => {
    const { agent, commands, ctx, handlers, restore } = await setup({ inline: true });
    try {
      emit(handlers, "agent_end", ctx);
      await vi.advanceTimersByTimeAsync(500);
      await commands["retry-after"]!.handler("3s", ctx);
      await vi.advanceTimersByTimeAsync(2_999);
      expect(agent.prompt).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5);
      expect(agent.prompt).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(agent.prompt).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  // TEST:src/child-retry.ts[handleAgentEnd, retryManually]
  it("allows one explicit attempt after an inline quota error", async () => {
    const { agent, commands, ctx, restore } = await setup({ inline: true, error: "You've hit your limit" });
    try {
      await commands["retry-after"]!.handler("1s", ctx);
      await vi.advanceTimersByTimeAsync(1_005);
      expect(agent.prompt).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });
});
