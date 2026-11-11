/**
 * Exercise `/retry-after` through real Pi command dispatch and provider input.
 *
 * TEST:retry.ts[retry-after, triggerInvisibleContinue]
 * TEST:src/child-retry.ts[runSchedule]
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import retryExtension from "../../retry.ts";

/** Temporary agent roots removed after each real-session scenario. */
const temporaryRoots: string[] = [];

// Clean up real session files even when an assertion fails.
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("scheduled retry with a real Pi session", () => {
  // TEST:retry.ts[retry-after, triggerInvisibleContinue], src/child-retry.ts[runSchedule]
  it.each(["rpc", "print"] as const)("delivers additional instructions to the provider in %s mode", async mode => {
    const root = mkdtempSync(join(tmpdir(), "pi-retry-after-"));
    temporaryRoots.push(root);
    const agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });

    const faux = fauxProvider({
      provider: "pi-retry-after-test",
      api: "pi-retry-after-test-api",
      models: [{ id: "retry-after-model", name: "Retry after test", reasoning: false }],
      tokenSize: { min: 1, max: 1 },
    });
    let providerMessages: unknown;
    // A quota error does not start an automatic retry; the command may retry it once.
    faux.setResponses([
      () => { throw new Error("You've hit your limit"); },
      context => {
        providerMessages = context.messages;
        return fauxAssistantMessage("done");
      },
    ]);

    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.refresh({ allowNetwork: false });
    const model = modelRuntime.getModel("pi-retry-after-test", "retry-after-model");
    if (!model) throw new Error("The deterministic retry-after test model was not registered.");

    const settingsManager = SettingsManager.inMemory({
      retry: { enabled: false },
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
      extensionFactories: [retryExtension],
    });
    // The extension reads its settings from the process cwd during reload.
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
    });
    await session.bindExtensions({ mode });
    let resolveSuccess: (() => void) | undefined;
    const success = new Promise<void>(resolve => { resolveSuccess = resolve; });
    session.subscribe((event: any) => {
      if (event.type === "message_end" && event.message?.role === "assistant" && event.message.stopReason === "stop") {
        resolveSuccess?.();
      }
    });

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await session.prompt("Please solve the original task.");
      const started = Date.now();
      await session.prompt("/retry-after 1s Use the updated endpoint and explain the result.");
      expect(faux.state.callCount).toBe(1);
      await Promise.race([
        success,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Timed out waiting for the scheduled retry.")), 8_000);
        }),
      ]);
      expect(Date.now() - started).toBeGreaterThanOrEqual(950);
      expect(faux.state.callCount).toBe(2);
      expect(JSON.stringify(providerMessages)).toContain("Additional user instructions:\\nUse the updated endpoint and explain the result.");
    } finally {
      if (timeout) clearTimeout(timeout);
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  }, 12_000);
});
