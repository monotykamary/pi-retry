import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getErrorCategory,
  hasQuotaExhaustedError,
  isAssistantMessage,
  isNonRetryableError,
  isSilencedError,
  getLastAssistantMessage,
} from "./src/index.js";
import {
  DEFAULT_RETRY_CONFIG,
  loadPiRetrySettings,
} from "./src/config.js";
import type { RetryState } from "./src/retry-logic.js";
import {
  getRetrySession,
  installRetrySdkHooks,
  registerRetrySession,
  resetRetryTracker,
  unregisterRetrySession,
  type AgentSessionLike,
  type RetrySessionBinding,
} from "./src/session-registry.js";

const RETRY_STARTED_EVENT = "pi-retry:started";
const RETRY_COMPLETED_EVENT = "pi-retry:completed";
const RETRY_CANCELLED_EVENT = "pi-retry:cancelled";

// The registry only patches the supported SDK seam. Unsupported shapes leave
// native retry untouched and disable extension policy rather than stranding a
// session in an out-of-band loop.
const sdkHooksSupported = installRetrySdkHooks();

/**
 * Unified retry extension — retries EVERY error by default through pi's
 * NATIVE retry seam.
 *
 * Philosophy: any assistant message with stopReason === "error" is retried
 * with exponential backoff capped by settings, then stops after the configured
 * number of failures at the maximum delay, except a small blacklist of known
 * permanent failures and hard-stop conditions (invalid API key, model not
 * found, quota/session-limit/budget exhaustion, suspended accounts, etc.).
 *
 * Mechanism (no injected messages):
 *   - A prototype patch on AgentSession._isRetryableError extends native
 *     classification with pi-retry's broader patterns (400/413, credit,
 *     connection, catch-all) while keeping overflow → compaction and the
 *     quota blacklist authoritative.
 *   - A prototype patch on AgentSession._prepareRetry vetoes retries beyond
 *     the max-delay failure cap and injects pi-retry's backoff settings for
 *     the delegated native attempt. Native then pops the error assistant
 *     message (durable context_edit on pi 0.87+), sleeps with abortable
 *     backoff, and continues with identical context — zero injected turns.
 *   - Counters reset on success, fresh input, abort, /retry reset, and
 *     session start.
 *
 * Removed in 0.11.0: max-tokens auto-continues and empty-stop nudges.
 * Agent.continue() forbids assistant-final context, so those cases cannot be
 * retried message-free; use /retry at a user/tool boundary instead.
 */

/**
 * Match one effective system prompt against the resolved policy rules.
 *
 * Rules are compiled during settings resolution and are evaluated only while
 * classifying a session. Resetting lastIndex before and after each test keeps
 * this helper safe if a future caller supplies a stateful RegExp instance.
 *
 * @param systemPrompt Effective SDK system prompt to inspect.
 * @param rules Compiled user-configured regex rules.
 * @returns True when any configured rule matches the prompt.
 */
function matchesConfiguredSystemPrompt(
  systemPrompt: string,
  rules: readonly RegExp[],
): boolean {
  for (const rule of rules) {
    rule.lastIndex = 0;
    const matches = rule.test(systemPrompt);
    rule.lastIndex = 0;
    if (matches) return true;
  }
  return false;
}

/**
 * Read a session's effective system prompt without allowing malformed contexts
 * to break normal extension startup.
 *
 * @param ctx SDK extension context or a test-compatible context.
 * @returns Effective system prompt, or an empty string when unavailable.
 */
function readEffectiveSystemPrompt(ctx: { getSystemPrompt?: () => string }): string {
  try {
    return typeof ctx.getSystemPrompt === "function" ? ctx.getSystemPrompt() : "";
  } catch {
    return "";
  }
}

