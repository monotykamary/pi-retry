/**
 * Real SDK regression tests for native child-session retry ownership.
 *
 * These tests use the supported coding-agent SDK, a real ModelRuntime, and the
 * deterministic faux provider. They intentionally keep the child marker in the
 * effective system prompt because that is the pi-subagents launch evidence.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentSession,
  defineTool,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  Type,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";
import retryExtension from "../../retry.ts";

const temporaryRoots: string[] = [];

// Remove all temporary model/settings trees even when a test fails.
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface ChildHarness {
  root: string;
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  faux: ReturnType<typeof fauxProvider>;
  compactionEvents: unknown[];
  waitForFirstError: () => Promise<void>;
  waitForFirstErrorBackoff: () => Promise<void>;
  close: () => Promise<void>;
}

interface ChildHarnessOptions {
  /** Whether the SDK's native provider retry scheduler is enabled. */
  nativeRetryEnabled?: boolean;
  /** Explicit child takeover switch; omitted means inherited/enabled. */
  childRetryEnabled?: boolean;
  /** Whether the generated child marker is present. */
  childMarker?: boolean;
  /** Explicit policy-selection regex list; null omits the match setting. */
  matchSystemPromptRegex?: unknown | null;
  /** Effective system-prompt text appended to this session. */
  systemPrompt?: string;
  /** Whether this harness loads retry.ts into the extension runner. */
  loadRetryExtension?: boolean;
  /** Provider context window used to exercise SDK compaction decisions. */
  contextWindow?: number;
  /** SDK compaction settings for overflow/threshold integration cases. */
  compaction?: {
    enabled?: boolean;
    reserveTokens?: number;
    keepRecentTokens?: number;
  };
  /** Add a second retry factory to exercise actual runner ownership. */
  duplicateRetryFactories?: boolean;
  /** Optional child policy fields that override the inherited main policy. */
  childRetryConfig?: {
    baseDelayMs?: number;
    maxDelayMs?: number;
    multiplier?: number;
    maxRetriesAtMaxDelay?: number;
  };
  /** Public custom tool definitions enabled for the session. */
  customTools?: ToolDefinition[];
  /** Restrict active tools when a custom-tool case needs one deterministic tool. */
  tools?: string[];
}

/**
 * Build one real child-shaped SDK session with a deterministic local provider.
 *
 * @param responses Provider responses consumed in request order.
 * @param baseDelayMs Extension backoff used by the test.
 * @param options SDK and child-policy options for this harness.
 * @returns Session, provider state, and bounded cleanup callback.
 */
