import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function errorEntry(errorMessage: string): object {
  return {
    type: "message",
    message: {
      role: "assistant",
      stopReason: "error",
      errorMessage,
      content: [],
    },
  };
}

async function setup() {
  vi.resetModules();

  const { Agent } = await import("@earendil-works/pi-agent-core");
  const { AgentSession } = await import("@earendil-works/pi-coding-agent");
  const originalSubscribe = Agent.prototype.subscribe;
  const originalContinue = Agent.prototype.continue;
  const originalPrepareRetry = (AgentSession.prototype as any)._prepareRetry;

  const handlers: Record<string, Function[]> = {};
  let agent: any;
  const api = {
      events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
    on(event: string, handler: Function) {
      (handlers[event] ??= []).push(handler);
    },
    registerCommand() {},
    sendMessage() {
      void agent?.prompt([]).catch(() => {});
    },
  } as unknown as ExtensionAPI;

  const { default: retryExtension } = await import("../../retry.ts");
  retryExtension(api);

  let resolvePrompt: (() => void) | undefined;
  let activePrompt: Promise<void> = Promise.resolve();
  agent = {
    listeners: new Set<Function>(),
    waitForIdle: vi.fn(() => activePrompt),
    prompt: vi.fn(),
    state: {
      isStreaming: false,
      messages: [
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: "Connection error",
          content: [],
        },
      ],
    },
    subscribe(listener: Function) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },
  };

  agent.prompt.mockImplementation(() => {
    agent.state.isStreaming = true;
    activePrompt = new Promise<void>(resolve => {
      resolvePrompt = () => {
        agent.state.isStreaming = false;
        resolve();
      };
    });
    return activePrompt;
  });

  Agent.prototype.subscribe.call(agent, vi.fn());

  let terminalInputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
  const terminalInputUnsubscribe = vi.fn();
  const abort = vi.fn(() => resolvePrompt?.());
  const queuedFollowUps = ["queued continuation"];
  let abortController = new AbortController();
  const nativeInterrupt = vi.fn(() => {
    queuedFollowUps.length = 0;
    abortController.abort();
    resolvePrompt?.();
  });
  const entries = [errorEntry("Connection error")];
  const ctx = {
    mode: "tui",
    ui: {
      notify: vi.fn(),
      onTerminalInput: vi.fn((handler: typeof terminalInputHandler) => {
        terminalInputHandler = handler;
        return terminalInputUnsubscribe;
      }),
    },
    sessionManager: {
      getEntries: vi.fn().mockReturnValue(entries),
    },
    isIdle: () => true,
    get signal() {
      return abortController.signal;
    },
    abort,
  } as unknown as ExtensionContext;

  async function startSession(): Promise<void> {
    for (const handler of handlers.session_start ?? []) {
      await handler({}, ctx);
    }
  }

  await startSession();

  function pressEscape(data = "\x1b"): void {
    const result = terminalInputHandler?.(data);
    if (!result?.consume) nativeInterrupt();
  }

  async function fireInput(): Promise<void> {
    abortController = new AbortController();
    for (const handler of handlers.input ?? []) {
      await handler({ source: "interactive", text: "new work" }, ctx);
    }
  }

  async function fireTurnEnd(message: object): Promise<void> {
    for (const handler of handlers.turn_end ?? []) {
      await handler({ message }, ctx);
    }
  }

  function fireAgentEnd(): void {
    for (const handler of handlers.agent_end ?? []) {
      void handler({ messages: [] }, ctx);
    }
  }

  function restore(): void {
    resolvePrompt?.();
    terminalInputUnsubscribe();
    Agent.prototype.subscribe = originalSubscribe;
    Agent.prototype.continue = originalContinue;
    (AgentSession.prototype as any)._prepareRetry = originalPrepareRetry;
  }

  return {
    abort,
    agent,
    fireAgentEnd,
    fireInput,
    fireTurnEnd,
    getTerminalInputHandler: () => terminalInputHandler,
    nativeInterrupt,
    pressEscape,
    queuedFollowUps,
    restore,
    startSession,
  };
}

describe("retry Escape handling", () => {
  it("aborts a streaming retry even when AgentSession reports idle", async () => {
    const fixture = await setup();
    try {
      fixture.fireAgentEnd();
      await vi.advanceTimersByTimeAsync(2100);

      expect(fixture.agent.prompt).toHaveBeenCalledTimes(1);
      expect(fixture.agent.state.isStreaming).toBe(true);

      fixture.pressEscape();
      expect(fixture.nativeInterrupt).toHaveBeenCalledTimes(1);
      expect(fixture.queuedFollowUps).toEqual([]);
      expect(fixture.abort).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60000);
      expect(fixture.agent.state.isStreaming).toBe(false);
      expect(fixture.agent.prompt).toHaveBeenCalledTimes(1);
    } finally {
      fixture.restore();
    }
  });

  it("cancels the retry during backoff before prompt starts", async () => {
    const fixture = await setup();
    try {
      fixture.fireAgentEnd();
      await vi.advanceTimersByTimeAsync(500);

      fixture.pressEscape();
      expect(fixture.nativeInterrupt).toHaveBeenCalledTimes(1);
      expect(fixture.queuedFollowUps).toEqual([]);
      expect(fixture.abort).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5000);
      expect(fixture.agent.prompt).not.toHaveBeenCalled();
    } finally {
      fixture.restore();
    }
  });

  it("does not retry an error-shaped result when Pi's run signal was aborted", async () => {
    const fixture = await setup();
    try {
      fixture.pressEscape("\x1b[27u");
      await fixture.fireTurnEnd({
        role: "assistant",
        stopReason: "error",
        errorMessage: "Execution cancelled",
        content: [],
      });
      fixture.fireAgentEnd();

      await vi.advanceTimersByTimeAsync(5000);
      expect(fixture.agent.prompt).not.toHaveBeenCalled();
    } finally {
      fixture.restore();
    }
  });

  it("allows a fresh user request to retry after an earlier abort", async () => {
    const fixture = await setup();
    try {
      fixture.pressEscape("\x1b[27u");
      await fixture.fireTurnEnd({
        role: "assistant",
        stopReason: "error",
        errorMessage: "Execution cancelled",
        content: [],
      });
      await fixture.fireInput();
      fixture.fireAgentEnd();

      await vi.advanceTimersByTimeAsync(2100);
      expect(fixture.agent.prompt).toHaveBeenCalledTimes(1);
    } finally {
      fixture.restore();
    }
  });

  it("does not let an old retry consume Escape after a session switch", async () => {
    const fixture = await setup();
    try {
      fixture.fireAgentEnd();
      await vi.advanceTimersByTimeAsync(2100);

      expect(fixture.agent.state.isStreaming).toBe(true);
      await fixture.startSession();

      const result = fixture.getTerminalInputHandler()?.("\x1b");
      expect(result).toBeUndefined();
      expect(fixture.abort).not.toHaveBeenCalled();
    } finally {
      fixture.restore();
    }
  });

  it("leaves Escape untouched when pi-retry is idle", async () => {
    const fixture = await setup();
    try {
      const result = fixture.getTerminalInputHandler()?.("\x1b");
      expect(result).toBeUndefined();
      expect(fixture.abort).not.toHaveBeenCalled();
    } finally {
      fixture.restore();
    }
  });
});
