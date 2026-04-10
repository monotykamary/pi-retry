import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent, ImageContent } from "@mariozechner/pi-ai";

/**
 * Retry extension for handling 400/413 errors WITHOUT compaction
 * 
 * By default, pi treats 400 and 413 as context overflow (triggers compaction).
 * This extension intercepts them and retries without reducing context.
 * 
 * WARNING: Retrying 400/413 without compaction may fail repeatedly
 * if the context is genuinely too large. Use with caution.
 */

// Track retry state
let customRetryAttempt = 0;
let isCustomRetrying = false;
const MAX_CUSTOM_RETRIES = 3;
const CUSTOM_RETRY_DELAY_MS = 2000;

// Type guard to check if message is an AssistantMessage with error properties
function isAssistantWithError(message: AgentMessage): message is Extract<AgentMessage, { role: "assistant" }> {
  return message.role === "assistant";
}

// Check if message has 400 or 413 error
function has400or413Error(message: AgentMessage): boolean {
  if (!isAssistantWithError(message)) return false;
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

// Exponential backoff sleep
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default function (pi: ExtensionAPI) {
  
  // Reset retry counter on successful completion
  pi.on("agent_end", async (event, ctx) => {
    const lastMsg = event.messages[event.messages.length - 1];
    if (lastMsg?.role === "assistant" && lastMsg.stopReason !== "error") {
      customRetryAttempt = 0;
      isCustomRetrying = false;
      ctx.ui.setStatus("retry-400-413", undefined); // Clear the status
    }
  });

  // Intercept agent_end to handle 400/413 errors - PURE RETRY, NO COMPACTION
  pi.on("agent_end", async (event, ctx) => {
    // Prevent recursive retry loops
    if (isCustomRetrying) return;
    
    const entries = ctx.sessionManager.getEntries();
    const lastAssistant = getLastAssistantMessage(entries);
    
    if (!lastAssistant || !has400or413Error(lastAssistant)) {
      return; // Not a 400/413 error - let normal flow continue
    }

    // 400/413 detected - retry without compaction
    // We know it's an assistant message with error from has400or413Error check
    const errorMsg = isAssistantWithError(lastAssistant) && lastAssistant.errorMessage 
      ? lastAssistant.errorMessage 
      : "Unknown error";
    
    ctx.ui.notify(`400/413 error detected: ${errorMsg}`, "warning");

    if (customRetryAttempt < MAX_CUSTOM_RETRIES) {
      isCustomRetrying = true;
      customRetryAttempt++;
      const delay = CUSTOM_RETRY_DELAY_MS * Math.pow(2, customRetryAttempt - 1);
      
      ctx.ui.notify(`Retrying ${customRetryAttempt}/${MAX_CUSTOM_RETRIES} in ${delay}ms (no compaction)...`, "info");
      ctx.ui.setStatus("retry-400-413", `Retrying (${customRetryAttempt}/${MAX_CUSTOM_RETRIES})...`);
      
      await sleep(delay);
      
      // Trigger a retry by sending a follow-up message
      // This causes the agent to retry the last user prompt
      const branch = ctx.sessionManager.getBranch();
      const lastUserMsg = branch
        .slice()
        .reverse()
        .find(e => e.type === "message" && e.message?.role === "user");
      
      if (lastUserMsg && lastUserMsg.type === "message" && isUserMessageWithContent(lastUserMsg.message)) {
        const userText = extractTextContent(lastUserMsg.message.content);
        
        if (userText) {
          // Re-send the last user message to trigger a retry
          pi.sendUserMessage(userText, { deliverAs: "followUp" });
          ctx.ui.notify("Retry triggered", "info");
        }
      }
      
      isCustomRetrying = false;
    } else {
      ctx.ui.notify(`Max retries (${MAX_CUSTOM_RETRIES}) exceeded`, "error");
      ctx.ui.setStatus("retry-400-413", "Failed - max retries exceeded");
      customRetryAttempt = 0;
      isCustomRetrying = false;
    }
  });

  // Alternative: Handle via message_end for more granular control
  pi.on("message_end", async (event, ctx) => {
    const msg = event.message;
    if (msg.role === "assistant" && 
        msg.stopReason === "error" && 
        has400or413Error(msg)) {
      
      // Could modify the error message or add context here
      ctx.ui.setStatus("retry-ext", "400/413 detected - handling...");
      
      // Clear status after a moment
      setTimeout(() => ctx.ui.setStatus("retry-ext", undefined), 5000);
    }
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

      ctx.ui.notify("Manually retrying (no compaction)...", "info");
      
      // Reset attempt counter and trigger immediate retry
      customRetryAttempt = 0;
      
      // Find last user message and resend it
      const branch = ctx.sessionManager.getBranch();
      const lastUserMsg = branch
        .slice()
        .reverse()
        .find(e => e.type === "message" && e.message?.role === "user");
      
      if (lastUserMsg && lastUserMsg.type === "message" && isUserMessageWithContent(lastUserMsg.message)) {
        const userText = extractTextContent(lastUserMsg.message.content);
        
        if (userText) {
          pi.sendUserMessage(userText, { deliverAs: "followUp" });
        }
      }
    }
  });

  // Register a command to configure retry settings
  pi.registerCommand("retry-config", {
    description: "Show/configure 400/413 retry settings",
    handler: async (args, ctx) => {
      if (args.includes("reset")) {
        customRetryAttempt = 0;
        ctx.ui.notify("Retry counter reset", "info");
        return;
      }
      
      ctx.ui.notify(
        `Max retries: ${MAX_CUSTOM_RETRIES}, Base delay: ${CUSTOM_RETRY_DELAY_MS}ms, Current attempt: ${customRetryAttempt}`,
        "info"
      );
    }
  });

  // Initialize
  pi.on("session_start", async () => {
    customRetryAttempt = 0;
  });
}
