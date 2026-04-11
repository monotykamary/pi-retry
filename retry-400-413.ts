import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

/**
 * Retry extension for handling 400/413 errors WITHOUT compaction
 * 
 * By default, pi treats 400 and 413 as context overflow (triggers compaction).
 * This extension intercepts them and retries without reducing context.
 * 
 * WARNING: Retrying 400/413 without compaction may fail repeatedly
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

// Configuration
const BASE_DELAY_MS = 2000;        // Start with 2 seconds
const MAX_DELAY_MS = 60000;        // Cap at 60 seconds
const BACKOFF_MULTIPLIER = 2;      // Double each time
const RETRY_CUSTOM_TYPE = "__retry_400_413_trigger";

// Type guard to check if message is an AssistantMessage
function isAssistantMessage(message: AgentMessage): message is Extract<AgentMessage, { role: "assistant" }> {
  return message.role === "assistant";
}

// Check if message has 400 or 413 error
function has400or413Error(message: AgentMessage): boolean {
  if (!isAssistantMessage(message)) return false;
  if (message.stopReason !== "error" || !message.errorMessage) return false;
  
  // Match 400 or 413 status codes (commonly from Cerebras or other providers)
  // These are normally treated as context overflow by isContextOverflow()
  return /\b4(00|13)\b.*status code/i.test(message.errorMessage) ||
         /bad request/i.test(message.errorMessage) ||
         /payload too large/i.test(message.errorMessage);
}

// Get the last assistant message from session
function getLastAssistantMessage(entries: unknown[]): AgentMessage | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type?: string; message?: AgentMessage };
    if (entry.type === "message" && entry.message?.role === "assistant") {
      return entry.message;
    }
  }
  return undefined;
}

// Calculate delay with exponential backoff and cap
function calculateDelay(attempt: number): number {
  const delay = BASE_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, attempt - 1);
  return Math.min(delay, MAX_DELAY_MS);
}

// Sleep helper
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Format duration for display
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(0);
  return `${minutes}m ${seconds}s`;
}

export default function (pi: ExtensionAPI) {
  let pendingRetryCleanup = false;

  // Reset retry counter on successful completion
  pi.on("turn_end", async (event, ctx) => {
    const msg = event.message as any;
    if (msg.role === "assistant" && msg.stopReason !== "error" && msg.stopReason !== "aborted") {
      if (customRetryAttempt > 0) {
        ctx.ui.notify(`400/413 retry succeeded after ${customRetryAttempt} attempt(s).`, "success");
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
      
      let status = `Current retry attempt: ${customRetryAttempt}\n`;
      status += `Is retrying: ${isCustomRetrying}\n`;
      status += `Last error: ${lastErrorMessage || "None"}\n`;
      status += `Base delay: ${BASE_DELAY_MS}ms, Max delay: ${MAX_DELAY_MS}ms\n`;
      
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
