import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Agent } from "@earendil-works/pi-agent-core";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  has400or413Error,
  hasCreditError,
  hasConnectionError,
  hasRetryableError,
  isNonRetryableError,
  isSilencedError,
  hasMaxTokensStop,
  isContextOverflowError,
  isAssistantMessage,
  getLastAssistantMessage,
  calculateDelay,
  formatDuration,
  getErrorCategory,
  RetryState,
  ContinuationState,
} from "./src/index.js";

/**
 * Unified retry extension — retries EVERY error by default.
 *
 * Philosophy: any assistant message with stopReason === "error" is retried
 * indefinitely with exponential backoff, except a tiny blacklist of known
 * permanent failures (invalid API key, model not found, etc.).
 *
 * Specific categories (400/413, credit, connection, stream exhaustion, etc.)
 * are tracked for diagnostics but all share the same retry mechanism.
 *
 * Features:
 * - Automatic detection and retry for ALL errors (catch-all)
 * - Indefinite retry with exponential backoff (capped at 60s)
 * - Auto-continuation when model hits max output tokens (stopReason "length")
 * - ALL triggers are invisible — agent.prompt([]) resumes the loop with no new message
 * - Unified manual controls via /retry command
 *
 * Invisibility mechanism:
 *   - Agent.prototype.subscribe monkey-patch captures the Agent instance
 *   - agent.prompt([]) starts a fresh agent loop with an empty prompt array
 *   - No message injected into context — LLM sees the exact same message list
 *   - No convertToLlm involvement, no filter needed, no session artifact
 *
 * Retry loop design:
 *   - The agent_end handler detects retryable errors but does NOT sleep.
 *     It fires triggerInvisibleContinue() immediately, keeping processEvents
 *     unblocked so the agent can finish its run and become idle.
 *   - triggerInvisibleContinue() owns the retry loop: it waits for idle,
 *     removes error assistant messages from agent state, calls prompt([])
 *     and checks the result. On error it sleeps (outside processEvents)
 *     and retries. On success or user abort the loop exits.
 *   - The continue() monkey-patch cooperates: while _continueInProgress is
 *     true, the session's continue() spins. After the loop finishes, it
 *     calls _origContinue which checks the now-updated agent state. For
 *     stopReason "error" it no longer falls back to prompt([]) (the loop
 *     already handled it). For toolUse/length (compaction mid-task) it
 *     still falls back to prompt([]).
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

// Monkey-patch continue() so the session's built-in retry loop cooperates
// with our _continueInProgress mutex AND can convert the "Cannot continue
// from assistant" error into a prompt([]) call when the agent was mid-task
// (compaction, toolUse, length — but NOT error, which the loop handles).
//
// Note (pi 0.79+): Agent.continue() now drains queued steering/follow-up
// messages before throwing, so this throw path only fires when there are
// genuinely no queued messages — the prompt([]) fallback is still correct.
const _origContinue = Agent.prototype.continue as (this: Agent) => Promise<void>;
Agent.prototype.continue = function (this: Agent) {
  const self = this;
  return (async () => {
    // Wait while pi-retry is driving the agent so we don't double-dip.
    while (_continueInProgress) {
      await new Promise(r => setTimeout(r, 10));
    }
    try {
      return await _origContinue.call(self);
    } catch (e: any) {
      const msg = e?.message ?? '';
      if (msg.includes('Cannot continue from message role') ||
          msg.includes('Cannot continue from an assistant message')) {
        const lastMsg = self.state.messages[self.state.messages.length - 1];
        if (lastMsg?.role === 'assistant') {
          // stopReason "error": pi-retry's loop is the error handler.
          // It will have already retried or the user aborted — don't
          // start a second retry path via prompt([]).
          if (lastMsg.stopReason === 'error') {
            return;
          }
          // stopReason "stop" / "aborted": agent finished or user cancelled.
          // Don't continue.
          if (lastMsg.stopReason === 'stop' || lastMsg.stopReason === 'aborted') {
            return;
          }
          // stopReason "toolUse" or "length": agent was mid-task (e.g.
          // compaction broke the message ordering). Fall back to prompt([]).
          if (!_continueInProgress) {
            _continueInProgress = true;
            try {
              await self.prompt([]);
            } catch {
              // Agent already processing or other transient error
            } finally {
              _continueInProgress = false;
            }
          }
        }
        return;
      }
      if (msg.includes('Agent is already processing')) {
        return;
      }
      throw e;
    }
  })();
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
  if (_continueInProgress) {
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

// Abort flag: set when turn_end reports stopReason "aborted", cleared on
// session_start and on fresh user activity.  Prevents triggerInvisibleContinue()
// from driving a new prompt([]) after the user explicitly cancelled.
let _userAborted = false;

// Mutex: only one triggerInvisibleContinue may be in-flight at a time.
// Without this, concurrent agent_end events (or a manual /retry during an
// automatic retry) race through waitForIdle() and both call prompt([]),
// producing "Agent is already processing".
let _continueInProgress = false;

// Timestamp of the last completed triggerInvisibleContinue().
// Used by the continue() monkey-patch to avoid double continuation when
// triggerInvisibleContinue just ran and the session's continue() unblocks.
let _lastInvisibleContinueTime = 0;

// Session generation counter: incremented on every session_start.
// The retry loop captures the current generation when it starts and exits
// when it changes — this handles /new and other session switches.
let _sessionGeneration = 0;

// Interruptible sleep: polls _userAborted and _sessionGeneration every
// 100ms.  Returns true if interrupted (abort or session change), false if
// the full delay elapsed normally.
function interruptibleSleep(ms: number, generation: number): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(false);
  return new Promise(resolve => {
    const checkInterval = 100;
    let elapsed = 0;
    const timer = setInterval(() => {
      elapsed += checkInterval;
      if (_userAborted || _sessionGeneration !== generation) {
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

// Check if the agent's last message indicates a retryable error.
function lastMessageIsRetryableError(): boolean {
  if (!_agent) return false;
  const messages = _agent.state.messages;
  const lastMsg = messages[messages.length - 1];
  return lastMsg?.role === 'assistant' && lastMsg.stopReason === 'error';
}

export default function (pi: ExtensionAPI) {

  // Reset retry counters on successful completion (not max_tokens, not error)
  pi.on("turn_end", async (event, ctx) => {
    const msg = event.message as any;
    if (msg.role === "assistant" && msg.stopReason !== "error") {
      if (msg.stopReason === "aborted") {
        // User cancelled — reset retry state so it doesn't leak into other
        // branches of the session tree.
        state400.reset();
        stateCredit.reset();
        stateConnection.reset();
        stateOther.reset();
        stateContinuation.endContinuation();
        // Signal to any in-flight triggerInvisibleContinue or pending retry
        // that the user has cancelled — don't drive a new prompt([]).
        _userAborted = true;
        return;
      }
      if (msg.stopReason !== "length") {
        // Normal completion — reset everything including continuation count
        state400.succeed();
        stateCredit.succeed();
        stateConnection.succeed();
        stateOther.succeed();
        stateContinuation.complete();
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
    const entries = ctx.sessionManager.getEntries();
    const lastAssistant = getLastAssistantMessage(entries);

    if (!lastAssistant || !isAssistantMessage(lastAssistant)) {
      return;
    }

    // Guard: if the user aborted, don't drive any new prompt([])
    if (_userAborted) return;

    // If the retry loop is already driving, don't interfere — it will
    // see the new error on its next loop iteration.
    if (_continueInProgress) return;

    // Check for max_tokens stop — auto-continue (invisible to LLM)
    if (hasMaxTokensStop(lastAssistant) && !stateContinuation.getIsContinuing()) {
      stateContinuation.startContinuation();
      ctx.ui.notify(
        `Max tokens reached — auto-continuing (continuation ${stateContinuation.getCount()})...`,
        "info",
      );
      void triggerInvisibleContinue();
      stateContinuation.endContinuation();
      return;
    }

    // Context overflow: defer to compaction. Do NOT retry here.
    //
    // triggerInvisibleContinue() calls agent.prompt([]) directly on the core
    // Agent, bypassing AgentSession._handlePostAgentRun → _checkCompaction, so
    // a pi-retry retry loop gets NO compaction. Retrying an overflow would
    // re-send the same oversized context → overflow again → infinite loop
    // (pi-retry's error loop is uncapped). Meanwhile pi-retry's _continueInProgress
    // mutex would block pi-core's own compaction-retry (agent.continue()), so
    // pi-core never gets to compact either.
    //
    // Instead, return without firing triggerInvisibleContinue. pi-core's
    // _checkCompaction (which runs in _handlePostAgentRun regardless of
    // extensions) detects the same overflow, compacts (statically via pi-vcc
    // when installed), and retries once via agent.continue() with the reduced
    // context. _continueInProgress stays false, so pi-core's continue is
    // unblocked.
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

      void triggerInvisibleContinue();
      return;
    }

    // Log non-retryable errors so the user knows why we didn't retry
    // (silenced errors are neither retried nor shown)
    if (isNonRetryableError(lastAssistant) && !isSilencedError(lastAssistant)) {
      const errorMsg = lastAssistant.errorMessage || "Unknown error";
      ctx.ui.notify(`Non-retryable error (not retried): ${errorMsg.substring(0, 100)}`, "error");
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
        status += `  Trigger: invisible (agent.prompt([]), LLM never sees a prompt)\n\n`;

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
        void triggerInvisibleContinue();
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

      // Auto-detect error type and trigger appropriate retry
      if (has400or413Error(lastAssistant)) {
        ctx.ui.notify("Manually retrying 400/413 error...", "info");
        state400.reset();
        void triggerInvisibleContinue();
        return;
      }

      if (hasCreditError(lastAssistant)) {
        ctx.ui.notify("Manually retrying credit error...", "info");
        stateCredit.reset();
        void triggerInvisibleContinue();
        return;
      }

      if (hasConnectionError(lastAssistant)) {
        ctx.ui.notify("Manually retrying connection error...", "info");
        stateConnection.reset();
        void triggerInvisibleContinue();
        return;
      }

      // Catch-all: any other retryable error
      if (hasRetryableError(lastAssistant)) {
        ctx.ui.notify("Manually retrying error...", "info");
        stateOther.reset();
        void triggerInvisibleContinue();
        return;
      }

      // No error detected - show status instead
      ctx.ui.notify("No retryable error detected. Use '/retry status' for diagnostics.", "warning");
    }
  });

  // Initialize
  pi.on("session_start", async () => {
    // Bump the generation counter so any in-flight retry loop from a
    // previous session exits on its next checkpoint (within 100ms during
    // backoff sleep, or immediately after prompt([]) returns).
    _sessionGeneration++;

    state400.reset();
    stateCredit.reset();
    stateConnection.reset();
    stateOther.reset();
    stateContinuation.reset();
    // Do NOT reset _continueInProgress here — the in-flight loop's
    // finally block handles it conditionally (only if the generation
    // hasn't changed since the loop started).  Resetting it here would
    // break the mutex invariant and could allow a second loop to start.
    _lastInvisibleContinueTime = 0;
    _userAborted = false;
  });

  // Retry loop driver — the core of pi-retry.
  //
  // Unlike the original one-shot design, this function loops. After each
  // prompt([]) call it checks the result:
  //   - Success (stopReason !== "error"): loop exits, agent is done.
  //   - Error (stopReason === "error"): sleep with backoff, then retry.
  //   - User abort (stopReason "aborted"): loop exits immediately.
  //
  // The backoff sleep happens AFTER prompt([]) returns and processEvents
  // has settled, so it does NOT block the agent. The agent is idle during
  // the sleep and can respond to user input (e.g. Escape to abort).
  //
  // Before each retry, the error assistant message is removed from
  // agent.state.messages so the LLM receives a clean context (same
  // technique as the built-in retry's _prepareRetry).
  async function triggerInvisibleContinue() {
    if (!_agent) return;

    // Guard: if the user aborted, don't drive a new prompt([]).
    if (_userAborted) return;

    // Guard: mutex — if a previous continue is still in-flight, skip
    if (_continueInProgress) return;
    _continueInProgress = true;

    // Capture the current session generation. If /new fires while we're
    // looping, _sessionGeneration will increment and the loop will exit.
    const myGeneration = _sessionGeneration;

    try {
      // Wait for the current run to finish (activeRun resolves in
      // finishRun() after agent_end listeners return).
      await _agent.waitForIdle();

      // Re-check after waitForIdle: the user may have aborted or the
      // session may have changed while we were waiting.
      if (_userAborted || _sessionGeneration !== myGeneration) return;

      let attempt = 0;

      // Loop until success, abort, or session change.
      while (true) {
        if (_userAborted || _sessionGeneration !== myGeneration) return;

        // Remove the error assistant message from agent state so
        // prompt([]) sends a clean context to the LLM.
        removeErrorFromAgentState();

        attempt++;
        const delay = calculateDelay(attempt);

        // Notify the user about the upcoming retry attempt.
        _notifyRetryAttempt(attempt, delay);

        // Interruptible sleep with backoff BEFORE the retry attempt.
        // Polls _userAborted and _sessionGeneration every 100ms so ESC
        // and /new take effect within 100ms instead of waiting for the
        // full backoff (up to 60s).
        const interrupted = await interruptibleSleep(delay, myGeneration);
        if (interrupted) return;

        try {
          await _agent.prompt([]);
        } catch {
          // "Agent is already processing" or other transient error —
          // the session or another driver is handling it.
          return;
        }

        // Re-check after prompt: the user may have hit ESC during the
        // prompt, or /new may have fired — don't keep retrying.
        if (_userAborted || _sessionGeneration !== myGeneration) return;

        // prompt([]) completed. Check the result.
        if (!lastMessageIsRetryableError()) {
          // Success or non-error terminal state — exit the loop.
          return;
        }

        // Error again — loop back for another attempt.
      }
    } finally {
      // Only reset the mutex if the session hasn't changed since we
      // started.  If /new fired, a new retry loop may already own the
      // mutex — resetting it here would clobber that.
      if (_sessionGeneration === myGeneration) {
        _continueInProgress = false;
      }
      _lastInvisibleContinueTime = Date.now();
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
