import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  hasConnectionError,
  isAssistantMessage,
  getLastAssistantMessage,
  calculateDelay,
  formatDuration,
} from "./src/error-patterns.js";

/**
 * Retry extension for handling connection errors with indefinite retry
 * 
 * Problem: Sometimes pi gives a "Connection error" and does a 3 retry loop
 * before continuing. This extension provides:
 * - Indefinite retries (with reasonable exponential backoff up to a limit)
 * - Cover the connection error case (we covered 413 and the such).
 * 
 * This can be used alongside retry-400-413.ts for comprehensive error coverage.
 */

// Track retry state
let connectionRetryAttempt = 0;
let isConnectionRetrying = false;
let lastErrorMessage = "";

const RETRY_CUSTOM_TYPE = "__connection_retry_trigger";

// Sleep helper
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default function (pi: ExtensionAPI) {
  let pendingRetryCleanup = false;

  // Reset state on successful completion
  pi.on("turn_end", async (event, ctx) => {
    const msg = event.message as any;
    if (msg.role === "assistant" && msg.stopReason !== "error" && msg.stopReason !== "aborted") {
      if (connectionRetryAttempt > 0) {
        ctx.ui.notify(`Connection retry succeeded after ${connectionRetryAttempt} attempt(s).`, "info");
        ctx.ui.setStatus("retry-connection", undefined);
      }
      connectionRetryAttempt = 0;
      isConnectionRetrying = false;
      lastErrorMessage = "";
    }
  });

  // Handle connection errors on agent_end
  pi.on("agent_end", async (event, ctx) => {
    // Prevent recursive retry loops
    if (isConnectionRetrying) return;
    
    const entries = ctx.sessionManager.getEntries();
    const lastAssistant = getLastAssistantMessage(entries);
    
    if (!lastAssistant || !hasConnectionError(lastAssistant)) {
      return; // Not a connection error - let normal flow continue
    }

    // Connection error detected
    const errorMsg = isAssistantMessage(lastAssistant) && lastAssistant.errorMessage 
      ? lastAssistant.errorMessage 
      : "Unknown connection error";
    
    lastErrorMessage = errorMsg;
    isConnectionRetrying = true;
    connectionRetryAttempt++;

    const delay = calculateDelay(connectionRetryAttempt);
    
    ctx.ui.notify(`Connection error detected (attempt ${connectionRetryAttempt}): ${errorMsg.substring(0, 100)}`, "warning");
    ctx.ui.setStatus("retry-connection", `Connection error - retrying in ${formatDuration(delay)} (attempt ${connectionRetryAttempt})...`);
    
    await sleep(delay);
    
    // Trigger retry using hidden message
    triggerRetry(pi);
    
    isConnectionRetrying = false;
  });

  // Monitor message_end for connection errors (additional visibility)
  pi.on("message_end", async (event, ctx) => {
    const msg = event.message;
    if (msg.role === "assistant" && hasConnectionError(msg)) {
      ctx.ui.setStatus("retry-connection", "Connection error - will retry...");
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

  // Manual retry command
  pi.registerCommand("retry-connection", {
    description: "Manually retry the last connection error (indefinite retry mode)",
    handler: async (_args, ctx) => {
      const entries = ctx.sessionManager.getEntries();
      const lastAssistant = getLastAssistantMessage(entries);
      
      if (!lastAssistant || !hasConnectionError(lastAssistant)) {
        ctx.ui.notify("No recent connection error found", "warning");
        return;
      }

      ctx.ui.notify("Manually triggering connection retry...", "info");
      connectionRetryAttempt = 0; // Reset counter for manual retry
      triggerRetry(pi);
    }
  });

  // Status command
  pi.registerCommand("retry-connection-status", {
    description: "Show connection retry status",
    handler: async (_args, ctx) => {
      const entries = ctx.sessionManager.getEntries();
      const lastAssistant = getLastAssistantMessage(entries);
      
      const config = { baseDelayMs: 2000, maxDelayMs: 60000, multiplier: 2 };
      let status = `Current retry attempt: ${connectionRetryAttempt}\n`;
      status += `Is retrying: ${isConnectionRetrying}\n`;
      status += `Last error: ${lastErrorMessage || "None"}\n`;
      status += `Base delay: ${config.baseDelayMs}ms, Max delay: ${config.maxDelayMs}ms\n`;
      
      if (lastAssistant && isAssistantMessage(lastAssistant)) {
        status += `\nLast assistant stop reason: ${lastAssistant.stopReason}\n`;
        status += `Last error message: ${lastAssistant.errorMessage || "None"}\n`;
        status += `Is connection error: ${hasConnectionError(lastAssistant)}`;
      }
      
      ctx.ui.notify(status, "info");
    }
  });

  // Reset command
  pi.registerCommand("retry-connection-reset", {
    description: "Reset connection retry counter",
    handler: async (_args, ctx) => {
      connectionRetryAttempt = 0;
      isConnectionRetrying = false;
      lastErrorMessage = "";
      ctx.ui.setStatus("retry-connection", undefined);
      ctx.ui.notify("Connection retry counter reset", "info");
    }
  });

  // Initialize
  pi.on("session_start", async () => {
    connectionRetryAttempt = 0;
    isConnectionRetrying = false;
    lastErrorMessage = "";
  });

  // Helper: send the hidden retry trigger
  function triggerRetry(pi: ExtensionAPI) {
    pendingRetryCleanup = true;
    pi.sendMessage(
      {
        customType: RETRY_CUSTOM_TYPE,
        content: "Retrying connection.",
        display: false,
      },
      { triggerTurn: true },
    );
  }
}
