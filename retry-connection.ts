import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent, ImageContent } from "@mariozechner/pi-ai";

/**
 * Retry extension for handling connection errors with indefinite retry
 * 
 * Problem: Sometimes pi gives a "Connection error" and does a 3 retry loop
 * before giving up. This extension provides:
 * - Indefinite retries (until success or user abort)
 * - Exponential backoff with a cap (max 60s between retries)
 * - Coverage for connection errors not handled by other extensions
 * 
 * This can be used alongside retry-400-413.ts for comprehensive error coverage.
 */

// Track retry state
let connectionRetryAttempt = 0;
let isConnectionRetrying = false;
let lastErrorMessage = "";

// Configuration
const BASE_DELAY_MS = 2000;        // Start with 2 seconds
const MAX_DELAY_MS = 60000;      // Cap at 60 seconds
const BACKOFF_MULTIPLIER = 2;    // Double each time
const RETRY_CUSTOM_TYPE = "__connection_retry_trigger";

// Connection error patterns to detect
// These are errors that indicate network/transport issues
const CONNECTION_ERROR_PATTERNS = [
  /connection\s*error/i,
  /network\s*error/i,
  /fetch\s*failed/i,
  /socket\s*(hang\s*up|error|timeout)/i,
  /econnreset/i,
  /econnrefused/i,
  /etimedout/i,
  /enotfound/i,
  /dns\s*lookup\s*failed/i,
  /request\s*ended\s*without\s*sending\s*any\s*chunks/i,
  /upstream\s*connect/i,
  /other\s*side\s*closed/i,
  /reset\s*before\s*headers/i,
  /broken\s*pipe/i,
  /unexpected\s*end\s*of\s*file/i,
  /tls\s*handshake\s*(error|timeout)/i,
  /ssl\s*connection\s*error/i,
  /timeout\s*(awaiting|waiting\s*for)\s*response/i,
  /request\s*timeout/i,
];

// Patterns already handled by pi's built-in retry - we don't want to double-retry
// but we can be more aggressive with our retry logic
const BUILTIN_HANDLED_PATTERNS = [
  /overloaded/i,
  /rate\s*limit/i,
  /too\s*many\s*requests/i,
  /429/i,
  /5\d{2}/,  // 500, 502, 503, 504, etc.
  /service\s*unavailable/i,
  /server\s*error/i,
  /internal\s*error/i,
  /retry\s*delay/i,
];

// Type guard to check if message is an AssistantMessage
function isAssistantMessage(message: AgentMessage): message is Extract<AgentMessage, { role: "assistant" }> {
  return message.role === "assistant";
}

// Check if message has a connection error
function hasConnectionError(message: AgentMessage): boolean {
  if (!isAssistantMessage(message)) return false;
  if (message.stopReason !== "error" || !message.errorMessage) return false;
  
  const errorMsg = message.errorMessage;
  
  // Skip if it's handled by built-in retry (unless we want to be more aggressive)
  // Comment out this check if you want to retry even built-in handled errors
  // for (const pattern of BUILTIN_HANDLED_PATTERNS) {
  //   if (pattern.test(errorMsg)) return false;
  // }
  
  // Check for connection error patterns
  for (const pattern of CONNECTION_ERROR_PATTERNS) {
    if (pattern.test(errorMsg)) {
      return true;
    }
  }
  
  return false;
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

// Type guard for user message with content
function isUserMessageWithContent(message: AgentMessage): message is Extract<AgentMessage, { role: "user" }> & { content: (TextContent | ImageContent)[] | string } {
  return message.role === "user" && "content" in message;
}

// Type guard for text content
function isTextContent(c: TextContent | ImageContent | unknown): c is { type: "text"; text: string } {
  return typeof c === "object" && c !== null && "type" in c && c.type === "text" && "text" in c;
}

// Extract text content from message content array
function extractTextContent(content: (TextContent | ImageContent)[] | string | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter(isTextContent)
    .map(c => c.text)
    .join("");
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

  // Reset state on successful completion
  pi.on("turn_end", async (event, ctx) => {
    const msg = event.message as any;
    if (msg.role === "assistant" && msg.stopReason !== "error" && msg.stopReason !== "aborted") {
      if (connectionRetryAttempt > 0) {
        ctx.ui.notify(`Connection retry succeeded after ${connectionRetryAttempt} attempt(s).`, "success");
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
    
    // Trigger retry by sending a hidden message
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
      
      let status = `Current retry attempt: ${connectionRetryAttempt}\n`;
      status += `Is retrying: ${isConnectionRetrying}\n`;
      status += `Last error: ${lastErrorMessage || "None"}\n`;
      
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
