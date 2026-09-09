import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CONTINUATION_CUSTOM_TYPE,
  getErrorCategory,
  getLastAssistantMessage,
  hasEmptyStop,
  hasMaxTokensStop,
  hasQuotaExhaustedError,
  hasRetryableError,
  isAssistantMessage,
  isContextOverflowError,
  isNonRetryableError,
  isSilencedError,
  RETRY_TRIGGER_CUSTOM_TYPE,
} from "./error-patterns.js";
import {
  calculateDelay,
  ContinuationState,
  formatDuration,
  RetryState,
} from "./retry-logic.js";
import type { PiRetrySubagentsConfig } from "./config.js";

/** The hidden turn kinds that can continue an owned child prompt. */
export type ChildHiddenTurnKind = "retry" | "continue" | "empty";

/** Retry state grouped by the category shown in child diagnostics. */
export interface ChildRetryStatus {
  /** Number of ordinary retries scheduled for this child. */
  attempt: number;
  /** Whether a backoff is currently active. */
  isRetrying: boolean;
  /** Most recent category-specific error text. */
  lastError: string;
}

/**
 * Owns retry scheduling for one session selected by the child-policy matcher.
 *
 * The controller deliberately runs one backoff inside the SDK's awaited
 * `agent_end` event. That keeps AgentSession.prompt() pending; after the
 * hidden follow-up is queued, AgentSession's own post-run loop continues the
 * same transcript and retains completed tool results.
 */
export class ChildRetryController {
  /** Extension API bound to this exact child session. */
  private readonly pi: ExtensionAPI;
  /** Agent whose transcript and queue belong to this selected session. */
  private readonly agent: Agent;
  /** Stable policy resolved for this child at session startup. */
  private readonly config: PiRetrySubagentsConfig;
  /** Per-category diagnostics retained for `/retry status`. */
  private readonly states: Record<string, RetryState> = {
    "400-413": new RetryState(),
    credit: new RetryState(),
    connection: new RetryState(),
    other: new RetryState(),
  };
  /** Max-token continuation counter retained across its hidden turns. */
  private readonly continuationState = new ContinuationState();
  /** Empty-stop continuation counter, bounded to one nudge. */
  private emptyNudges = 0;
  /** Number of ordinary attempts whose delay reached the configured cap. */
  private maxDelayRetries = 0;
  /** Number of ordinary retry turns scheduled from this original prompt. */
  private retryAttempt = 0;
  /** Prevents duplicate scheduling if an event and manual command race. */
  private driving = false;
  /** Monotonic cancellation generation for this child prompt. */
  private generation = 0;
  /** Session-wide cancellation source for shutdown and explicit abort. */
  private cancellation = new AbortController();
  /** True after child shutdown or controller disposal. */
  private closed = false;
  /** Active lifecycle id, if a retry sequence has started. */
  private lifecycleId: number | undefined;
  /** Locally monotonic lifecycle id source. */
  private nextLifecycleId = 0;

  /**
   * Create the controller for one exact AgentSession identity.
   *
   * @param pi Session-bound extension API used to queue hidden turns.
   * @param agent Session-bound Agent used to remove only the failed response.
   * @param config Effective child retry policy.
   */
  public constructor(
    pi: ExtensionAPI,
    agent: Agent,
    config: PiRetrySubagentsConfig,
  ) {
    this.pi = pi;
    this.agent = agent;
    this.config = config;
  }