async function createChildHarness(
  responses: (ReturnType<typeof fauxAssistantMessage> | ((context: Context) => AssistantMessage | Promise<AssistantMessage>))[],
  baseDelayMs = 30,
  options: ChildHarnessOptions = {},
): Promise<ChildHarness> {
  const root = mkdtempSync(join(tmpdir(), "pi-retry-native-child-"));
  temporaryRoots.push(root);
  const agentDir = join(root, "agent");
  mkdirSync(join(root, ".pi"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  const childRetryConfig = {
    ...(options.childRetryConfig ?? {}),
    ...(options.childRetryEnabled === undefined
      ? {}
      : { enabled: options.childRetryEnabled }),
  };
  const configuredMatch = options.matchSystemPromptRegex === undefined
    ? options.childMarker === false
      ? undefined
      : [{ pattern: '^<active_agent name="[^"\\r\\n]+"/>$', flags: "m" }]
    : options.matchSystemPromptRegex;
  const subagents = {
    ...childRetryConfig,
    ...(configuredMatch === undefined || configuredMatch === null
      ? {}
      : { match: { systemPromptRegex: configuredMatch } }),
  };
  const piRetry = {
    baseDelayMs,
    maxDelayMs: baseDelayMs,
    multiplier: 1,
    maxRetriesAtMaxDelay: 2,
    ...(Object.keys(subagents).length > 0 ? { subagents } : {}),
  };
  writeFileSync(
    join(root, ".pi", "settings.json"),
    JSON.stringify({ piRetry }),
    "utf8",
  );

  const faux = fauxProvider({
    provider: "pi-retry-test-child",
    api: "pi-retry-test-api",
    models: [{ id: "pi-retry-test-model", name: "Retry test model", reasoning: false, contextWindow: options.contextWindow }],
    tokenSize: { min: 1, max: 1 },
  });
  faux.setResponses(responses);

  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.refresh({ allowNetwork: false });
  const model = modelRuntime.getModel("pi-retry-test-child", "pi-retry-test-model");
  if (!model) throw new Error("The deterministic test model was not registered.");

  const settingsManager = SettingsManager.inMemory({
    retry: {
      enabled: options.nativeRetryEnabled ?? false,
      maxRetries: 1,
      baseDelayMs: 0,
    },
    compaction: {
      enabled: options.compaction?.enabled ?? false,
      reserveTokens: options.compaction?.reserveTokens,
      keepRecentTokens: options.compaction?.keepRecentTokens,
    },
  });
  const compactionEvents: unknown[] = [];
  const extraFactories: ExtensionFactory[] = [];
  if (options.compaction?.enabled) {
    extraFactories.push((pi: ExtensionAPI) => {
      pi.on("session_before_compact", event => {
        compactionEvents.push(event);
        return {
          compaction: {
            summary: "deterministic compacted child context",
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
          },
        };
      });
    });
  }
  const retryFactories = options.loadRetryExtension === false
    ? []
    : [
        retryExtension,
        ...(options.duplicateRetryFactories ? [retryExtension] : []),
      ];
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    // This is the launch marker emitted by pi-subagents. The test fixture
    // explicitly configures a matching policy rule instead of relying on it
    // as an implicit production default.
    appendSystemPrompt: options.systemPrompt === undefined
      ? options.childMarker === false
        ? []
        : ['<active_agent name="worker"/>']
      : [options.systemPrompt],
    extensionFactories: [...retryFactories, ...extraFactories],
  });

  // The current extension reads settings at factory startup. Keep this
  // process-global cwd change inside harness construction and restore it before
  // the test can issue a prompt.
  const previousCwd = process.cwd();
  process.chdir(root);
  try {
    await loader.reload();
  } finally {
    process.chdir(previousCwd);
  }

  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    model,
    thinkingLevel: "off",
    modelRuntime,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(root),
    settingsManager,
    customTools: options.customTools,
    tools: options.tools,
  });
  await session.bindExtensions({ mode: "print" });

  let resolveFirstError: (() => void) | undefined;
  let resolveFirstErrorBackoff: (() => void) | undefined;
  let firstErrorObserved = false;
  const firstError = new Promise<void>(resolve => {
    resolveFirstError = resolve;
  });
  const firstErrorBackoff = new Promise<void>(resolve => {
    resolveFirstErrorBackoff = resolve;
  });
  const unsubscribe = session.subscribe((event: any) => {
    if (
      event.type === "message_end" &&
      event.message?.role === "assistant" &&
      event.message?.stopReason === "error"
    ) {
      if (!firstErrorObserved) {
        firstErrorObserved = true;
        resolveFirstError?.();
      }
    }
    // AgentSession emits agent_end only after the child handler's awaited
    // backoff has completed and the hidden request has been queued.
    if (event.type === "agent_end" && firstErrorObserved) {
      resolveFirstErrorBackoff?.();
    }
  });

  return {
    root,
    session,
    faux,
    compactionEvents,
    waitForFirstError: () => firstError,
    waitForFirstErrorBackoff: () => firstErrorBackoff,
    close: async () => {
      // Match the native child host's shutdown ordering before disposal.
      unsubscribe();
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    },
  };
}

