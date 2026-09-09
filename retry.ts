import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import type { Agent } from "@earendil-works/pi-agent-core";
import {
  has400or413Error,
  hasCreditError,
  hasConnectionError,
  hasRetryableError,
  isNonRetryableError,
  isSilencedError,
  hasQuotaExhaustedError,
  hasMaxTokensStop,
  hasEmptyStop,
  isContextOverflowError,
  isAssistantMessage,
  getLastAssistantMessage,
  calculateDelay,
  DEFAULT_RETRY_CONFIG,
  loadPiRetrySettings,
  formatDuration,
  getErrorCategory,
  RetryState,
  ContinuationState,
  RETRY_TRIGGER_CUSTOM_TYPE,
  CONTINUATION_CUSTOM_TYPE,
} from "./src/index.js";
import { ChildRetryController } from "./src/child-retry.js";
import {
  getRetrySession,
  getSessionAgent,
  installRetrySdkHooks,
  registerRetrySession,
  unregisterRetrySession,
} from "./src/session-registry.js";

const RETRY_STARTED_EVENT = "pi-retry:started";
const RETRY_COMPLETED_EVENT = "pi-retry:completed";
const RETRY_CANCELLED_EVENT = "pi-retry:cancelled";

// The registry only patches the supported SDK seam. Unsupported shapes leave
// native retry untouched and disable extension takeover rather than stranding a
// child prompt in an out-of-band loop.
const sdkHooksSupported = installRetrySdkHooks();

/**
 * Unified retry extension — retries EVERY error by default.
 *
 * Philosophy: any assistant message with stopReason === "error" is retried
 * with exponential backoff capped by settings, then stops after the configured
 * number of failures at the maximum delay, except a small blacklist of known
 * permanent failures and hard-stop conditions (invalid API key, model not
 * found, quota/session-limit/budget exhaustion, suspended accounts, etc.).
 *
 * Specific categories (400/413, credit, connection, stream exhaustion, etc.)
 * are tracked for diagnostics but all share the same retry mechanism.
 *
 * Features:
 * - Automatic detection and retry for ALL errors (catch-all)
 * - Retry with exponential backoff and a configurable cap/failure limit
 * - Auto-continuation when model hits max output tokens (stopReason "length")
 * - Retry triggers are hidden in the TUI and serialized as provider-valid user turns
 * - Unified manual controls via /retry command
 *
 * Continuation mechanism:
 *   - A hidden custom message starts or joins a canonical AgentSession turn
 *   - The message remains in context as a provider-valid user turn
 *   - AgentSession remains authoritative for busy state and queued messages
 *
 * Retry loop design:
 *   - The agent_end handler detects retryable errors but does NOT sleep.
 *     It fires triggerInvisibleContinue() immediately, keeping processEvents
 *     unblocked so the agent can finish its run and become idle.
 *   - triggerInvisibleContinue() owns the retry loop: it waits for idle,
 *     removes error assistant messages from live state, queues a hidden
 *     AgentSession turn, and checks the result. On error it sleeps outside
 *     processEvents and retries. On success or user abort the loop exits.
 */

// The remaining module state is used only by the currently bound ordinary
// session. Child sessions use ChildRetryController instances registered by
// their own session manager, so child activity cannot reset or drive this state.

// Per-category retry state (for diagnostics / messaging).
const state400 = new RetryState();
const stateCredit = new RetryState();
const stateConnection = new RetryState();
const stateOther = new RetryState();

// Max_tokens continuation state (indefinite - no cap needed).
const stateContinuation = new ContinuationState();

// Empty/think-only stop continuation state is bounded by design.
const stateEmptyStop = new ContinuationState();
const MAX_EMPTY_CONTINUATIONS = 1;

// Abort flag for the ordinary session's detached retry loop.
let _userAborted = false;

// Mutex for the ordinary session's detached continuation loop.
let _continueInProgress = false;
let _continueGeneration: number | null = null;
let _continueInputGeneration: number | null = null;
let _inputGeneration = 0;
let _retryLifecycleId = 0;

// Generation counter for ordinary session replacement.
let _sessionGeneration = 0;

let _terminalInputUnsubscribe: (() => void) | null = null;

