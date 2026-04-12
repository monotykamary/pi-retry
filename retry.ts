import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  has400or413Error,
  hasConnectionError,
  isAssistantMessage,
  getLastAssistantMessage,
  calculateDelay,
  formatDuration,
  getErrorCategory,
  RetryState,
} from "./src/index.js";

/**
 * Unified retry extension for handling 400/413 and connection errors
 * 
 * Features:
 * - Automatic detection and retry for both 400/413 and connection errors
 * - Indefinite retry with exponential backoff (capped at 60s)
 * - Hidden retry triggers (no TUI clutter)
 * - Unified manual controls via /retry command
 * 
 * 400/413 errors are retried without compaction (use with caution if context is genuinely too large).
 * Connection errors are retried indefinitely until success.
 */

const RETRY_CUSTOM_TYPE = "__retry_trigger";

// Track retry state for both error types
const state400 = new RetryState();
const stateConnection = new RetryState();

// Sleep helper
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default function (pi: ExtensionAPI) {
  let pendingRetryCleanup = false;

  // Reset retry counters on successful completion
  pi.on("turn_end", async (event, ctx) => {
    const msg = event.message as any;
    if (msg.role === "assistant" && msg.stopReason !== "error" && msg.stopReason !== "aborted") {
      if (state400.getAttempt() > 0) {
        ctx.ui.notify(`400/413 retry succeeded after ${state400.getAttempt()} attempt(s).`, "info");
        ctx.ui.setStatus("retry-400-413", undefined);
      }
      if (stateConnection.getAttempt() > 0) {
        ctx.ui.notify(`Connection retry succeeded after ${stateConnection.getAttempt()} attempt(s).`, "info");
        ctx.ui.setStatus("retry-connection", undefined);
      }
      state400.succeed();
      stateConnection.succeed();
    }
  });

  // Handle errors on agent_end
  pi.on("agent_end", async (event, ctx) => {
    const entries = ctx.sessionManager.getEntries();
    const lastAssistant = getLastAssistantMessage(entries);
    
    if (!lastAssistant || !isAssistantMessage(lastAssistant)) {
      return;
    }

    // Check for 400/413 error
    if (has400or413Error(lastAssistant) && !state400.getIsRetrying()) {
      const errorMsg = lastAssistant.errorMessage || "Unknown 400/413 error";
      state400.startRetry(errorMsg);
      
      const delay = calculateDelay(state400.getAttempt());
      
      ctx.ui.notify(`400/413 error (attempt ${state400.getAttempt()}): ${errorMsg.substring(0, 100)}`, "warning");
      ctx.ui.setStatus("retry-400-413", `400/413 retry in ${formatDuration(delay)} (attempt ${state400.getAttempt()})...`);
      
      await sleep(delay);
      triggerRetry(pi);
      state400.endRetry();
      return;
    }

    // Check for connection error
    if (hasConnectionError(lastAssistant) && !stateConnection.getIsRetrying()) {
      const errorMsg = lastAssistant.errorMessage || "Unknown connection error";
      stateConnection.startRetry(errorMsg);
      
      const delay = calculateDelay(stateConnection.getAttempt());
      
      ctx.ui.notify(`Connection error (attempt ${stateConnection.getAttempt()}): ${errorMsg.substring(0, 100)}`, "warning");
      ctx.ui.setStatus("retry-connection", `Connection error - retrying in ${formatDuration(delay)} (attempt ${stateConnection.getAttempt()})...`);
      
      await sleep(delay);
      triggerRetry(pi);
      stateConnection.endRetry();
      return;
    }
  });

  // Monitor message_end for errors (additional visibility)
  pi.on("message_end", async (event, ctx) => {
    const msg = event.message;
    if (msg.role === "assistant") {
      if (has400or413Error(msg)) {
        ctx.ui.setStatus("retry-400-413", "400/413 detected - will retry...");
      } else if (hasConnectionError(msg)) {
        ctx.ui.setStatus("retry-connection", "Connection error - will retry...");
      }
    }
  });

  // Clean up hidden retry triggers from context
  pi.on("context", async (event) => {
    if (!pendingRetryCleanup) return;
    pendingRetryCleanup = false;

    const cleaned = event.messages.filter((msg: any) => {
      if (msg.role === "custom" && msg.customType === RETRY_CUSTOM_TYPE) {
        return false;
      }
      return true;
    });

    return { messages: cleaned };
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
        
        // Connection state
        status += "Connection Errors:\n";
        status += `  Current attempt: ${stateConnection.getAttempt()}\n`;
        status += `  Is retrying: ${stateConnection.getIsRetrying()}\n`;
        status += `  Last error: ${stateConnection.getLastErrorMessage().substring(0, 100) || "None"}\n\n`;
        
        // Config
        status += "Configuration:\n";
        status += `  Base delay: 2000ms\n`;
        status += `  Max delay: 60000ms\n`;
        status += `  Backoff multiplier: 2\n\n`;
        
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
        stateConnection.reset();
        ctx.ui.setStatus("retry-400-413", undefined);
        ctx.ui.setStatus("retry-connection", undefined);
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

      // Auto-detect error type and trigger appropriate retry
      if (has400or413Error(lastAssistant)) {
        ctx.ui.notify("Manually retrying 400/413 error...", "info");
        state400.reset();
        triggerRetry(pi);
        return;
      }

      if (hasConnectionError(lastAssistant)) {
        ctx.ui.notify("Manually retrying connection error...", "info");
        stateConnection.reset();
        triggerRetry(pi);
        return;
      }

      // No error detected - show status instead
      ctx.ui.notify("No retryable error detected (400/413 or connection). Use '/retry status' for diagnostics.", "warning");
    }
  });

  // Initialize
  pi.on("session_start", async () => {
    state400.reset();
    stateConnection.reset();
  });

  // Helper: send the hidden retry trigger
  function triggerRetry(pi: ExtensionAPI) {
    pendingRetryCleanup = true;
    pi.sendMessage(
      {
        customType: RETRY_CUSTOM_TYPE,
        content: "Retrying...",
        display: false,
      },
      { triggerTurn: true },
    );
  }
}