  /**
   * Inspect one awaited child agent_end event and schedule its next turn.
   *
   * @param ctx SDK context carrying the current abort signal and diagnostics UI.
   * @returns A promise that settles after one backoff and queue operation.
   */
  public async handleAgentEnd(ctx: ExtensionContext): Promise<void> {
    if (this.closed) return;
    if (ctx.signal?.aborted) {
      this.cancel("Agent operation aborted.");
      return;
    }

    const lastAssistant = getLastAssistantMessage(ctx.sessionManager.getEntries());
    if (!lastAssistant || !isAssistantMessage(lastAssistant)) return;
    if (this.driving) return;

    // Compaction owns context overflow. The child controller must not queue a
    // same-context retry that races the SDK's compaction recovery.
    if (isContextOverflowError(lastAssistant)) {
      this.notify(ctx, "Context overflow - deferring to compaction.", "info");
      return;
    }

    if (hasMaxTokensStop(lastAssistant)) {
      if (this.continuationState.getIsContinuing()) return;
      this.continuationState.startContinuation();
      this.notify(
        ctx,
        `Max tokens reached - auto-continuing (continuation ${this.continuationState.getCount()})...`,
        "info",
      );
      await this.schedule("continue", ctx);
      this.continuationState.endContinuation();
      return;
    }

    if (hasEmptyStop(lastAssistant)) {
      if (this.emptyNudges >= 1) {
        this.notify(
          ctx,
          "Empty response after one continuation - giving up.",
          "warning",
        );
        this.finishLifecycle(false);
        return;
      }
      this.notify(ctx, "Empty response - nudging once...", "info");
      await this.schedule("empty", ctx);
      return;
    }

    // Re-evaluate permanent and quota errors for every attempt, including a
    // provider that changes its error category after a transient failure.
    if (isNonRetryableError(lastAssistant)) {
      const errorMsg = lastAssistant.errorMessage || "Unknown error";
      if (!isSilencedError(lastAssistant)) {
        this.notify(
          ctx,
          hasQuotaExhaustedError(lastAssistant)
            ? `Quota/limit exhausted - not retrying: ${errorMsg.substring(0, 100)}`
            : `Non-retryable error (not retried): ${errorMsg.substring(0, 100)}`,
          "warning",
        );
      }
      this.finishLifecycle(false);
      return;
    }

    if (!hasRetryableError(lastAssistant)) return;

    const errorMsg = lastAssistant.errorMessage || "Unknown error";
    const category = getErrorCategory(errorMsg);
    const state = this.states[category] ?? this.states.other;
    if (state.getIsRetrying()) return;
    state.startRetry(errorMsg);
    try {
      await this.schedule("retry", ctx);
    } finally {
      state.endRetry();
    }
  }

  /**
   * Observe a completed turn and close or reset the child sequence.
   *
   * @param event SDK turn event carrying the assistant response.
   * @param ctx SDK context carrying the current abort signal.
   */
  public handleTurnEnd(
    event: { message: unknown },
    ctx: ExtensionContext,
  ): void {
    const message = event.message as {
      role?: string;
      stopReason?: string;
    };
    if (
      ctx.signal?.aborted ||
      (message.role === "assistant" && message.stopReason === "aborted")
    ) {
      this.cancel("Agent operation aborted.");
      return;
    }
    if (
      message.role !== "assistant" ||
      message.stopReason === "error" ||
      message.stopReason === "length" ||
      hasEmptyStop(event.message as AgentMessage)
    ) {
      return;
    }

    this.resetCounters();
    this.finishLifecycle(true);
  }

  /**
   * Cancel an active child backoff when fresh user input arrives.
   */
  public handleInput(): void {
    if (this.closed) return;
    this.generation++;
    this.cancellation.abort("Fresh user input superseded the retry.");
    this.driving = false;
    this.finishLifecycle(false);
    this.cancellation = new AbortController();
  }

  /**
   * Cancel the current child sequence without affecting any other session.
   *
   * @param reason Human-readable cancellation reason for diagnostics.
   */
  public cancel(reason: string): void {
    if (this.closed) return;
    this.generation++;
    this.cancellation.abort(reason);
    this.driving = false;
    this.finishLifecycle(false);
  }