// Interruptible sleep: polls _userAborted and _sessionGeneration every
// 100ms.  Returns true if interrupted (abort or session change), false if
// the full delay elapsed normally.
function interruptibleSleep(
  ms: number,
  generation: number,
  inputGeneration: number,
): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(false);
  return new Promise(resolve => {
    const checkInterval = 100;
    let elapsed = 0;
    const timer = setInterval(() => {
      elapsed += checkInterval;
      if (
        _userAborted ||
        _sessionGeneration !== generation ||
        _inputGeneration !== inputGeneration
      ) {
        clearInterval(timer);
        resolve(true);
      } else if (elapsed >= ms) {
        clearInterval(timer);
        resolve(false);
      }
    }, checkInterval);
  });
}

// Remove the error assistant message at the end of agent state, if present.
// Same technique used by the built-in retry in _prepareRetry — the error
// message stays in the session journal for history but is removed from the
// agent's live transcript so the LLM receives a clean context on retry.
function removeErrorFromAgentState(agent: Agent): void {
  const messages = agent.state.messages;
  const lastMsg = messages[messages.length - 1];
  if (lastMsg?.role === 'assistant' && lastMsg.stopReason === 'error') {
    agent.state.messages = messages.slice(0, -1);
  }
}

type HiddenTurnKind = "retry" | "continue" | "empty";

