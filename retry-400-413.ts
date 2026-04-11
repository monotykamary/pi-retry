import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  has400or413Error,
  isAssistantMessage,
  getLastAssistantMessage,
  calculateDelay,
  formatDuration,
} from "./src/error-patterns.js";

/**
 * Retry extension for handling 400/413 errors WITHOUT compaction
 * 
 * By default, pi treats 400 and 413 as context overflow (triggers compaction).
 * This extension intercepts them and retries without reducing context.
 * 
 * WARNING: Retrying 400/413 without reducing context may fail repeatedly
 * if the context is genuinely too large. Use with caution.
 * 
 * Features:
 * - Indefinite retry (until success or user abort)
 * - Exponential backoff with cap (max 60s between retries)
 * - Hidden retry triggers (no TUI clutter)
 */

// Track retry state
let customRetryAttempt = 0;
let isCustomRetrying = false;
let lastErrorMessage = "";

const RETRY_CUSTOM_TYPE = "__retry_400_413_trigger";

// Sleep helper
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default function (pi: ExtensionAPI) {
  let pendingRetryCleanup = false;

  // Reset retry counter on successful completion
  pi.on("turn_end", async (event, ctx) => {
    const msg = event.message as any;
    if (msg.role === "assistant" && msg.stopReason !== "error" && msg.stopReason !== "aborted") {
      if (customRetryAttempt > 0) {
        ctx.ui.notify(`400/413 retry succeeded after ${customRetryAttempt} attempt(s).`, "info");
        ctx.ui.setStatus("retry-400-413", undefined);
      }
      customRetryAttempt = 0;
      isCustomRetrying = false;
      lastErrorMessage = "";
    }
  });

  // Intercept agent_end to handle 400/413 errors - PURE RETRY, NO COMPACTION, INFINITE
  pi.on("agent_end", async (event, ctx) => {
    // Prevent recursive retry loops
    if (isCustomRetrying) return;
    
    const entries = ctx.sessionManager.getEntries();
    const lastAssistant = getLastAssistantMessage(entries);
    
    if (!lastAssistant || !has400or413Error(lastAssistant)) {
      return; // Not a 400/413 error - let normal flow continue
    }

    // 400/413 detected - retry without compaction (indefinitely)
    const errorMsg = isAssistantMessage(lastAssistant) && lastAssistant.errorMessage 
      ? lastAssistant.errorMessage 
      : "Unknown error";
    
    lastErrorMessage = errorMsg;
    isCustomRetrying = true;
    customRetryAttempt++;
    
    const delay = calculateDelay(customRetryAttempt);
    
    ctx.ui.notify(`400/413 error (attempt ${customRetryAttempt}): ${errorMsg.substring(0, 100)}`, "warning");
    ctx.ui.setStatus("retry-400-413", `400/413 retry in ${formatDuration(delay)} (attempt ${customRetryAttempt})...`);
    
    await sleep(delay);
    
    // Trigger retry using hidden message
    triggerRetry(pi);
    
    isCustomRetrying = false;
  });

  // Monitor message_end for 400/413 errors (additional visibility)
  pi.on("message_end", async (event, ctx) => {
    const msg = event.message;
    if (msg.role === "assistant" && has400or413Error(msg)) {
      ctx.ui.setStatus("retry-400-413", "400/413 detected - will retry...");
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

  // Register a command to manually retry the last failed request
  pi.registerCommand("retry-413", {
    description: "Manually retry the last 400/413 failed request (no compaction)",
    handler: async (_args, ctx) => {
      const entries = ctx.sessionManager.getEntries();
      const lastAssistant = getLastAssistantMessage(entries);
      
      if (!lastAssistant || !has400or413Error(lastAssistant)) {
        ctx.ui.notify("No recent 400/413 error found", "warning");
        return;
      }

      ctx.ui.notify("Manually retrying 400/413 (no compaction)...", "info");
      
      // Reset attempt counter for manual retry
      customRetryAttempt = 0;
      triggerRetry(pi);
    }
  });

  // Register a command to show/configure retry settings
  pi.registerCommand("retry-config", {
    description: "Show/reset 400/413 retry settings",
    handler: async (args, ctx) => {
      if (args.includes("reset")) {
        customRetryAttempt = 0;
        isCustomRetrying = false;
        lastErrorMessage = "";
        ctx.ui.setStatus("retry-400-413", undefined);
        ctx.ui.notify("Retry counter reset", "info");
        return;
      }
      
      const entries = ctx.sessionManager.getEntries();
      const lastAssistant = getLastAssistantMessage(entries);
      
      const config = { baseDelayMs: 2000, maxDelayMs: 60000, multiplier: 2 };
      let status = `Current retry attempt: ${customRetryAttempt}\n`;
      status += `Is retrying: ${isCustomRetrying}\n`;
      status += `Last error: ${lastErrorMessage || "None"}\n`;
      status += `Base delay: ${config.baseDelayMs}ms, Max delay: ${config.maxDelayMs}ms\n`;
      
      if (lastAssistant && isAssistantMessage(lastAssistant)) {
        status += `\nLast assistant stop reason: ${lastAssistant.stopReason}\n`;
        status += `Last error message: ${lastAssistant.errorMessage || "None"}\n`;
        status += `Is 400/413 error: ${has400or413Error(lastAssistant)}`;
      }
      
      ctx.ui.notify(status, "info");
    }
  });

  // Initialize
  pi.on("session_start", async () => {
    customRetryAttempt = 0;
    isCustomRetrying = false;
    lastErrorMessage = "";
  });

  // Helper: send the hidden retry trigger
  function triggerRetry(pi: ExtensionAPI) {
    pendingRetryCleanup = true;
    pi.sendMessage(
      {
        customType: RETRY_CUSTOM_TYPE,
        content: "Retrying 400/413.",
        display: false,
      },
      { triggerTurn: true },
    );
  }
}
