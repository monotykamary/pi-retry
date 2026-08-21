import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { Agent } from "@earendil-works/pi-agent-core";
import { AgentSession } from "@earendil-works/pi-coding-agent";
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
  formatDuration,
  getErrorCategory,
  RetryState,
  ContinuationState,
  RETRY_TRIGGER_CUSTOM_TYPE,
  CONTINUATION_CUSTOM_TYPE,
} from "./src/index.js";

const RETRY_STARTED_EVENT = "pi-retry:started";
const RETRY_COMPLETED_EVENT = "pi-retry:completed";
const RETRY_CANCELLED_EVENT = "pi-retry:cancelled";

/**
 * Unified retry extension — retries EVERY error by default.
 *
 * Philosophy: any assistant message with stopReason === "error" is retried
 * indefinitely with exponential backoff, except a small blacklist of known
 * permanent failures and hard-stop conditions (invalid API key, model not
 * found, quota/session-limit/budget exhaustion, suspended accounts, etc.).
 *
 * Specific categories (400/413, credit, connection, stream exhaustion, etc.)
 * are tracked for diagnostics but all share the same retry mechanism.
 *
 * Features:
 * - Automatic detection and retry for ALL errors (catch-all)
 * - Indefinite retry with exponential backoff (capped at 60s)
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

// Capture the live Agent instance when AgentSession subscribes to it.
// subscribe() is called during AgentSession construction — fires on both
// fresh sessions and session resumes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _agent: Agent | null = null;

const _origSubscribe = Agent.prototype.subscribe as (...args: any[]) => any;
Agent.prototype.subscribe = function (this: Agent, ...args: any[]) {
  _agent = this;
  return _origSubscribe.apply(this, args);
};

// Monkey-patch AgentSession._prepareRetry to suppress the built-in retry
// when pi-retry's loop is driving. Without this, both the built-in retry
// and pi-retry race to handle the same error: the built-in retry counts
// 3 failed attempts and shows "Retry failed after 3 attempts: ...",
// while pi-retry is still looping indefinitely in the background.
//
// When _continueInProgress is true (pi-retry is running), _prepareRetry
// returns false immediately, so _handlePostAgentRun falls through to
// the compaction check and the while loop in _runAgentPrompt exits
// cleanly. No auto_retry_start/end events, no "Retry failed" message.
//
// When _continueInProgress is false (pi-retry is not active), the
// built-in retry works normally as a fallback.
const _origPrepareRetry = (AgentSession.prototype as any)._prepareRetry;
(AgentSession.prototype as any)._prepareRetry = function(this: any, message: any) {
  if (
    _continueInProgress &&
    _continueInputGeneration === _inputGeneration
  ) {
    return Promise.resolve(false);
  }
  return _origPrepareRetry.call(this, message);
};

// Per-category retry state (for diagnostics / messaging)
const state400 = new RetryState();
const stateCredit = new RetryState();
const stateConnection = new RetryState();
const stateOther = new RetryState();

// Max_tokens continuation state (indefinite — no cap needed)
const stateContinuation = new ContinuationState();

// Empty/think-only stop continuation state — BOUNDED by design: the model
// decided to end its turn with no usable output (zero text, zero tool
// calls; Anthropic's documented "empty responses with end_turn"/reasoning
// budget exhaustion). It gets ONE nudge, then we give up rather than
// burning tokens looping on a model that has decided it is done.
const stateEmptyStop = new ContinuationState();
const MAX_EMPTY_CONTINUATIONS = 1;

// Abort flag: set when Pi's active signal is aborted or turn_end reports
// stopReason "aborted", cleared on session_start and fresh user activity.
// Prevents triggerInvisibleContinue() from starting a hidden retry turn after
// the user explicitly cancelled, even if a tool/provider reports an error.
let _userAborted = false;

// Mutex: only one triggerInvisibleContinue may be in-flight at a time.
// Without this, concurrent agent_end events (or a manual /retry during an
// automatic retry) could queue duplicate turns for the same failure.
let _continueInProgress = false;
// Session generation that owns the retry mutex and its Escape handler.
let _continueGeneration: number | null = null;
let _continueInputGeneration: number | null = null;
let _inputGeneration = 0;
let _retryLifecycleId = 0;

// Session generation counter: incremented on every session_start.
// The retry loop captures the current generation when it starts and exits
// when it changes — this handles /new and other session switches.
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
function removeErrorFromAgentState(): void {
  if (!_agent) return;
  const messages = _agent.state.messages;
  const lastMsg = messages[messages.length - 1];
  if (lastMsg?.role === 'assistant' && lastMsg.stopReason === 'error') {
    _agent.state.messages = messages.slice(0, -1);
  }
}

type HiddenTurnKind = "retry" | "continue" | "empty";

function getHiddenTurnKind(): HiddenTurnKind | null {
  if (!_agent) return null;
  const messages = _agent.state.messages;
  const lastMsg = messages[messages.length - 1];
  if (lastMsg?.role !== "assistant") return null;
  if (lastMsg.stopReason === "error") return "retry";
  if (lastMsg.stopReason === "length") return "continue";
  if (hasEmptyStop(lastMsg)) return "empty";
  return null;
}

function lastMessageIsRetryableError(): boolean {
  return getHiddenTurnKind() === "retry";
}

export default function (pi: ExtensionAPI) {

  pi.on("input", () => {
    _inputGeneration++;
    // The generation change cancels any older loop; the new user request gets
    // its own retry eligibility even if the previous request was aborted.
    _userAborted = false;
  });

  // Reset retry counters on successful completion (not max_tokens, not error)
  pi.on("turn_end", async (event, ctx) => {
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
      void triggerInvisibleContinue("continue");
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
      void triggerInvisibleContinue("empty");
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

      void triggerInvisibleContinue("retry");
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
        status += `  Base delay: 2000ms\n`;
        status += `  Max delay: 60000ms\n`;
        status += `  Backoff multiplier: 2\n`;
        status += `  Retry loop: infinite (triggerInvisibleContinue loops until success or abort)\n\n`;

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
        void triggerInvisibleContinue("continue");
        return;
      }

      // Empty / think-only stop — nudge once
      if (hasEmptyStop(lastAssistant)) {
        ctx.ui.notify("Empty response — nudging once...", "info");
        void triggerInvisibleContinue("empty");
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
        void triggerInvisibleContinue("retry");
        return;
      }

      if (hasCreditError(lastAssistant)) {
        ctx.ui.notify("Manually retrying credit error...", "info");
        stateCredit.reset();
        void triggerInvisibleContinue("retry");
        return;
      }

      if (hasConnectionError(lastAssistant)) {
        ctx.ui.notify("Manually retrying connection error...", "info");
        stateConnection.reset();
        void triggerInvisibleContinue("retry");
        return;
      }

      // Catch-all: any other retryable error
      if (hasRetryableError(lastAssistant)) {
        ctx.ui.notify("Manually retrying error...", "info");
        stateOther.reset();
        void triggerInvisibleContinue("retry");
        return;
      }

      // No error detected - show status instead
      ctx.ui.notify("No retryable error detected. Use '/retry status' for diagnostics.", "warning");
    }
  });

  // Initialize
  pi.on("session_start", async (_event, ctx) => {
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
  async function triggerInvisibleContinue(initialKind: HiddenTurnKind) {
    if (!_agent) return;

    // Guard: if the user aborted, do not queue another retry turn.
    if (_userAborted) return;

    // Guard: mutex — if a previous continue is still in-flight, skip
    if (_continueInProgress) return;
    _continueInProgress = true;
    const retryLifecycleId = ++_retryLifecycleId;
    let didRetryComplete = false;
    pi.events.emit(RETRY_STARTED_EVENT, { retryId: retryLifecycleId });

    // Capture the current session generation. If /new fires while we're
    // looping, _sessionGeneration will increment and the loop will exit.
    const myGeneration = _sessionGeneration;
    const myInputGeneration = _inputGeneration;
    _continueGeneration = myGeneration;
    _continueInputGeneration = myInputGeneration;

    try {
      // Wait for the current run to finish (activeRun resolves in
      // finishRun() after agent_end listeners return).
      await _agent.waitForIdle();

      // Re-check after waitForIdle: the user may have aborted or the
      // session may have changed while we were waiting.
      if (
        _userAborted ||
        _sessionGeneration !== myGeneration ||
        _inputGeneration !== myInputGeneration
      ) return;

      let attempt = 0;
      let hiddenTurnKind: HiddenTurnKind | null = initialKind;
      // Empty-stop nudges are bounded: MAX_EMPTY_CONTINUATIONS total
      // continuation requests, then we give up (the model decided it is done).
      let emptyNudges = 0;

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
        removeErrorFromAgentState();

        // Empty-stop cap: a model that produced no usable output and answers
        // the nudge with another empty turn is decided, not stalled. Stop
        // after MAX_EMPTY_CONTINUATIONS rather than looping forever.
        if (hiddenTurnKind === "empty") {
          if (emptyNudges >= MAX_EMPTY_CONTINUATIONS) {
            _notifyFn?.(
              `Empty response after ${emptyNudges} continuation(s) - giving up (model keeps ending the turn with no output).`,
              "warning",
            );
            return;
          }
          emptyNudges++;
        }

        attempt++;
        const delay = calculateDelay(attempt);

        // Notify the user about the upcoming retry attempt.
        _notifyRetryAttempt(attempt, delay);

        // Interruptible sleep with backoff BEFORE the retry attempt.
        // Polls _userAborted and _sessionGeneration every 100ms so ESC
        // and /new take effect within 100ms instead of waiting for the
        // full backoff (up to 60s).
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
          await _agent.waitForIdle();
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
        hiddenTurnKind = getHiddenTurnKind();
        if (!hiddenTurnKind) {
          didRetryComplete = true;
          return;
        }
      }
    } finally {
      // Release the mutex only if this loop still owns it.
      if (_continueGeneration === myGeneration) {
        pi.events.emit(didRetryComplete ? RETRY_COMPLETED_EVENT : RETRY_CANCELLED_EVENT, {
          retryId: retryLifecycleId,
        });
        _continueInProgress = false;
        _continueGeneration = null;
        _continueInputGeneration = null;
      }
    }
  }

  // Notify the user about a retry attempt via the extension API.
  // ctx.ui.notify is only available inside event handlers, not inside
  // triggerInvisibleContinue. We capture a fresh reference from the
  // most recent handler invocation so it's always current.
  let _notifyFn: ((message: string, level: "info" | "warning" | "error") => void) | null = null;

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
    if (_notifyFn) {
      const duration = formatDuration(delayMs);
      _notifyFn(`Retry attempt ${attempt} (backoff ${duration})...`, "info");
    }
  }
}