  /**
   * Shut down the controller and release its session-local ownership.
   */
  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.generation++;
    this.cancellation.abort("Child session shut down.");
    this.driving = false;
    this.finishLifecycle(false);
  }

  /**
   * Reset all counters for an explicit `/retry reset` command.
   */
  public reset(): void {
    this.generation++;
    this.cancellation.abort("Retry state reset.");
    this.cancellation = new AbortController();
    for (const state of Object.values(this.states)) state.reset();
    this.continuationState.reset();
    this.emptyNudges = 0;
    this.maxDelayRetries = 0;
    this.retryAttempt = 0;
    this.finishLifecycle(false);
  }

  /**
   * Return category counters for the status command.
   *
   * @returns Snapshot of category-specific child retry state.
   */
  public status(): Record<string, ChildRetryStatus> {
    return Object.fromEntries(
      Object.entries(this.states).map(([category, state]) => [category, {
        attempt: state.getAttempt(),
        isRetrying: state.getIsRetrying(),
        lastError: state.getLastErrorMessage(),
      }]),
    );
  }

  /**
   * Queue exactly one hidden continuation after an abortable backoff.
   *
   * @param kind Type of hidden turn to queue.
   * @param ctx SDK context with the active run signal.
   */
  private async schedule(
    kind: ChildHiddenTurnKind,
    ctx: ExtensionContext,
  ): Promise<void> {
    if (this.closed || this.driving) return;
    this.driving = true;
    const generation = this.generation;
    if (this.lifecycleId === undefined) {
      this.lifecycleId = ++this.nextLifecycleId;
      this.emitLifecycle("pi-retry:started", this.lifecycleId);
    }

    try {
      if (kind === "empty") {
        this.emptyNudges++;
      }
      if (kind === "retry") {
        this.retryAttempt++;
      }
      if (kind === "retry" && this.maxDelayRetries >= this.config.maxRetriesAtMaxDelay) {
        this.notify(
          ctx,
          `Retry failed ${this.config.maxRetriesAtMaxDelay} times at the maximum backoff; giving up.`,
          "warning",
        );
        return;
      }
      const attempt = kind === "retry" ? this.retryAttempt : this.retryAttempt + 1;
      const delay = calculateDelay(attempt, this.config);
      if (kind === "retry" && delay >= this.config.maxDelayMs) {
        this.maxDelayRetries++;
      }

      // Removing only a trailing error mirrors SDK native retry and preserves
      // every preceding assistant tool call and tool result in the transcript.
      if (kind === "retry") this.removeErrorFromAgentState();
      this.notify(ctx, `Retry attempt ${attempt} (backoff ${formatDuration(delay)})...`, "info");
      const ready = await this.waitForBackoff(delay, ctx.signal, generation);
      if (!ready || this.closed || generation !== this.generation) return;

      this.pi.sendMessage(
        {
          customType: kind === "retry"
            ? RETRY_TRIGGER_CUSTOM_TYPE
            : CONTINUATION_CUSTOM_TYPE,
          content: kind === "retry"
            ? "Retry the previous request."
            : kind === "empty"
              ? "Your previous turn contained only thinking and no answer or text. Continue now and produce the actual response, using tools if needed."
              : "Continue exactly where you left off without repeating content.",
          display: false,
          details: undefined,
        },
        { triggerTurn: true, deliverAs: kind === "retry" ? "steer" : "followUp" },
      );
    } catch {
      this.finishLifecycle(false);
    } finally {
      this.driving = false;
    }
  }

  /**
   * Wait for backoff while listening to both SDK abort and session shutdown.
   *
   * @param delayMs Delay to await.
   * @param signal Active SDK run signal, if any.
   * @param generation Generation captured before waiting.
   * @returns False when cancellation or session replacement interrupted wait.
   */
  private waitForBackoff(
    delayMs: number,
    signal: AbortSignal | undefined,
    generation: number,
  ): Promise<boolean> {
    if (
      delayMs <= 0 &&
      !signal?.aborted &&
      !this.cancellation.signal.aborted &&
      generation === this.generation
    ) {
      return Promise.resolve(true);
    }
    return new Promise(resolve => {
      let settled = false;
      const timer = setTimeout(() => finish(true), Math.max(0, delayMs));
      const finish = (ready: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.cancellation.signal.removeEventListener("abort", onAbort);
        resolve(ready && generation === this.generation && !this.closed);
      };
      const onAbort = (): void => finish(false);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.cancellation.signal.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted || this.cancellation.signal.aborted) finish(false);
    });
  }

  /**
   * Remove only an error assistant response from this child's live state.
   */
  private removeErrorFromAgentState(): void {
    const messages = this.agent.state.messages;
    const last = messages[messages.length - 1];
    if (last?.role === "assistant" && last.stopReason === "error") {
      this.agent.state.messages = messages.slice(0, -1);
    }
  }

  /**
   * Reset retry counters after a successful terminal assistant response.
   */
  private resetCounters(): void {
    for (const state of Object.values(this.states)) state.succeed();
    this.continuationState.complete();
    this.emptyNudges = 0;
    this.maxDelayRetries = 0;
    this.retryAttempt = 0;
  }

  /**
   * Emit one lifecycle event while containing stale-session event-bus errors.
   *
   * @param event Lifecycle event name.
   * @param retryId Session-local lifecycle id.
   */
  private emitLifecycle(event: string, retryId: number): void {
    try {
      this.pi.events.emit(event, { retryId });
    } catch {
      // Shutdown can invalidate the bus while an awaited agent_end unwinds.
    }
  }

  /**
   * Finish the current lifecycle exactly once.
   *
   * @param completed Whether the child produced a successful terminal turn.
   */
  private finishLifecycle(completed: boolean): void {
    if (this.lifecycleId === undefined) return;
    const retryId = this.lifecycleId;
    this.lifecycleId = undefined;
    this.emitLifecycle(
      completed ? "pi-retry:completed" : "pi-retry:cancelled",
      retryId,
    );
  }

  /**
   * Send a diagnostic notification through the current child context.
   *
   * @param ctx SDK context used for UI output.
   * @param message User-facing diagnostic text.
   * @param level Notification severity.
   */
  private notify(
    ctx: ExtensionContext,
    message: string,
    level: "info" | "warning" | "error",
  ): void {
    try {
      ctx.ui.notify(message, level);
    } catch {
      // Headless/closing child UIs are advisory and must not break retries.
    }
  }
}