function getHiddenTurnKind(agent: Agent): HiddenTurnKind | null {
  const messages = agent.state.messages;
  const lastMsg = messages[messages.length - 1];
  if (lastMsg?.role !== "assistant") return null;
  if (lastMsg.stopReason === "error") return "retry";
  if (lastMsg.stopReason === "length") return "continue";
  if (hasEmptyStop(lastMsg)) return "empty";
  return null;
}

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
  let _notifyFn: ((message: string, level: "info" | "warning" | "error") => void) | null = null;
  let retryConfig = { ...DEFAULT_RETRY_CONFIG };
  const owner = pi as unknown as object;

  /**
   * Return the child controller only when this factory owns the exact session.
   *
   * @param sessionManager Session manager supplied by the SDK context.
   * @returns Child controller state, or undefined for main/disabled sessions.
   */
  function childControllerFor(sessionManager: unknown): ChildRetryController | undefined {
    const binding = getRetrySession(sessionManager);
    if (!binding || binding.owner !== owner || !binding.isChild || !binding.childRetryEnabled) {
      return undefined;
    }
    const state = binding.sessionState;
    if (
      state &&
      typeof (state as ChildRetryController).handleAgentEnd === "function" &&
      typeof (state as ChildRetryController).close === "function"
    ) {
      return state as ChildRetryController;
    }
    return undefined;
  }

  /**
   * Update one session's child classification and install its controller.
   *
   * @param ctx SDK context used for cwd, identity, and system prompt lookup.
   * @param systemPrompt Optional event-local effective system prompt.
   * @returns The owned binding, or undefined when SDK identity is unavailable.
   */
  function configureSession(
    ctx: { cwd?: string; sessionManager?: unknown; getSystemPrompt?: () => string },
    systemPrompt?: string,
  ) {
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
    // an ordinary prompt only enters the inline path when a rule matches it.
    const child = matchesConfiguredSystemPrompt(
      systemPrompt ?? readEffectiveSystemPrompt(ctx),
      settings.subagents.match.systemPromptRegex,
    );
    const registered = registerRetrySession(sessionManager, owner, {
      isChild: child,
      suppressNativeRetry: !child || settings.subagents.enabled,
      childRetryEnabled: child && settings.subagents.enabled,
    });
    if (!registered || !registered.owned) return registered?.binding;

    const binding = registered.binding;
    if (child && settings.subagents.enabled) {
      const existing = childControllerFor(sessionManager);
      if (!existing) {
        binding.sessionState = new ChildRetryController(pi, binding.agent, settings.subagents);
      }
    } else if (binding.sessionState && typeof (binding.sessionState as ChildRetryController).close === "function") {
      (binding.sessionState as ChildRetryController).close();
      binding.sessionState = undefined;
    }
    if (!child) retryConfig = settings.main;
    return binding;
  }

  // Unsupported SDK versions retain native retry and do not enter the
  // extension's detached/inline scheduling paths.
  if (!sdkHooksSupported) return;


  /**
   * Start the ordinary detached loop with the exact Agent mapped to context.
   *
   * @param kind Hidden turn kind selected by the event or command.
   * @param ctx Session context whose manager identifies the Agent.
   */
  function triggerForContext(
    kind: HiddenTurnKind,
    ctx: { sessionManager?: unknown },
  ): void {
    const agent = getSessionAgent(ctx.sessionManager);
    if (!agent) return;
    void triggerInvisibleContinue(kind, agent);
  }

  pi.on("before_agent_start", (event, ctx) => {
    configureSession(ctx, event.systemPrompt);
  });

  pi.on("input", (_event, ctx) => {
    const binding = getRetrySession(ctx.sessionManager);
    if (binding && binding.owner !== owner) return;
    if (binding?.isChild) {
      const controller = childControllerFor(ctx.sessionManager);
      controller?.handleInput();
      return;
    }
    _inputGeneration++;
    // The generation change cancels any older loop; the new user request gets
    // its own retry eligibility even if the previous request was aborted.
    _userAborted = false;
  });

  // Reset retry counters on successful completion (not max_tokens, not error)
  pi.on("turn_end", async (event, ctx) => {
    const binding = getRetrySession(ctx.sessionManager);
    if (binding && binding.owner !== owner) return;
    if (binding?.isChild) {
      childControllerFor(ctx.sessionManager)?.handleTurnEnd(event, ctx);
      return;
    }
    const msg = event.message as any;
    if (
      ctx.signal?.aborted ||
      (msg.role === "assistant" && msg.stopReason === "aborted")
    ) {
      // User cancelled — reset retry state so it doesn't leak into other
      // branches of the session tree. The signal check matters for tool calls:
      // some tools/providers finish with an error-shaped result after abort.
      state400.reset();
      stateCredit.reset();
      stateConnection.reset();
      stateOther.reset();
      stateContinuation.endContinuation();
      stateEmptyStop.endContinuation();
      // Signal to any in-flight triggerInvisibleContinue or pending retry
      // that the user has cancelled — do not queue another retry turn.
      _userAborted = true;
      return;
    }
    if (msg.role === "assistant" && msg.stopReason !== "error") {
      if (msg.stopReason !== "length") {
        // Normal completion — reset everything including continuation count
        state400.succeed();
        stateCredit.succeed();
        stateConnection.succeed();
        stateOther.succeed();
        stateContinuation.complete();
        stateEmptyStop.complete();
        // Clear abort flag — this is a fresh successful turn, so any
        // previous abort is stale and shouldn't block future retries.
        _userAborted = false;
      }
    }
  });

  // Handle errors and max_tokens on agent_end.
  //
  // IMPORTANT: this handler must return quickly and NOT await sleep().
  // The handler is invoked inside processEvents(), which blocks finishRun()
  // until all listeners settle. A sleep here freezes the entire agent —
  // no UI updates, no abort handling, no event processing.
  //
  // Instead, the handler detects errors and kicks off
  // triggerInvisibleContinue(), which owns the retry loop with backoff
  // sleeps that happen AFTER processEvents returns (outside the agent run).
  pi.on("agent_end", async (event, ctx) => {
    const binding = getRetrySession(ctx.sessionManager);
    if (binding && binding.owner !== owner) return;
    if (binding?.isChild) {
      await childControllerFor(ctx.sessionManager)?.handleAgentEnd(ctx);
      return;
    }

    // Prefer Pi's run signal over provider-specific stop-reason mapping. An
    // Escape during a Fabric/core tool may settle as an error-shaped result,
    // but it is still a user cancellation and must never schedule a retry.
    if (ctx.signal?.aborted) {
      _userAborted = true;
      return;
    }

    const entries = ctx.sessionManager.getEntries();
    const lastAssistant = getLastAssistantMessage(entries);

    if (!lastAssistant || !isAssistantMessage(lastAssistant)) {
      return;
    }

    // Guard: if the user aborted, do not queue another retry turn.
    if (_userAborted) return;

    // If the retry loop is already driving, don't interfere — it will
    // see the new error on its next loop iteration.
    if (
      _continueInProgress &&
      _continueInputGeneration === _inputGeneration
    ) return;

    // Check for max_tokens stop — auto-continue with a hidden TUI message
    if (hasMaxTokensStop(lastAssistant) && !stateContinuation.getIsContinuing()) {
      stateContinuation.startContinuation();
      ctx.ui.notify(
        `Max tokens reached — auto-continuing (continuation ${stateContinuation.getCount()})...`,
        "info",
      );
      triggerForContext("continue", ctx);
      stateContinuation.endContinuation();
      return;
    }

    // Empty / think-only stop - the model ended its turn with NO usable
    // output (zero text blocks, zero tool calls; only thinking or nothing).
    // Anthropic documents these as "empty responses with end_turn" - the
    // model decided the turn is complete. Not an error, but also not a
    // usable turn: without this, the agent just goes silent.
    //
    // Remedy (per Anthropic docs and CLIProxyAPI 4886 measurements): one
    // continuation prompt in a NEW user message. Bounded on purpose - a
    // model that returns empty once tends to be done; see
    // MAX_EMPTY_CONTINUATIONS below.
    if (hasEmptyStop(lastAssistant) && !stateEmptyStop.getIsContinuing()) {
      stateEmptyStop.startContinuation();
      ctx.ui.notify(
        `Empty response - nudging once to produce output (continuation ${stateEmptyStop.getCount()})...`,
        "info",
      );
      triggerForContext("empty", ctx);
      stateEmptyStop.endContinuation();
      return;
    }

    // Context overflow: defer to compaction. Do NOT retry here.
    //
    // Retrying the same oversized context before compaction would produce an
    // uncapped overflow loop. Leave _continueInProgress false so Pi can run
    // its normal compaction and retry path with the reduced context.
    if (isContextOverflowError(lastAssistant)) {
      ctx.ui.notify(
        "Context overflow — deferring to compaction (auto-retry after compact).",
        "info",
      );
      return;
    }

    // Catch-all: retry ANY error except known permanent failures
    if (hasRetryableError(lastAssistant)) {
      const errorMsg = lastAssistant.errorMessage || "Unknown error";
      const category = getErrorCategory(errorMsg);

      // Pick the right state tracker for diagnostics
      let state: RetryState;
      let label: string;
      if (category === "400-413") {
        state = state400;
        label = "400/413";
      } else if (category === "credit") {
        state = stateCredit;
        label = "Credit";
      } else if (category === "connection") {
        state = stateConnection;
        label = "Connection";
      } else {
        state = stateOther;
        label = category === "builtin" ? "Server" : "Other";
      }

      if (state.getIsRetrying()) return;

      // Record the error for diagnostics but do NOT sleep here.
      // The retry loop in triggerInvisibleContinue handles backoff.
      state.startRetry(errorMsg);
      state.endRetry();

      triggerForContext("retry", ctx);
      return;
    }

    // Log non-retryable errors so the user knows why we didn't retry
    // (silenced errors are neither retried nor shown)
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



  // Unified /retry command with subcommands
  pi.registerCommand("retry", {
    description: "Unified retry controls: /retry (manual trigger), /retry status (diagnostics), /retry reset (clear state)",
    handler: async (args, ctx) => {
      const binding = getRetrySession(ctx.sessionManager);
      if (binding && binding.owner !== owner) return;
      if (binding?.isChild) {
        const controller = childControllerFor(ctx.sessionManager);
        if (!controller) {
          ctx.ui.notify("Child-session retry takeover is disabled.", "info");
          return;
        }
        const childSubcommand = args[0]?.toLowerCase();
        if (childSubcommand === "status") {
          ctx.ui.notify(
            `Child retry status:\n${JSON.stringify(controller.status(), null, 2)}`,
            "info",
          );
          return;
        }
        if (childSubcommand === "reset") {
          controller.reset();
          ctx.ui.notify("Child retry counters reset", "info");
          return;
        }
        await controller.handleAgentEnd(ctx);
        return;
      }
      const subcommand = args[0]?.toLowerCase();

      // /retry status - Show diagnostics
      if (subcommand === "status") {
        const entries = ctx.sessionManager.getEntries();
        const lastAssistant = getLastAssistantMessage(entries);

        let status = "=== Retry Status ===\n\n";

        // 400/413 state
        status += "400/413 Errors:\n";
        status += `  Current attempt: ${state400.getAttempt()}\n`;
        status += `  Is retrying: ${state400.getIsRetrying()}\n`;
        status += `  Last error: ${state400.getLastErrorMessage().substring(0, 100) || "None"}\n\n`;

        // Credit state
        status += "Credit Errors:\n";
        status += `  Current attempt: ${stateCredit.getAttempt()}\n`;
        status += `  Is retrying: ${stateCredit.getIsRetrying()}\n`;
        status += `  Last error: ${stateCredit.getLastErrorMessage().substring(0, 100) || "None"}\n\n`;

        // Connection state
        status += "Connection Errors:\n";
        status += `  Current attempt: ${stateConnection.getAttempt()}\n`;
        status += `  Is retrying: ${stateConnection.getIsRetrying()}\n`;
        status += `  Last error: ${stateConnection.getLastErrorMessage().substring(0, 100) || "None"}\n\n`;

        // Other / catch-all state
        status += "Other Errors (catch-all):\n";
        status += `  Current attempt: ${stateOther.getAttempt()}\n`;
        status += `  Is retrying: ${stateOther.getIsRetrying()}\n`;
        status += `  Last error: ${stateOther.getLastErrorMessage().substring(0, 100) || "None"}\n\n`;

        // Continuation state
        status += "Max Tokens Continuation:\n";
        status += `  Continuations used: ${stateContinuation.getCount()}\n`;
        status += `  Is continuing: ${stateContinuation.getIsContinuing()}\n`;
        status += `  Trigger: hidden provider-valid AgentSession turn\n\n`;

        // Empty-stop continuation state
        status += "Empty/Think-only Stop Continuation:\n";
        status += `  Continuations used: ${stateEmptyStop.getCount()}\n`;
        status += `  Is continuing: ${stateEmptyStop.getIsContinuing()}\n`;
        status += `  Cap: ${MAX_EMPTY_CONTINUATIONS} nudge(s), then give up\n\n`;

        // Config
        status += "Configuration:\n";
        status += `  Base delay: ${retryConfig.baseDelayMs}ms\n`;
        status += `  Max delay: ${retryConfig.maxDelayMs}ms\n`;
        status += `  Backoff multiplier: ${retryConfig.multiplier}\n`;
        status += `  Max-delay failures: ${retryConfig.maxRetriesAtMaxDelay}\n`;
        status += "  Retry loop: until success, abort, or the max-delay failure limit\n\n";

        // Last assistant info
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

      // /retry reset - Reset all state
      if (subcommand === "reset") {
        state400.reset();
        stateCredit.reset();
        stateConnection.reset();
        stateOther.reset();
        stateContinuation.reset();
        stateEmptyStop.reset();
        _userAborted = false;
        ctx.ui.notify("All retry counters reset", "info");
        return;
      }

      // /retry (no args) - Manual trigger with auto-detection
      const entries = ctx.sessionManager.getEntries();
      const lastAssistant = getLastAssistantMessage(entries);

      if (!lastAssistant || !isAssistantMessage(lastAssistant)) {
        ctx.ui.notify("No assistant message found to retry", "warning");
        return;
      }

      // Manual /retry overrides any previous abort — the user is
      // explicitly requesting a retry, so clear the abort flag.
      _userAborted = false;

      // Auto-detect: max_tokens continuation takes priority
      if (hasMaxTokensStop(lastAssistant)) {
        ctx.ui.notify("Manually continuing after max_tokens...", "info");
        triggerForContext("continue", ctx);
        return;
      }

      // Empty / think-only stop — nudge once
      if (hasEmptyStop(lastAssistant)) {
        ctx.ui.notify("Empty response — nudging once...", "info");
        triggerForContext("empty", ctx);
        return;
      }

      // Context overflow: don't retry in place — reducing context is required.
      // Compaction (pi-vcc / /compact) handles it and auto-retries. Retrying
      // without compaction loops forever on a genuinely oversized payload.
      if (isContextOverflowError(lastAssistant)) {
        ctx.ui.notify(
          "Context overflow — use /compact (or /pi-vcc) to reduce context. Compaction auto-retries.",
          "info",
        );
        return;
      }

      // Non-retryable errors (permanent failures + quota/budget
      // exhaustion): report clearly instead of the generic fallback.
      if (isNonRetryableError(lastAssistant)) {
        const errorMsg = lastAssistant.errorMessage || "Unknown error";
        ctx.ui.notify(
          hasQuotaExhaustedError(lastAssistant)
            ? `Quota/limit exhausted — resolve the plan/billing issue or wait for the reset window first: ${errorMsg.substring(0, 100)}`
            : `Non-retryable error (fix the underlying issue first, then /retry): ${errorMsg.substring(0, 100)}`,
          "warning",
        );
        return;
      }

      // Auto-detect error type and trigger appropriate retry
      if (has400or413Error(lastAssistant)) {
        ctx.ui.notify("Manually retrying 400/413 error...", "info");
        state400.reset();
        triggerForContext("retry", ctx);
        return;
      }

      if (hasCreditError(lastAssistant)) {
        ctx.ui.notify("Manually retrying credit error...", "info");
        stateCredit.reset();
        triggerForContext("retry", ctx);
        return;
      }

      if (hasConnectionError(lastAssistant)) {
        ctx.ui.notify("Manually retrying connection error...", "info");
        stateConnection.reset();
        triggerForContext("retry", ctx);
        return;
      }

      // Catch-all: any other retryable error
      if (hasRetryableError(lastAssistant)) {
        ctx.ui.notify("Manually retrying error...", "info");
        stateOther.reset();
        triggerForContext("retry", ctx);
        return;
      }

      // No error detected - show status instead
      ctx.ui.notify("No retryable error detected. Use '/retry status' for diagnostics.", "warning");
    }
  });

  // Handle session replacement before Pi invalidates this extension runtime.
  // A retry loop may still be awaiting a timer or AgentSession turn when the
  // old session shuts down, so release its ownership and invalidate its
  // generation before the captured pi object becomes stale.
  pi.on("session_shutdown", (_event, ctx) => {
    const binding = getRetrySession(ctx.sessionManager);
    if (binding && binding.owner !== owner) return;
    if (binding?.isChild) {
      childControllerFor(ctx.sessionManager)?.close();
      unregisterRetrySession(ctx.sessionManager, owner);
      return;
    }
    if (binding) unregisterRetrySession(ctx.sessionManager, owner);

    _sessionGeneration++;
    _userAborted = true;
    _continueInProgress = false;
    _continueGeneration = null;
    _continueInputGeneration = null;
    _notifyFn = null;
    _terminalInputUnsubscribe?.();
    _terminalInputUnsubscribe = null;
  });

  // Initialize
  pi.on("session_start", async (_event, ctx) => {
    const binding = configureSession(ctx);
    if (binding && binding.owner !== owner) return;
    if (binding?.isChild) return;

    // Bump the generation counter so any in-flight retry loop from a
    // previous session exits on its next checkpoint (within 100ms during
    // backoff sleep, or immediately after a hidden retry turn settles).
    _sessionGeneration++;

    state400.reset();
    stateCredit.reset();
    stateConnection.reset();
    stateOther.reset();
    stateContinuation.reset();
    stateEmptyStop.reset();
    // Do NOT reset _continueInProgress here — the in-flight loop's
    // finally block releases its owner token. Resetting it here could allow
    // a second loop to start before the old one has settled.
    _userAborted = false;
    _notifyFn = null;

    _terminalInputUnsubscribe?.();
    _terminalInputUnsubscribe = null;

    if (ctx.mode === "tui") {
      _terminalInputUnsubscribe = ctx.ui.onTerminalInput(data => {
        if (
          !matchesKey(data, "escape") ||
          !_continueInProgress ||
          _continueGeneration !== _sessionGeneration
        ) {
          return undefined;
        }

        // Cancel pi-retry's out-of-band loop, but let Pi's native interrupt
        // handler receive the same key. Pi owns the active turn and queue: its
        // handler aborts the current tool/model call and clears any queued
        // steer/follow-up messages. Consuming Escape here bypasses that cleanup
        // and can let AgentSession continue after the user asked it to stop.
        _userAborted = true;
        return undefined;
      });
    }
  });

  // Retry loop driver — the core of pi-retry.
  //
  // Unlike the original one-shot design, this function loops. After each
  // hidden AgentSession turn it checks the result:
  //   - Success: loop exits when the stop reason is neither error nor length.
  //   - Error: sleep with backoff, then retry the request.
  //   - Length: sleep with backoff, then continue the response.
  //   - User abort: loop exits immediately.
  //
  // The backoff sleep happens AFTER the hidden turn settles and processEvents
  // has settled, so it does NOT block the agent. The agent is idle during
  // the sleep and can respond to user input (e.g. Escape to abort).
  //
  // Before each retry, the error assistant message is removed from
  // agent.state.messages so the LLM receives a clean context (same
  // technique as the built-in retry's _prepareRetry).
  async function triggerInvisibleContinue(initialKind: HiddenTurnKind, myAgent: Agent) {
    // Keep the Agent that started this loop. Session replacement is handled by
    // the ordinary generation and exact session-manager ownership checks.
    if (!myAgent) return;

    // Guard: if the user aborted, do not queue another retry turn.
    if (_userAborted) return;

    // Guard: mutex — if a previous continue is still in-flight, skip
    if (_continueInProgress) return;
    _continueInProgress = true;
    const retryLifecycleId = ++_retryLifecycleId;
    let didRetryComplete = false;

    // Capture the current session generation. If /new fires while we're
    // looping, _sessionGeneration will increment and the loop will exit.
    const myGeneration = _sessionGeneration;
    const myInputGeneration = _inputGeneration;
    _continueGeneration = myGeneration;
    _continueInputGeneration = myInputGeneration;

    try {
      emitRetryLifecycleEvent(RETRY_STARTED_EVENT, retryLifecycleId);

      // Wait for the current run to finish (activeRun resolves in
      // finishRun() after agent_end listeners return).
      await myAgent.waitForIdle();

      // AgentSession clears its outer lifecycle immediately after Agent's
      // active run resolves. Yield to the next macrotask so the detached path
      // sends after that wrapper settles instead of queueing a follow-up and
      // re-reading the same error before the host can drain it.
      await new Promise<void>(resolve => setImmediate(resolve));

      // Re-check after waitForIdle: the user may have aborted or the
      // session may have changed while we were waiting.
      if (
        _userAborted ||
        _sessionGeneration !== myGeneration ||
        _inputGeneration !== myInputGeneration
      ) return;

      let attempt = 0;
      let hiddenTurnKind: HiddenTurnKind | null = initialKind;
      // Empty-stop nudges are bounded: a model that produced no usable output
      // and answers the nudge with another empty turn is decided, not stalled.
      // Stop after MAX_EMPTY_CONTINUATIONS rather than looping forever.
      let emptyNudges = 0;
      // Only ordinary retries count toward the maximum-delay cutoff; token
      // continuations intentionally remain uncapped.
      let maxDelayRetries = 0;

      // Loop until success, abort, or session change.
      while (true) {
        if (
          _userAborted ||
          _sessionGeneration !== myGeneration ||
          _inputGeneration !== myInputGeneration
        ) return;

        // Preserve the trigger kind before removing a trailing error from
        // live state. Length-stopped output stays in context so the model can
        // continue from it; error messages remain only in the session journal.
        if (!hiddenTurnKind) {
          didRetryComplete = true;
          return;
        }
        removeErrorFromAgentState(myAgent);

        // Empty-stop cap: a model that produced no usable output and answers
        // the nudge with another empty turn is decided, not stalled. Stop
        // after MAX_EMPTY_CONTINUATIONS rather than looping forever.
        if (hiddenTurnKind === "empty") {
          if (emptyNudges >= MAX_EMPTY_CONTINUATIONS) {
            notifySafely(
              `Empty response after ${emptyNudges} continuation(s) - giving up (model keeps ending the turn with no output).`,
              "warning",
            );
            return;
          }
          emptyNudges++;
        }

        attempt++;
        const delay = calculateDelay(attempt, retryConfig);
        const isMaxDelay = delay >= retryConfig.maxDelayMs;
        if (hiddenTurnKind === "retry" && isMaxDelay) {
          maxDelayRetries++;
        }

        // Notify the user about the upcoming retry attempt.
        _notifyRetryAttempt(attempt, delay);

        // Interruptible sleep with backoff BEFORE the retry attempt.
        // Polls _userAborted and _sessionGeneration every 100ms so ESC
        // and /new take effect within 100ms instead of waiting for the
        // full backoff (up to the configured maximum delay).
        const interrupted = await interruptibleSleep(
          delay,
          myGeneration,
          myInputGeneration,
        );
        if (interrupted || _inputGeneration !== myInputGeneration) return;

        try {
          pi.sendMessage(
            {
              customType: hiddenTurnKind === "retry"
                ? RETRY_TRIGGER_CUSTOM_TYPE
                : CONTINUATION_CUSTOM_TYPE,
              content: hiddenTurnKind === "retry"
                ? "Retry the previous request."
                : hiddenTurnKind === "empty"
                  ? "Your previous turn contained only thinking and no answer or text. Continue now and produce the actual response, using tools if needed."
                  : "Continue exactly where you left off without repeating content.",
              display: false,
              details: undefined,
            },
            { triggerTurn: true, deliverAs: "followUp" },
          );

          // sendMessage is fire-and-forget, but AgentSession publishes the
          // low-level run synchronously before returning. Waiting on Agent
          // keeps this retry loop intact without bypassing session state.
          await Promise.resolve();
          await myAgent.waitForIdle();
        } catch {
          return;
        }

        // Re-check after prompt: the user may have hit ESC during the
        // prompt, or /new may have fired — don't keep retrying.
        if (
          _userAborted ||
          _sessionGeneration !== myGeneration ||
          _inputGeneration !== myInputGeneration
        ) return;

        // The hidden AgentSession turn completed. Both errors and output
        // length stops need another turn; all other terminal states are done.
        hiddenTurnKind = getHiddenTurnKind(myAgent);
        if (!hiddenTurnKind) {
          didRetryComplete = true;
          return;
        }

        // Stop ordinary retries after the configured number of failures at
        // the cap. The failed capped turns have already been delivered; this
        // check prevents scheduling one more capped request.
        if (
          hiddenTurnKind === "retry" &&
          maxDelayRetries >= retryConfig.maxRetriesAtMaxDelay
        ) {
          notifySafely(
            `Retry failed ${retryConfig.maxRetriesAtMaxDelay} times at the maximum backoff (${formatDuration(retryConfig.maxDelayMs)}); giving up.`,
            "warning",
          );
          return;
        }
      }
    } finally {
      // Release the mutex only if this loop still owns it. If the session was
      // replaced, session_shutdown clears ownership and suppresses the event
      // because the captured pi.events bus is stale by this point.
      if (_continueGeneration === myGeneration) {
        const sessionIsCurrent = _sessionGeneration === myGeneration;
        _continueInProgress = false;
        _continueGeneration = null;
        _continueInputGeneration = null;
        if (sessionIsCurrent) {
          emitRetryLifecycleEvent(
            didRetryComplete ? RETRY_COMPLETED_EVENT : RETRY_CANCELLED_EVENT,
            retryLifecycleId,
          );
        }
      }
    }
  }

  // Notify the user about a retry attempt via the extension API.
  // ctx.ui.notify is only available inside event handlers, not inside
  // triggerInvisibleContinue. We capture a fresh reference from the
  // most recent handler invocation so it's always current.

  function isStaleContextError(error: unknown): boolean {
    return error instanceof Error && error.message.includes("This extension ctx is stale");
  }

  function emitRetryLifecycleEvent(event: string, retryId: number): void {
    try {
      pi.events.emit(event, { retryId });
    } catch (error) {
      // Session replacement invalidates the old event bus while a retry loop
      // can still be unwinding. There is no live listener to notify then.
      if (!isStaleContextError(error)) throw error;
    }
  }

  function notifySafely(message: string, level: "info" | "warning" | "error"): void {
    if (!_notifyFn) return;
    try {
      _notifyFn(message, level);
    } catch (error) {
      // The notification closure can outlive the session that supplied its ctx.
      if (isStaleContextError(error)) {
        _notifyFn = null;
        return;
      }
      throw error;
    }
  }

  // Refresh on every handler that carries a ctx — stale references
  // break after session switches (the old ctx becomes invalid).
  pi.on("agent_end", async (_event, ctx) => {
    _notifyFn = (message, level) => ctx.ui.notify(message, level);
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!_notifyFn) {
      _notifyFn = (message, level) => ctx.ui.notify(message, level);
    }
  });

  function _notifyRetryAttempt(attempt: number, delayMs: number) {
    const duration = formatDuration(delayMs);
    notifySafely(`Retry attempt ${attempt} (backoff ${duration})...`, "info");
  }
}
