/**
 * Real SDK regression test for the detached (non-inline) retry loop.
 *
 * Ordinary sessions in "tui" and "rpc" mode retry through the detached
 * triggerInvisibleContinue() loop. Pi >= 1.2 prepares a hidden retry turn
 * asynchronously, so right after pi.sendMessage() the low-level Agent has no
 * active run yet and Agent.waitForIdle() resolves at once. The loop used to
 * read the stale tool result, decide the retry was complete, and exit; the next
 * agent_end then restarted it with the attempt counter at zero, so every retry
 * waited only the base delay and the exponential backoff never grew.
 *
 * The test uses a real AgentSession (no artificial delays) and a faux provider
 * that fails with the same retryable error several times, then checks that the
 * gaps between consecutive failures grow by the configured multiplier.
 *
 * A second scenario adds an extension whose agent_settled handler runs longer
 * than the first backoff delay. AgentSession defers a message sent while that
 * event is still being emitted, so the loop must also wait for the full session
 * lifecycle before its first send, not only after it.
 *
 * Note: "print" and "json" mode are intentionally NOT used. They route through
 * the inline controller and never exercise the detached loop.
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
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import retryExtension from "../../retry.ts";

const temporaryRoots: string[] = [];

// Remove temporary directories whether the test passes or fails.
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Fixed error text that the extension classifies as retryable. */
const TRANSIENT_ERROR = "deterministic transient connection error";

/** Timer jitter allowance when comparing measured gaps with the schedule. */
const TIMER_SLACK_MS = 20;

/** Base retry delay used by every scenario; the multiplier is 2. */
const BASE_DELAY_MS = 200;

/**
 * Run one real-session scenario and measure the gaps between failed responses.
 *
 * @param settledDelayMs How long a second extension's agent_settled handler
 *   blocks; 0 registers no such handler.
 * @returns Gaps in milliseconds between consecutive failed assistant messages.
 */
async function measureBackoffGaps(settledDelayMs: number): Promise<number[]> {
  const baseDelayMs = BASE_DELAY_MS;
  const root = mkdtempSync(join(tmpdir(), "pi-retry-detached-backoff-"));
  temporaryRoots.push(root);
  const agentDir = join(root, "agent");
  mkdirSync(join(root, ".pi"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  // Ordinary-session policy: 200ms base, x2, and a cap far above the test range.
  writeFileSync(
    join(root, ".pi", "settings.json"),
    JSON.stringify({
      piRetry: { baseDelayMs, maxDelayMs: 60_000, multiplier: 2, maxRetriesAtMaxDelay: 3 },
    }),
    "utf8",
  );

  const faux = fauxProvider({
    provider: "pi-retry-test-detached",
    api: "pi-retry-test-api",
    models: [{ id: "pi-retry-test-model", name: "Retry test model", reasoning: false }],
    tokenSize: { min: 1, max: 1 },
  });
  // Real sessions fail after a tool turn inside the same run: one tool call
  // first, then four failures in a row, then success. A thrown error is the
  // same path as a real "Provider is not configured" / 503 stream failure.
  const failure = () => () => {
    throw new Error(TRANSIENT_ERROR);
  };
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("noop_tool", {}, { id: "c1" }), { stopReason: "toolUse" }),
    failure(), failure(), failure(), failure(),
    fauxAssistantMessage("ok"),
  ]);
  const noopTool = defineTool({
    name: "noop_tool",
    label: "Noop",
    description: "Return a fixed result.",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  });

  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.refresh({ allowNetwork: false });
  const model = modelRuntime.getModel("pi-retry-test-detached", "pi-retry-test-model");
  if (!model) throw new Error("The deterministic test model was not registered.");

  const settingsManager = SettingsManager.inMemory({
    // Same as a typical user setup: native retry on, suppressed by the extension.
    retry: { enabled: true, maxRetries: 5, baseDelayMs: 200 },
    compaction: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      retryExtension,
      // A slow agent_settled handler, as a real extension doing I/O would have.
      ...(settledDelayMs > 0
        ? [(pi: any) => {
            pi.on("agent_settled", async () => {
              await new Promise<void>(resolve => setTimeout(resolve, settledDelayMs));
            });
          }]
        : []),
    ],
  });
  // The extension reads settings by cwd while its factory runs, so switch the
  // process directory only for the reload.
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
    customTools: [noopTool],
  });
  // "rpc" keeps the session on the detached loop (see the file header).
  await session.bindExtensions({ mode: "rpc" });

  // Record when each failed assistant message lands; neighbouring
  // differences are the real backoff durations.
  const errorTimes: number[] = [];
  let recovered: (() => void) | undefined;
  const done = new Promise<void>(resolve => {
    recovered = resolve;
  });
  session.subscribe((event: any) => {
    if (event.type !== "message_end" || event.message?.role !== "assistant") return;
    if (event.message.stopReason === "error") errorTimes.push(Date.now());
    // Only a final normal stop counts as recovery; a tool-call turn does not.
    else if (event.message.stopReason === "stop") recovered?.();
  });

  try {
    await session.prompt("hi");
    await Promise.race([
      done,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for recovery")), 20_000)),
    ]);
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }

  expect(errorTimes.length).toBe(4);
  return errorTimes.slice(1).map((time, index) => time - errorTimes[index]);
}

describe("detached retry loop backoff (real AgentSession)", () => {
  /**
   * Assert the gaps follow the 200 / 400 / 800 ms schedule. Only lower bounds
   * are checked, so a slow CI runner cannot fail the test spuriously.
   */
  function expectGrowingBackoff(gaps: number[]): void {
    expect(gaps[0]).toBeGreaterThanOrEqual(BASE_DELAY_MS - TIMER_SLACK_MS);
    expect(gaps[1]).toBeGreaterThanOrEqual(BASE_DELAY_MS * 2 - TIMER_SLACK_MS);
    expect(gaps[2]).toBeGreaterThanOrEqual(BASE_DELAY_MS * 4 - TIMER_SLACK_MS);
  }

  // TEST target: retry.ts[triggerInvisibleContinue], src/session-registry.ts[waitForSessionIdle]
  // The pre-fix flat schedule gave about 200ms three times, which fails the
  // second and third assertions.
  it("grows the delay between consecutive failures instead of repeating the base delay", async () => {
    expectGrowingBackoff(await measureBackoffGaps(0));
  }, 30_000);

  // TEST target: retry.ts[triggerInvisibleContinue], src/session-registry.ts[waitForSessionIdle]
  // An agent_settled handler (700ms) outlives the first backoff (200ms), so the
  // first hidden send lands while AgentSession is still emitting the event.
  it("keeps growing the delay when an agent_settled handler outlives the first backoff", async () => {
    expectGrowingBackoff(await measureBackoffGaps(700));
  }, 30_000);
});