export default function (pi: ExtensionAPI) {
  // SAFETY: only object identity of the extension API instance matters here;
  // no ExtensionAPI members are accessed through this alias.
  const owner = pi as unknown as object;

  /**
   * Update one session's child classification and retry policy binding.
   *
   * @param ctx SDK context used for cwd, identity, and system prompt lookup.
   * @param systemPrompt Optional event-local effective system prompt.
   * @returns The binding, or undefined when SDK identity is unavailable.
   */
  function configureSession(
    ctx: { cwd?: string; sessionManager?: unknown; getSystemPrompt?: () => string },
    systemPrompt?: string,
  ): RetrySessionBinding | undefined {
    const sessionManager = ctx.sessionManager;
    if (!sessionManager || typeof sessionManager !== "object") return undefined;
    const settings = ctx.cwd === undefined
      ? {
          main: DEFAULT_RETRY_CONFIG,
          subagents: {
            enabled: true,
            ...DEFAULT_RETRY_CONFIG,
            match: { systemPromptRegex: [] },
          },
        }
      : loadPiRetrySettings(ctx.cwd);
    // Child policy selection is an explicit user-configured classification;
    // a matched prompt selects the child config for the shared native seam.
    const child = matchesConfiguredSystemPrompt(
      systemPrompt ?? readEffectiveSystemPrompt(ctx),
      settings.subagents.match.systemPromptRegex,
    );
    const registered = registerRetrySession(sessionManager, owner, {
      isChild: child,
      managedRetry: !child || settings.subagents.enabled,
      config: child ? settings.subagents : settings.main,
    });
    if (!registered) return undefined;
    return registered.binding;
  }

  /**
   * Emit one lifecycle event while containing stale-session event-bus errors.
   *
   * @param event Lifecycle event name.
   * @param retryId Session-local lifecycle id.
   */
  function emitRetryLifecycleEvent(event: string, retryId: number): void {
    try {
      pi.events.emit(event, { retryId });
    } catch (error) {
      // Session replacement invalidates the old event bus while a native
      // retry can still be unwinding. There is no live listener to notify then.
      if (error instanceof Error && error.message.includes("This extension ctx is stale")) return;
      throw error;
    }
  }

  /**
   * Bridge native auto_retry_start/end session events onto pi.events so the
   * legacy pi-retry:started/completed/cancelled integrations keep working.
   *
   * @param binding Owned session binding with a captured AgentSession.
   */
  function bindLifecycleBridge(binding: RetrySessionBinding): void {
    if (binding.lifecycleUnsubscribe !== undefined) return;
    const session = binding.session as AgentSessionLike;
    if (typeof session.subscribe !== "function") return;
    let lifecycleId = 0;
    const unsubscribe = session.subscribe((event: { type: string }) => {
      if (event.type === "auto_retry_start") {
        emitRetryLifecycleEvent(RETRY_STARTED_EVENT, ++lifecycleId);
      } else if (event.type === "auto_retry_end") {
        const success = (event as { success?: boolean }).success === true;
        emitRetryLifecycleEvent(
          success ? RETRY_COMPLETED_EVENT : RETRY_CANCELLED_EVENT,
          lifecycleId,
        );
      }
    });
    binding.lifecycleUnsubscribe = unsubscribe ?? null;
  }

  // Unsupported SDK versions retain native retry and do not apply policy.
  if (!sdkHooksSupported) return;

  pi.on("before_agent_start", (event, ctx) => {
    const binding = configureSession(ctx, event.systemPrompt);
    if (binding?.owner === owner) bindLifecycleBridge(binding);
  });

  // Fresh user input abandons the previous input's retry pacing entirely.
  pi.on("input", (_event, ctx) => {
    const binding = getRetrySession(ctx.sessionManager);
    if (!binding || binding.owner !== owner) return;
    resetRetryTracker(binding);
  });

  // Reset retry counters on success or user abort.
  pi.on("turn_end", (event, ctx) => {
    const binding = getRetrySession(ctx.sessionManager);
    if (!binding || binding.owner !== owner) return;
    const msg = event.message as { role?: string; stopReason?: string };
    if (
      ctx.signal?.aborted ||
      (msg.role === "assistant" && msg.stopReason === "aborted")
    ) {
      // User cancelled — reset retry state so it doesn't leak into other
      // branches of the session tree. The signal check matters for tool calls:
      // some tools/providers finish with an error-shaped result after abort.
      resetRetryTracker(binding);
      return;
    }
    if (msg.role === "assistant" && msg.stopReason !== "error") {
      resetRetryTracker(binding);
    }
  });

  // Notify on permanent failures native does not retry. Retryable errors are
  // driven entirely by the native seam (auto_retry_* events feed the TUI).
  pi.on("agent_end", (event, ctx) => {
    const binding = getRetrySession(ctx.sessionManager);
    if (!binding || binding.owner !== owner) return;
    const lastAssistant = getLastAssistantMessage(ctx.sessionManager.getEntries());
    if (!lastAssistant || !isAssistantMessage(lastAssistant)) return;
    const errored =
      lastAssistant.stopReason === "error" ||
      event.messages.some((message) => isAssistantMessage(message) && message.stopReason === "error");
    if (!errored) return;
    if (isNonRetryableError(lastAssistant) && !isSilencedError(lastAssistant)) {
      const errorMsg = lastAssistant.errorMessage || "Unknown error";
      ctx.ui.notify(
        hasQuotaExhaustedError(lastAssistant)
          ? `Quota/limit exhausted — not retrying (fix plan/billing or wait for the reset window, then /retry): ${errorMsg.substring(0, 100)}`
          : `Non-retryable error (not retried): ${errorMsg.substring(0, 100)}`,
        "error",
      );
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const binding = getRetrySession(ctx.sessionManager);
    if (!binding || binding.owner !== owner) return;
    binding.lifecycleUnsubscribe?.();
    unregisterRetrySession(ctx.sessionManager, owner);
  });

  pi.on("session_start", (_event, ctx) => {
    const binding = configureSession(ctx);
    if (!binding || binding.owner !== owner) return;
    resetRetryTracker(binding);
    bindLifecycleBridge(binding);
  });

  /**
   * Durably remove a trailing error assistant message from the model context.
   *
   * Prefers the native durable pop (context_edit + projection refresh). On
   * SDKs without it, writes the omission through the session manager directly;
   * if even that fails, falls back to live-state removal only.
   *
   * @param binding Owned session binding.
   * @returns True when a trailing error message was removed.
   */
  function popErrorMessage(binding: RetrySessionBinding): boolean {
    const agent = binding.agent;
    const messages = agent.state.messages;
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant" || last.stopReason !== "error") return false;
    const session = binding.session as AgentSessionLike;
    if (typeof session._omitRecoveryAttempt === "function") {
      try {
        session._omitRecoveryAttempt(last);
        return true;
      } catch {
        // Projection lookup failed — fall through to the lighter paths.
      }
    }
    const manager = binding.sessionManager as {
      getEntries?: () => unknown[];
      appendContextEdit?: (entryId: string, replacement: unknown) => string;
    };
    const entryId = findMessageEntryId(manager, last);
    if (entryId && typeof manager.appendContextEdit === "function") {
      manager.appendContextEdit(entryId, null);
      if (typeof session._refreshFinalizedContext === "function") {
        session._refreshFinalizedContext();
        return true;
      }
    }
    agent.state.messages = messages.slice(0, -1);
    return true;
  }

  /**
   * Find the session entry id persisting one agent message, if any.
   *
   * @param manager Session manager exposing entries.
   * @param message Agent message to locate.
   * @returns Entry id, or undefined when unavailable.
   */
  function findMessageEntryId(
    manager: { getEntries?: () => unknown[] } | undefined,
    message: unknown,
  ): string | undefined {
    const entries = typeof manager?.getEntries === "function" ? manager.getEntries() : [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i] as { type?: string; id?: string; message?: unknown };
      if (entry.type === "message" && entry.message === message && entry.id) {
        return entry.id;
      }
    }
    return undefined;
  }

  /**
   * Continue the agent with identical (already-clean) context.
   *
   * The _isAgentRunActive guard keeps session.isStreaming true so concurrent
   * user input queues as steer/followUp instead of hitting the synthetic-error
   * prompt path. Commands run while idle, so agent.continue() cannot race an
   * active run.
   *
   * @param binding Owned session binding.
   * @param ctx Command context used for notifications.
   */
  async function guardedContinue(binding: RetrySessionBinding, ctx: ExtensionContext): Promise<void> {
    const session = binding.session as AgentSessionLike;
    try {
      session._isAgentRunActive = true;
      try {
        await binding.agent.continue();
      } finally {
        session._isAgentRunActive = false;
      }
    } catch (error) {
      ctx.ui.notify(
        `Continue failed: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  }

  const retryCommandHandler = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const binding = getRetrySession(ctx.sessionManager);
    if (!binding || binding.owner !== owner) {
      ctx.ui.notify("pi-retry is not managing this session.", "warning");
      return;
    }
    const subcommand = args?.trim().split(/\s+/)[0]?.toLowerCase();

    // /retry status — diagnostics
    if (subcommand === "status") {
      const entries = ctx.sessionManager.getEntries();
      const lastAssistant = getLastAssistantMessage(entries);
      const session = binding.session as AgentSessionLike;
      const nativeAttempt = typeof session._retryAttempt === "number" ? session._retryAttempt : 0;

      const describe = (label: string, key: string, state: RetryState): string => {
        return (
          `${label}:\n` +
          `  Attempts: ${state.getAttempt()}\n` +
          `  Retrying: ${state.getIsRetrying()}\n` +
          `  Last error: ${state.getLastErrorMessage().substring(0, 100) || "None"}\n` +
          `  At-cap failures: ${binding.retry.failuresAtCap[key] ?? 0}/${binding.config.maxRetriesAtMaxDelay}\n\n`
        );
      };

      let status = "=== Retry Status ===\n\n";
      status += describe("400/413 Errors", "400-413", binding.retry.states["400-413"]);
      status += describe("Credit Errors", "credit", binding.retry.states.credit);
      status += describe("Connection Errors", "connection", binding.retry.states.connection);
      status += describe("Other Errors (catch-all)", "other", binding.retry.states.other);
      status += "Configuration:\n";
      status += `  Base delay: ${binding.config.baseDelayMs}ms\n`;
      status += `  Max delay: ${binding.config.maxDelayMs}ms\n`;
      status += `  Backoff multiplier: ${binding.config.multiplier}\n`;
      status += `  Max-delay failures: ${binding.config.maxRetriesAtMaxDelay}\n`;
      status += `  Policy: ${binding.isChild ? "child (subagents)" : "main"} — native seam, no injected messages\n`;
      status += `  Native session retry attempt: ${nativeAttempt}\n\n`;

      if (lastAssistant && isAssistantMessage(lastAssistant)) {
        status += "Last Assistant Message:\n";
        status += `  Stop reason: ${lastAssistant.stopReason}\n`;
        status += `  Error message: ${lastAssistant.errorMessage?.substring(0, 100) || "None"}\n`;
        if (lastAssistant.errorMessage) {
          status += `  Error category: ${getErrorCategory(lastAssistant.errorMessage)}`;
        }
      }

      ctx.ui.notify(status, "info");
      return;
    }

    // /retry reset — clear pi-retry counters (native owns its own counter)
    if (subcommand === "reset") {
      resetRetryTracker(binding);
      ctx.ui.notify("All retry counters reset", "info");
      return;
    }

    // /retry (or /continue) — merged manual continue. Explicit intent:
    // bypasses pi-retry's classifier and veto entirely.
    const messages = binding.agent.state.messages;
    const last = messages[messages.length - 1];

    if (!last) {
      ctx.ui.notify("Nothing to continue — the session has no messages.", "warning");
      return;
    }

    if (last.role === "assistant") {
      if (last.stopReason !== "error") {
        ctx.ui.notify(
          "Cannot continue from an assistant message — rewind to a user/tool boundary or type a message. For context overflow use /compact.",
          "warning",
        );
        return;
      }
      if (!popErrorMessage(binding)) {
        ctx.ui.notify("No error message found to remove.", "warning");
        return;
      }
    }

    await guardedContinue(binding, ctx);
  };

  // Unified /retry command with subcommands; "continue" is an alias.
  pi.registerCommand("retry", {
    description:
      "Retry controls: /retry (manual message-free continue), /retry status (diagnostics), /retry reset (clear state)",
    handler: retryCommandHandler,
  });
  pi.registerCommand("continue", {
    description: "Alias for /retry — continue from the last user/tool boundary",
    handler: retryCommandHandler,
  });
}
