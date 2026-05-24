import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  RETRY_TRIGGER_CUSTOM_TYPE,
  CONTINUATION_CUSTOM_TYPE,
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
 * - ALL triggers are invisible — custom messages with display:false, stripped by context handler
 * - Unified manual controls via /retry command
 *
 * Silent continue trick (ported from pi-invisible-continue):
 *   - sendMessage() with customType + display:false + triggerTurn:true
 *   - pi's default convertToLlm filters custom-role messages → LLM never sees them
 *   - context event handler strips them as insurance against custom convertToLlm overrides
 *   - No user-visible "Continue" message pollution in the conversation
 */

// Per-category retry state (for diagnostics / messaging)
const state400 = new RetryState();
const stateCredit = new RetryState();
const stateConnection = new RetryState();
const stateOther = new RetryState();

// Max_tokens continuation state (indefinite — no cap needed)
const stateContinuation = new ContinuationState();

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
        if (state400.getAttempt() > 0) {
          ctx.ui.notify(`400/413 retry succeeded after ${state400.getAttempt()} attempt(s).`, "info");
        }
        if (stateCredit.getAttempt() > 0) {
          ctx.ui.notify(`Credit error retry succeeded after ${stateCredit.getAttempt()} attempt(s).`, "info");
        }
        if (stateConnection.getAttempt() > 0) {
          ctx.ui.notify(`Connection retry succeeded after ${stateConnection.getAttempt()} attempt(s).`, "info");
        }
        if (stateOther.getAttempt() > 0) {
          ctx.ui.notify(`Other error retry succeeded after ${stateOther.getAttempt()} attempt(s).`, "info");
        }
        if (stateContinuation.getCount() > 0) {
          ctx.ui.notify(`Max_tokens continuation completed after ${stateContinuation.getCount()} continuation(s).`, "info");
        }
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

    // Check for max_tokens stop — auto-continue (silent, invisible to LLM)
    if (hasMaxTokensStop(lastAssistant) && !stateContinuation.getIsContinuing()) {
      stateContinuation.startContinuation();
      ctx.ui.notify(
        `Max tokens reached — auto-continuing (continuation ${stateContinuation.getCount()})...`,
        "info",
      );
      triggerContinuation(pi);
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

      ctx.ui.notify(
        `${label} error (attempt ${state.getAttempt()}) — retrying in ${formatDuration(delay)}: ${errorMsg.substring(0, 100)}`,
        "warning",
      );

      await sleep(delay);
      triggerRetry(pi);
      state.endRetry();
      return;
    }

    // Log non-retryable errors so the user knows why we didn't retry
    if (isNonRetryableError(lastAssistant)) {
      const errorMsg = lastAssistant.errorMessage || "Unknown error";
      ctx.ui.notify(`Non-retryable error (not retried): ${errorMsg.substring(0, 100)}`, "error");
    }
  });



  // Strip hidden retry/continuation markers from context before each LLM call.
  // This is insurance — convertToLlm already filters custom roles, but a
  // custom convertToLlm override could leak them.  Clean proactively.
  pi.on("context", async (event) => {
    const cleaned = event.messages.filter(
      (msg: any) =>
        !(
          msg.role === "custom" &&
          (msg.customType === RETRY_TRIGGER_CUSTOM_TYPE ||
            msg.customType === CONTINUATION_CUSTOM_TYPE)
        ),
    );
    if (cleaned.length !== event.messages.length) {
      return { messages: cleaned };
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
        status += `  Trigger: invisible (custom message, LLM never sees a prompt)\n\n`;
        
        // Config
        status += "Configuration:\n";
        status += `  Base delay: 2000ms\n`;
        status += `  Max delay: 60000ms\n`;
        status += `  Backoff multiplier: 2\n`;
        status += `  Continuation: invisible custom message\n\n`;
        
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
        triggerContinuation(pi);
        return;
      }

      // Auto-detect error type and trigger appropriate retry
      if (has400or413Error(lastAssistant)) {
        ctx.ui.notify("Manually retrying 400/413 error...", "info");
        state400.reset();
        triggerRetry(pi);
        return;
      }

      if (hasCreditError(lastAssistant)) {
        ctx.ui.notify("Manually retrying credit error...", "info");
        stateCredit.reset();
        triggerRetry(pi);
        return;
      }

      if (hasConnectionError(lastAssistant)) {
        ctx.ui.notify("Manually retrying connection error...", "info");
        stateConnection.reset();
        triggerRetry(pi);
        return;
      }

      // Catch-all: any other retryable error
      if (hasRetryableError(lastAssistant)) {
        ctx.ui.notify("Manually retrying error...", "info");
        stateOther.reset();
        triggerRetry(pi);
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
  });

  // Helper: send the hidden retry trigger
  function triggerRetry(pi: ExtensionAPI) {
    pi.sendMessage(
      {
        customType: RETRY_TRIGGER_CUSTOM_TYPE,
        content: "",
        display: false,
        details: {},
      },
      { triggerTurn: true },
    );
  }

  // Helper: send the hidden continuation trigger (silent — LLM never sees a prompt)
  function triggerContinuation(pi: ExtensionAPI) {
    pi.sendMessage(
      {
        customType: CONTINUATION_CUSTOM_TYPE,
        content: "",
        display: false,
        details: {},
      },
      { triggerTurn: true },
    );
  }
}
