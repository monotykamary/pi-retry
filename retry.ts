import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Agent } from "@earendil-works/pi-agent-core";
import {
  has400or413Error,
  hasCreditError,
  hasConnectionError,
  hasRetryableError,
  isNonRetryableError,
  hasMaxTokensStop,
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

// Per-category retry state (for diagnostics / messaging)
const state400 = new RetryState();
const stateCredit = new RetryState();
const stateConnection = new RetryState();
const stateOther = new RetryState();

// Max_tokens continuation state (indefinite — no cap needed)
const stateContinuation = new ContinuationState();

// Mutex: only one triggerInvisibleContinue may be in-flight at a time.
// Without this, concurrent agent_end events (or a manual /retry during an
// automatic retry) race through waitForIdle() and both call prompt([]),
// producing "Agent is already processing".
let _continueInProgress = false;

// Sleep helper
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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
        // Do NOT reset continuation state — a user abort of a continuation
        // turn is different from aborting an error retry.
        stateContinuation.endContinuation();
        return;
      }
      if (msg.stopReason !== "length") {
        // Normal completion — reset everything including continuation count
        state400.succeed();
        stateCredit.succeed();
        stateConnection.succeed();
        stateOther.succeed();
        stateContinuation.complete();
      }
    }
  });

  // Handle errors and max_tokens on agent_end
  pi.on("agent_end", async (event, ctx) => {
    const entries = ctx.sessionManager.getEntries();
    const lastAssistant = getLastAssistantMessage(entries);
    
    if (!lastAssistant || !isAssistantMessage(lastAssistant)) {
      return;
    }

    // Check for max_tokens stop — auto-continue (invisible to LLM)
    if (hasMaxTokensStop(lastAssistant) && !stateContinuation.getIsContinuing()) {
      stateContinuation.startContinuation();
      ctx.ui.notify(
        `Max tokens reached — auto-continuing (continuation ${stateContinuation.getCount()})...`,
        "info",
      );
      // Must NOT await — see triggerInvisibleContinue() for explanation
      void triggerInvisibleContinue();
      stateContinuation.endContinuation();
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

      state.startRetry(errorMsg);
      const delay = calculateDelay(state.getAttempt());

      await sleep(delay);
      // Must NOT await — see triggerInvisibleContinue() for explanation
      void triggerInvisibleContinue();
      state.endRetry();
      return;
    }

    // Log non-retryable errors so the user knows why we didn't retry
    if (isNonRetryableError(lastAssistant)) {
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
        status += `  Continuation: invisible (agent.prompt([]))\n\n`;
        
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

      // Auto-detect: max_tokens continuation takes priority
      if (hasMaxTokensStop(lastAssistant)) {
        ctx.ui.notify("Manually continuing after max_tokens...", "info");
        void triggerInvisibleContinue();
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
    state400.reset();
    stateCredit.reset();
    stateConnection.reset();
    stateOther.reset();
    stateContinuation.reset();
    _continueInProgress = false;
  });

  // Resume the agent loop invisibly — no message injected into context.
  // The LLM sees the exact same message list it had before.
  //
  // CRITICAL: We must wait until the SESSION has fully finished before we
  // call prompt().  The agent_end event fires inside the current run, and
  // the session's _runAgentPrompt loop may still call continue() after the
  // run resolves (for built-in retries, compaction, etc.).  If we call
  // prompt([]) while the session's continue() is about to run, one of
  // them gets "Agent is already processing".
  //
  // The solution: wait for isStreaming to be false AND stay false across
  // a microtask yield.  This ensures the session's loop has fully exited
  // and won't call continue() under our feet.
  //
  // GUARDS (four layers):
  //   1. _continueInProgress mutex — prevents concurrent calls from racing
  //   2. waitForIdle + settle loop — waits for session to fully finish
  //   3. isStreaming pre-flight — detects user-initiated runs before prompt()
  //   4. .catch() on prompt() — final safety net, swallows rejected promises
  async function triggerInvisibleContinue() {
    if (!_agent) return;

    // Guard 1: mutex — if a previous continue is still in-flight, skip
    if (_continueInProgress) return;
    _continueInProgress = true;

    try {
      // Guard 2: wait for the current run to finish, then verify the
      // session has no further continue() calls pending.
      //
      // The session's _runAgentPrompt loop:
      //   await agent.prompt(messages);
      //   while (await _handlePostAgentRun()) { await agent.continue(); }
      //
      // waitForIdle() resolves when the FIRST run's activeRun is cleared.
      // But the session may immediately start a new run via continue()
      // (built-in retry, compaction).  We must keep waiting until
      // isStreaming stays false across a microtask yield — that proves
      // the session's loop has exited.
      const MAX_SETTLE_ATTEMPTS = 50;
      for (let i = 0; i < MAX_SETTLE_ATTEMPTS; i++) {
        await _agent.waitForIdle();
        if (!_agent.state.isStreaming) break;
        // Session started another run (built-in retry, compaction) — wait
        // for it to finish before checking again.
      }
      // Yield once more: if the session's _handlePostAgentRun returns true
      // synchronously, the while loop will call continue() on the next
      // microtask.  By yielding, we give it a chance to start that run
      // so our next isStreaming check catches it.
      await new Promise(r => setTimeout(r, 0));
      if (_agent.state.isStreaming) {
        // Session is handling the retry/compaction itself.  We don't need
        // to do anything — it will emit its own agent_end when done, which
        // may trigger this handler again for further retries.
        return;
      }

      // Guard 3: pre-flight — the user may have sent a message while we
      // waited.  agent.state.isStreaming is authoritative.
      if (_agent.state.isStreaming) return;

      // Remove the error assistant message from the transcript so the LLM
      // can retry from the same context.  (The session's _prepareRetry does
      // the same thing for built-in retries.)
      const messages = _agent.state.messages;
      if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
        _agent.state.messages = messages.slice(0, -1);
      }

      // Guard 4: .catch() swallows the "already processing" error as a
      // last resort.  agent.prompt() is async, so errors become rejected
      // Promises — a try/catch around an un-awaited call catches nothing.
      _agent.prompt([]).catch(() => {});
    } finally {
      _continueInProgress = false;
    }
  }
}