describe("native child retry lifecycle", () => {
  it("keeps the original prompt pending through deterministic backoff recovery", async () => {
    const harness = await createChildHarness([
      fauxAssistantMessage("first request failed", {
        stopReason: "error",
        errorMessage: "deterministic transient connection error",
      }),
      fauxAssistantMessage("recovered child result"),
    ]);
    try {
      let promptSettled = false;
      const promptPromise = harness.session.prompt("Task: recover this child request").then(() => {
        promptSettled = true;
      });

      // Observe the persisted first error, rather than only stream start. The
      // provider increments callCount before its response and before the
      // awaited agent_end/backoff lifecycle has begun.
      await harness.waitForFirstErrorBackoff();
      expect(promptSettled).toBe(false);
      expect(harness.session.isStreaming).toBe(true);

      await promptPromise;
      expect(harness.faux.state.callCount).toBe(2);
      expect(harness.faux.getPendingResponseCount()).toBe(0);
      expect(harness.session.messages.at(-1)).toMatchObject({
        role: "assistant",
        stopReason: "stop",
      });
    } finally {
      await harness.close();
    }
  });

  // Native SDK retry remains enabled here; pi-retry must suppress it only for
  // this owned child and recover through the awaited child lifecycle.
  it("takes over a recognized child while native retry is enabled", async () => {
    const harness = await createChildHarness(
      [
        fauxAssistantMessage("first request failed", {
          stopReason: "error",
          errorMessage: "deterministic transient connection error",
        }),
        fauxAssistantMessage("recovered child result"),
      ],
      30,
      { nativeRetryEnabled: true },
    );
    try {
      let promptSettled = false;
      const promptPromise = harness.session.prompt("Task: recover with native retry enabled").then(() => {
        promptSettled = true;
      });

      await harness.waitForFirstErrorBackoff();
      expect(promptSettled).toBe(false);
      expect(harness.session.isStreaming).toBe(true);

      await promptPromise;
      expect(harness.faux.state.callCount).toBe(2);
      expect(harness.session.messages.filter(message => message.role === "custom")).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  // An explicit false child policy must leave the SDK native retry path intact.
  it("delegates a disabled child to native retry", async () => {
    const harness = await createChildHarness(
      [
        fauxAssistantMessage("first request failed", {
          stopReason: "error",
          errorMessage: "deterministic transient connection error",
        }),
        fauxAssistantMessage("native retry recovered"),
      ],
      0,
      { nativeRetryEnabled: true, childRetryEnabled: false },
    );
    try {
      await harness.session.prompt("Task: use native retry");
      expect(harness.faux.state.callCount).toBe(2);
      expect(harness.session.messages.filter(message => message.role === "custom")).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  // User-configured OR rules, arbitrary markers, and flags select inline recovery.
  it("selects inline recovery from an arbitrary configured system prompt rule", async () => {
    const harness = await createChildHarness(
      [
        fauxAssistantMessage("configured child failed", {
          stopReason: "error",
          errorMessage: "deterministic configured-child connection error",
        }),
        fauxAssistantMessage("configured child recovered"),
      ],
      30,
      {
        nativeRetryEnabled: true,
        childMarker: false,
        systemPrompt: '<worker_profile mode="retry"/>',
        matchSystemPromptRegex: [
          { pattern: "<never-selected>", flags: "i" },
          { pattern: '^<WORKER_PROFILE MODE="RETRY"/>$', flags: "im" },
        ],
      },
    );
    try {
      let promptSettled = false;
      const promptPromise = harness.session.prompt("Recover the configured child.").then(() => {
        promptSettled = true;
      });

      await harness.waitForFirstErrorBackoff();
      expect(promptSettled).toBe(false);
      expect(harness.session.isStreaming).toBe(true);

      await promptPromise;
      expect(harness.faux.state.callCount).toBe(2);
      expect(harness.session.messages.filter(message => message.role === "custom")).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  // An old third-party marker has no meaning when the user omits match rules.
  it("keeps the ordinary extension route when the old marker has no rule", async () => {
    const harness = await createChildHarness(
      [
        fauxAssistantMessage("ordinary route failed", {
          stopReason: "error",
          errorMessage: "deterministic ordinary-route connection error",
        }),
        fauxAssistantMessage("ordinary route recovered"),
      ],
      0,
      { nativeRetryEnabled: true, matchSystemPromptRegex: null },
    );
    try {
      // The ordinary route intentionally detaches its hidden retry, so the
      // host prompt can settle before the follow-up request is delivered.
      const promptPromise = harness.session.prompt("Use ordinary pi-retry handling.");
      await harness.waitForFirstErrorBackoff();
      await promptPromise;
      await new Promise<void>(resolve => setTimeout(resolve, 50));

      expect(harness.faux.state.callCount).toBe(2);
      expect(harness.session.messages.filter(message => message.role === "custom")).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  // Invalid syntax produces no child selection and cannot fall back to a broad rule.
  it("keeps ordinary handling when the configured matcher is malformed", async () => {
    const harness = await createChildHarness(
      [
        fauxAssistantMessage("malformed matcher failed", {
          stopReason: "error",
          errorMessage: "deterministic malformed-matcher connection error",
        }),
        fauxAssistantMessage("malformed matcher recovered"),
      ],
      0,
      {
        nativeRetryEnabled: true,
        matchSystemPromptRegex: [{ pattern: "[" }],
      },
    );
    try {
      const promptPromise = harness.session.prompt("Use ordinary handling after invalid configuration.");
      await harness.waitForFirstErrorBackoff();
      await promptPromise;
      await new Promise<void>(resolve => setTimeout(resolve, 50));

      expect(harness.faux.state.callCount).toBe(2);
      expect(harness.session.messages.filter(message => message.role === "custom")).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  // A matcher result from one session must not classify a later session.
  it("does not leak matcher state across sessions", async () => {
    const matchSystemPromptRegex = [
      { pattern: "^<worker-profile/>$", flags: "m" },
    ];
    const matched = await createChildHarness(
      [
        fauxAssistantMessage("matched session failed", {
          stopReason: "error",
          errorMessage: "deterministic matched-session connection error",
        }),
        fauxAssistantMessage("matched session recovered"),
      ],
      0,
      {
        nativeRetryEnabled: true,
        childMarker: false,
        systemPrompt: "<worker-profile/>",
        matchSystemPromptRegex,
      },
    );
    try {
      await matched.session.prompt("Use the selected inline policy.");
      expect(matched.faux.state.callCount).toBe(2);
      expect(matched.session.messages.filter(message => message.role === "custom")).toHaveLength(1);
    } finally {
      await matched.close();
    }

    const ordinary = await createChildHarness(
      [
        fauxAssistantMessage("ordinary session failed", {
          stopReason: "error",
          errorMessage: "deterministic ordinary-session connection error",
        }),
        fauxAssistantMessage("ordinary session recovered"),
      ],
      0,
      {
        nativeRetryEnabled: true,
        systemPrompt: '<active_agent name="worker"/>',
        matchSystemPromptRegex,
      },
    );
    try {
      // The old marker is intentionally present but does not match the rule.
      const promptPromise = ordinary.session.prompt("Use ordinary handling.");
      await ordinary.waitForFirstErrorBackoff();
      await promptPromise;
      await new Promise<void>(resolve => setTimeout(resolve, 50));

      expect(ordinary.faux.state.callCount).toBe(2);
      expect(ordinary.session.messages.filter(message => message.role === "custom")).toHaveLength(1);
    } finally {
      await ordinary.close();
    }
  });

  // Without a loaded extension there is no registry binding, so the global
  // prototype hook must delegate native retry even when the marker is absent.
  it("delegates an unregistered session to native retry", async () => {
    const harness = await createChildHarness(
      [
        fauxAssistantMessage("first request failed", {
          stopReason: "error",
          errorMessage: "deterministic transient connection error",
        }),
        fauxAssistantMessage("unregistered retry recovered"),
      ],
      0,
      { nativeRetryEnabled: true, childMarker: false, loadRetryExtension: false },
    );
    try {
      await harness.session.prompt("Task: unmanaged native retry");
      expect(harness.faux.state.callCount).toBe(2);
      expect(harness.session.messages.filter(message => message.role === "custom")).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});

/**
 * Risk-focused SDK integration coverage for ownership, queues, and shutdown.
 *
 * Each test uses the same real AgentSession path as a native child launch and
 * keeps provider responses local and deterministic.
 */
describe("native child retry risk coverage", () => {
  // TEST:__tests__/integration/native-child-lifecycle.test.ts[concurrent session isolation]
  it("isolates main state and two child policies while one child is aborted", async () => {
    const main = await createChildHarness(
      [fauxAssistantMessage("main completed")],
      0,
      { childMarker: false },
    );
    const fastChild = await createChildHarness(
      [
        fauxAssistantMessage("fast child failed", {
          stopReason: "error",
          errorMessage: "fast child connection error",
        }),
        fauxAssistantMessage("fast child recovered"),
      ],
      0,
      { childRetryConfig: { baseDelayMs: 0, maxDelayMs: 0 } },
    );
    const canceledChild = await createChildHarness(
      [
        fauxAssistantMessage("canceled child failed", {
          stopReason: "error",
          errorMessage: "canceled child connection error",
        }),
        fauxAssistantMessage("must never be requested"),
      ],
      180,
      { childRetryConfig: { baseDelayMs: 180, maxDelayMs: 180 } },
    );
    try {
      const mainPrompt = main.session.prompt("Complete the main request.");
      const fastPrompt = fastChild.session.prompt("Recover the fast child.");
      const canceledPrompt = canceledChild.session.prompt("Abort the slow child.");

      // Abort only the slow child's active run while the other two sessions
      // continue through their own provider requests and retry state.
      await canceledChild.waitForFirstError();
      await canceledChild.session.abort();
      await Promise.all([mainPrompt, fastPrompt, canceledPrompt]);

      expect(main.faux.state.callCount).toBe(1);
      expect(fastChild.faux.state.callCount).toBe(2);
      expect(fastChild.session.messages.filter(message => message.role === "custom")).toHaveLength(1);
      expect(canceledChild.faux.state.callCount).toBe(1);
      expect(canceledChild.session.messages.filter(message => message.role === "custom")).toHaveLength(0);
    } finally {
      await Promise.all([main.close(), fastChild.close(), canceledChild.close()]);
    }
  });

  // TEST:__tests__/integration/native-child-lifecycle.test.ts[completed tool result preservation]
  it("preserves one completed tool result through a bare stream error retry", async () => {
    let toolExecutionCount = 0;
    const countedTool = defineTool({
      name: "counted_tool",
      label: "Counted Tool",
      description: "Return one deterministic tool result for retry testing.",
      parameters: Type.Object({
        value: Type.String(),
      }),
      async execute(_toolCallId, params) {
        toolExecutionCount++;
        return {
          content: [{ type: "text", text: `tool-result:${params.value}` }],
          details: { execution: toolExecutionCount },
        };
      },
    });
    const contexts: Context[] = [];
    const toolCallId = "counted-tool-call-1";
    const harness = await createChildHarness(
      [
        context => {
          contexts.push({ ...context, messages: [...context.messages] });
          return fauxAssistantMessage(
            fauxToolCall("counted_tool", { value: "one" }, { id: toolCallId }),
            { stopReason: "toolUse" },
          );
        },
        context => {
          contexts.push({ ...context, messages: [...context.messages] });
          return fauxAssistantMessage([], {
            stopReason: "error",
            // This is a bare stream-exhaustion error with no assistant content.
            errorMessage: "request ended without sending any chunks",
          });
        },
        context => {
          contexts.push({ ...context, messages: [...context.messages] });
          return fauxAssistantMessage("recovered after completed tool");
        },
      ],
      0,
      { customTools: [countedTool], tools: ["counted_tool"] },
    );
    try {
      await harness.session.prompt("Use counted_tool, then finish the task.");

      expect(harness.faux.state.callCount).toBe(3);
      expect(toolExecutionCount).toBe(1);
      expect(contexts).toHaveLength(3);
      for (const context of contexts.slice(1)) {
        const toolResults = context.messages.filter(message => message.role === "toolResult");
        expect(toolResults).toHaveLength(1);
        expect(toolResults[0]).toMatchObject({
          toolCallId,
          toolName: "counted_tool",
          isError: false,
        });
      }
      expect(harness.session.messages.filter(message => message.role === "toolResult")).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  // TEST:__tests__/integration/native-child-lifecycle.test.ts[retry cap]
  it("exhausts repeated child errors exactly at the configured cap", async () => {
    const harness = await createChildHarness(
      [
        fauxAssistantMessage("error one", {
          stopReason: "error",
          errorMessage: "connection error one",
        }),
        fauxAssistantMessage("error two", {
          stopReason: "error",
          errorMessage: "connection error two",
        }),
        fauxAssistantMessage("error three", {
          stopReason: "error",
          errorMessage: "connection error three",
        }),
        fauxAssistantMessage("unexpected fourth request"),
      ],
      1,
      { childRetryConfig: { baseDelayMs: 1, maxDelayMs: 1, maxRetriesAtMaxDelay: 2 } },
    );
    try {
      await harness.session.prompt("Stop after the configured child retry cap.");

      // The initial request plus exactly two capped retries are delivered; the
      // fourth scripted response remains untouched.
      expect(harness.faux.state.callCount).toBe(3);
      expect(harness.faux.getPendingResponseCount()).toBe(1);
      expect(harness.session.messages.filter(message => message.role === "custom")).toHaveLength(2);
    } finally {
      await harness.close();
    }
  });

  // TEST:__tests__/integration/native-child-lifecycle.test.ts[subsequent quota classification]
  it("rechecks quota classification after a transient child error", async () => {
    const harness = await createChildHarness(
      [
        fauxAssistantMessage("transient error", {
          stopReason: "error",
          errorMessage: "connection error before the quota response",
        }),
        fauxAssistantMessage("quota exhausted", {
          stopReason: "error",
          errorMessage: "You've hit your usage limit; it resets tomorrow",
        }),
        fauxAssistantMessage("must not retry quota exhaustion"),
      ],
      0,
      { childRetryConfig: { baseDelayMs: 0, maxDelayMs: 0 } },
    );
    try {
      await harness.session.prompt("Stop when the provider reports quota exhaustion.");

      expect(harness.faux.state.callCount).toBe(2);
      expect(harness.faux.getPendingResponseCount()).toBe(1);
      expect(harness.session.messages.filter(message => message.role === "custom")).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  // TEST:__tests__/integration/native-child-lifecycle.test.ts[subsequent permanent classification]
  it("rechecks permanent classification after a transient child error", async () => {
    const harness = await createChildHarness(
      [
        fauxAssistantMessage("transient error", {
          stopReason: "error",
          errorMessage: "connection error before the permanent response",
        }),
        fauxAssistantMessage("permanent authentication error", {
          stopReason: "error",
          errorMessage: "invalid API key provided by the provider",
        }),
        fauxAssistantMessage("must not retry permanent errors"),
      ],
      0,
      { childRetryConfig: { baseDelayMs: 0, maxDelayMs: 0 } },
    );
    try {
      await harness.session.prompt("Stop when authentication becomes invalid.");

      expect(harness.faux.state.callCount).toBe(2);
      expect(harness.faux.getPendingResponseCount()).toBe(1);
      expect(harness.session.messages.filter(message => message.role === "custom")).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  // TEST:__tests__/integration/native-child-lifecycle.test.ts[abort during backoff]
  it("settles a prompt promptly when abort interrupts child backoff", async () => {
    const harness = await createChildHarness(
      [
        fauxAssistantMessage("backoff error", {
          stopReason: "error",
          errorMessage: "connection error during backoff",
        }),
        fauxAssistantMessage("must not arrive after abort"),
      ],
      250,
      { childRetryConfig: { baseDelayMs: 250, maxDelayMs: 250 } },
    );
    try {
      const promptPromise = harness.session.prompt("Abort during retry backoff.");
      await harness.waitForFirstError();
      const settled = await Promise.race([
        harness.session.abort().then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1_000)),
      ]);

      expect(settled).toBe(true);
      await promptPromise;
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(harness.faux.state.callCount).toBe(1);
    } finally {
      await harness.close();
    }
  });

  // TEST:__tests__/integration/native-child-lifecycle.test.ts[session shutdown during backoff]
  it("settles and sends no late request when session_shutdown interrupts backoff", async () => {
    const harness = await createChildHarness(
      [
        fauxAssistantMessage("shutdown error", {
          stopReason: "error",
          errorMessage: "connection error before shutdown",
        }),
        fauxAssistantMessage("must not arrive after shutdown"),
      ],
      250,
      { childRetryConfig: { baseDelayMs: 250, maxDelayMs: 250 } },
    );
    try {
      const promptPromise = harness.session.prompt("Shutdown during retry backoff.");
      await harness.waitForFirstError();
      await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
      const settled = await Promise.race([
        promptPromise.then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1_000)),
      ]);

      expect(settled).toBe(true);
      await promptPromise;
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(harness.faux.state.callCount).toBe(1);
    } finally {
      await harness.close();
    }
  });

  // TEST:__tests__/integration/native-child-lifecycle.test.ts[length and empty queues]
  it("uses one follow-up queue turn for a length continuation", async () => {
    const contexts: Context[] = [];
    const harness = await createChildHarness(
      [
        context => {
          contexts.push({ ...context, messages: [...context.messages] });
          return fauxAssistantMessage("partial answer", { stopReason: "length" });
        },
        context => {
          contexts.push({ ...context, messages: [...context.messages] });
          return fauxAssistantMessage("completed length continuation");
        },
      ],
      0,
    );
    try {
      await harness.session.prompt("Continue the truncated child answer.");

      expect(harness.faux.state.callCount).toBe(2);
      expect(harness.faux.getPendingResponseCount()).toBe(0);
      expect(harness.session.messages.filter(message => message.role === "custom")).toHaveLength(1);
      expect(contexts[1]?.messages.some(message =>
        message.role === "assistant" &&
        message.stopReason === "length" &&
        message.content.some(block => block.type === "text" && block.text === "partial answer"),
      )).toBe(true);
    } finally {
      await harness.close();
    }
  });

  // TEST:__tests__/integration/native-child-lifecycle.test.ts[empty response queue]
  it("uses one follow-up queue turn for an empty child response", async () => {
    const contexts: Context[] = [];
    const harness = await createChildHarness(
      [
        context => {
          contexts.push({ ...context, messages: [...context.messages] });
          return fauxAssistantMessage([], { stopReason: "stop" });
        },
        context => {
          contexts.push({ ...context, messages: [...context.messages] });
          return fauxAssistantMessage("completed empty continuation");
        },
      ],
      0,
    );
    try {
      await harness.session.prompt("Nudge the empty child response once.");

      expect(harness.faux.state.callCount).toBe(2);
      expect(harness.faux.getPendingResponseCount()).toBe(0);
      expect(harness.session.messages.filter(message => message.role === "custom")).toHaveLength(1);
      expect(contexts[1]?.messages.at(-1)).toMatchObject({ role: "user" });
    } finally {
      await harness.close();
    }
  });

  // TEST:__tests__/integration/native-child-lifecycle.test.ts[overflow compaction deferral]
  it("defers overflow to SDK compaction instead of child retry", async () => {
    const setupTool = defineTool({
      name: "setup_overflow_context",
      label: "Setup Overflow Context",
      description: "Create a completed tool result before the overflow response.",
      parameters: Type.Object({}),
      async execute() {
        return {
          content: [{ type: "text", text: "completed setup result" }],
          details: { setup: true },
        };
      },
    });
    const harness = await createChildHarness(
      [
        fauxAssistantMessage(
          fauxToolCall("setup_overflow_context", {}, { id: "overflow-tool-call" }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage([], {
          stopReason: "error",
          errorMessage: "prompt is too long: 213462 tokens > 200000 maximum",
        }),
        fauxAssistantMessage("recovered after SDK compaction"),
      ],
      0,
      {
        contextWindow: 128_000,
        customTools: [setupTool],
        tools: ["setup_overflow_context"],
        compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
      },
    );
    try {
      await harness.session.prompt("Build enough context to exercise overflow compaction.");

      expect(harness.faux.state.callCount).toBe(3);
      expect(harness.faux.getPendingResponseCount()).toBe(0);
      expect(harness.compactionEvents).toHaveLength(1);
      expect(harness.session.messages.some(message =>
        message.role === "compactionSummary" &&
        message.summary === "deterministic compacted child context",
      )).toBe(true);
      // The overflow is handled by the SDK compaction path, so pi-retry adds
      // no custom retry trigger for this response.
      expect(harness.session.messages.filter(message => message.role === "custom")).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  // TEST:__tests__/integration/native-child-lifecycle.test.ts[duplicate runner ownership]
  it("keeps one owner through duplicate factory startup and reload", async () => {
    const harness = await createChildHarness(
      [
        fauxAssistantMessage("duplicate factory error", {
          stopReason: "error",
          errorMessage: "connection error under duplicate factories",
        }),
        fauxAssistantMessage("duplicate factory recovered"),
      ],
      0,
      { duplicateRetryFactories: true },
    );
    try {
      // Rebinding after an explicit reload shutdown exercises the same
      // ExtensionRunner handlers that a runtime reload invokes.
      await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
      await harness.session.bindExtensions({ mode: "print" });
      await harness.session.prompt("Recover with duplicate retry factories loaded.");

      expect(harness.faux.state.callCount).toBe(2);
      expect(harness.session.messages.filter(message => message.role === "custom")).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });
});
