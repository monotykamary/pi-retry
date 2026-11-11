import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AgentBeforeSettleEvent,
  BoundaryResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
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
  isPermanentError,
  isSilencedError,
  RETRY_TRIGGER_CUSTOM_TYPE,
} from "./error-patterns.js";
import {
  appendRetryInstructions,
  calculateDelay,
  ContinuationState,
  formatRetryCountdown,
  RETRY_STATUS_KEY,
  RetryState,
} from "./retry-logic.js";
import type { PiRetrySubagentsConfig } from "./config.js";
import { removeErrorFromRetryContext } from "./session-registry.js";

/** The hidden turn kinds that can continue an owned child prompt. */
export type ChildHiddenTurnKind = "retry" | "continue" | "empty";

/** Options used only for an explicitly requested child retry. */
interface ChildManualRetryOptions {
  /** Override the first backoff when a separate timer has already elapsed. */
  initialDelayMs?: number;
  /** Permit one explicit attempt after a quota or usage-limit error. */
  allowQuota?: boolean;
  /** Optional instructions to include in the first hidden retry. */
  additionalPrompt?: string;
}

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
 *
 * With `messageFreeRetries`, an automatic error retry queues no message: the
 * same backoff ends by arming the `agent_before_settle` boundary, which omits
 * the failed response with a durable `context_edit` and requests one
 * continuation of the unchanged context.
 *
 * TEST:__tests__/unit/child-retry.test.ts[ChildRetryController retry lifecycle]
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
  /** Promise for the schedule currently awaiting its abortable backoff. */
  private activeSchedule: Promise<void> | undefined;
  /** Generation that currently owns the driving flag. */
  private drivingGeneration: number | undefined;
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
  /** Generation of an error retry waiting for the settle boundary. */
  private pendingBoundaryRetry: number | undefined;

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
   * @param manual True for a manual retry, which runs outside an agent run.
   * @param options Optional first-delay, quota and instruction overrides for an explicit retry.
   * @returns A promise that settles after one backoff and queue operation.
   *
   * TEST:__tests__/unit/retry-after.test.ts[inline retry]
   */
  public async handleAgentEnd(
    ctx: ExtensionContext,
    manual = false,
    options?: ChildManualRetryOptions,
  ): Promise<void> {
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
      this.resetCounters();
      this.finishLifecycle(false);
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
      await this.schedule("continue", ctx, manual, options?.initialDelayMs, options?.additionalPrompt);
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
        this.resetCounters();
        this.finishLifecycle(false);
        return;
      }
      this.notify(ctx, "Empty response - nudging once...", "info");
      await this.schedule("empty", ctx, manual, options?.initialDelayMs, options?.additionalPrompt);
      return;
    }

    // A scheduled manual retry may try a quota error once after its reset
    // window; later automatic attempts still enforce the normal blacklist.
    const retryQuota = manual && options?.allowQuota === true &&
      hasQuotaExhaustedError(lastAssistant) && !isPermanentError(lastAssistant);
    // Re-evaluate permanent and quota errors for every automatic attempt.
    if (isNonRetryableError(lastAssistant) && !retryQuota) {
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
      this.resetCounters();
      this.finishLifecycle(false);
      return;
    }

    if (!hasRetryableError(lastAssistant) && !retryQuota) return;

    const errorMsg = lastAssistant.errorMessage || "Unknown error";
    const category = getErrorCategory(errorMsg);
    const state = this.states[category] ?? this.states.other;
    if (state.getIsRetrying()) return;
    state.startRetry(errorMsg);
    try {
      await this.schedule("retry", ctx, manual, options?.initialDelayMs, options?.additionalPrompt);
    } finally {
      state.endRetry();
    }
  }

  /**
   * Observe a completed turn and close or reset the child sequence.
   *
   * @param event SDK turn event carrying the assistant response.
   * @param ctx SDK context carrying the current abort signal.
   *
   * TEST:__tests__/unit/child-retry.test.ts[tool success resets retry backoff]
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
   *
   * TEST:__tests__/unit/child-retry.test.ts[fresh input resets retry backoff]
   */
  public handleInput(): void {
    if (this.closed) return;
    this.pendingBoundaryRetry = undefined;
    this.generation++;
    this.cancellation.abort("Fresh user input superseded the retry.");
    this.resetCounters();
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
    this.pendingBoundaryRetry = undefined;
    this.generation++;
    this.cancellation.abort(reason);
    this.resetCounters();
    this.finishLifecycle(false);
  }

  /**
   * Shut down the controller and release its session-local ownership.
   */
  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pendingBoundaryRetry = undefined;
    this.generation++;
    this.cancellation.abort("Child session shut down.");
    this.resetCounters();
    this.finishLifecycle(false);
  }

  /**
   * Reset all counters for an explicit `/retry reset` command.
   */
  public reset(): void {
    this.pendingBoundaryRetry = undefined;
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
   * @param manual Whether this schedule was explicitly requested.
   * @param initialDelayMs Optional override for the first backoff.
   * @param additionalPrompt Optional instructions for the first hidden turn.
   * @returns A promise that settles after the schedule finishes.
   *
   * TEST:__tests__/unit/retry-after.test.ts[additional prompt]
   */
  private async schedule(
    kind: ChildHiddenTurnKind,
    ctx: ExtensionContext,
    manual = false,
    initialDelayMs?: number,
    additionalPrompt?: string,
  ): Promise<void> {
    if (this.closed || this.driving) return;
    const scheduled = this.runSchedule(kind, ctx, manual, initialDelayMs, additionalPrompt);
    this.activeSchedule = scheduled;
    try {
      await scheduled;
    } finally {
      if (this.activeSchedule === scheduled) this.activeSchedule = undefined;
    }
  }

  /**
   * Run one child backoff and queue operation while owning the drive token.
   *
   * @param kind Type of hidden turn to queue.
   * @param ctx SDK context with the active run signal.
   * @param manual True when no agent run is active to reach the settle boundary.
   * @param initialDelayMs Optional override for the first backoff.
   * @param additionalPrompt Optional instructions for the first hidden turn.
   * @returns A promise that settles after the retry is queued or cancelled.
   *
   * TEST:__tests__/unit/retry-after.test.ts[additional prompt]
   */
  private async runSchedule(
    kind: ChildHiddenTurnKind,
    ctx: ExtensionContext,
    manual: boolean,
    initialDelayMs?: number,
    additionalPrompt?: string,
  ): Promise<void> {
    this.driving = true;
    const generation = this.generation;
    this.drivingGeneration = generation;
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
        this.resetCounters();
        this.finishLifecycle(false);
        return;
      }
      const attempt = kind === "retry" ? this.retryAttempt : this.retryAttempt + 1;
      const delay = initialDelayMs ?? calculateDelay(attempt, this.config);
      if (kind === "retry" && delay >= this.config.maxDelayMs) {
        this.maxDelayRetries++;
      }

      // An automatic error retry can continue the active run without a message;
      // a manual retry starts from idle, where only a queued message can.
      const messageFree = kind === "retry" && !manual && this.config.messageFreeRetries === true;
      // Remove the failed response from Pi's canonical projection before retrying.
      // The helper keeps raw history intact on newer SDKs and falls back to the
      // live Agent state on older versions. The message-free path omits it
      // durably at the settle boundary instead.
      if (kind === "retry" && !messageFree) {
        removeErrorFromRetryContext(ctx.sessionManager, this.agent);
      }
      // The wait helper emits the initial frame and replaces it every 100ms
      // instead of adding a new retry notification line.
      const ready = await this.waitForBackoff(
        delay,
        ctx.signal,
        generation,
        remainingMs => this.updateRetryStatus(ctx, attempt, remainingMs),
      );
      this.clearRetryStatus(ctx);
      if (!ready || this.closed || generation !== this.generation) return;

      if (messageFree) {
        this.pendingBoundaryRetry = generation;
        return;
      }

      this.pi.sendMessage(
        {
          customType: kind === "retry"
            ? RETRY_TRIGGER_CUSTOM_TYPE
            : CONTINUATION_CUSTOM_TYPE,
          content: appendRetryInstructions(
            kind === "retry"
              ? "Retry the previous request."
              : kind === "empty"
                ? "Your previous turn contained only thinking and no answer or text. Continue now and produce the actual response, using tools if needed."
                : "Continue exactly where you left off without repeating content.",
            additionalPrompt,
          ),
          display: false,
          details: undefined,
        },
        { triggerTurn: true, deliverAs: kind === "retry" ? "steer" : "followUp" },
      );
    } catch {
      this.resetCounters();
      this.finishLifecycle(false);
    } finally {
      // Clear the mutable status row on cancellation, failure, and success so
      // a completed child prompt never leaves an old countdown visible.
      this.clearRetryStatus(ctx);
      if (this.drivingGeneration === generation) {
        this.driving = false;
        this.drivingGeneration = undefined;
      }
    }
  }

  /**
   * Start a manual retry as a new lifecycle, cancelling any automatic backoff first.
   *
   * @param ctx SDK context carrying the current error and abort signal.
   * @param options Optional first-delay, quota and instruction overrides for an explicit retry.
   * @returns A promise that settles after the manual schedule has been queued.
   *
   * TEST:__tests__/unit/child-retry.test.ts[manual retry after cap, manual retry cancels active backoff]
   * TEST:__tests__/unit/retry-after.test.ts[inline retry]
   */
  public async retryManually(ctx: ExtensionContext, options?: ChildManualRetryOptions): Promise<void> {
    if (this.closed) return;
    const activeSchedule = this.activeSchedule;
    this.reset();
    if (activeSchedule) await activeSchedule;
    if (this.closed) return;
    await this.handleAgentEnd(ctx, true, options);
  }

  /**
   * Fulfil an armed message-free retry at the final settle boundary.
   *
   * The failed response is omitted with a durable `context_edit` (it stays in
   * the raw session history) and Pi continues the unchanged context once. A
   * stale arm is dropped unless the projected context still ends with an error.
   *
   * @param event SDK boundary event with the projected context and drafts.
   * @returns Boundary result chaining earlier drafts, or undefined to pass.
   *
   * TEST:__tests__/integration/native-child-lifecycle.test.ts[message-free retries]
   */
  public handleBeforeSettle(event: AgentBeforeSettleEvent): BoundaryResult | undefined {
    const armed = this.pendingBoundaryRetry;
    this.pendingBoundaryRetry = undefined;
    if (this.closed || armed === undefined || armed !== this.generation) return undefined;

    const entries = event.context?.contextEntries ?? [];
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      if (!entry || entry.messages.length === 0) continue;
      const last = entry.messages[entry.messages.length - 1] as {
        role?: string;
        stopReason?: string;
      };
      if (last.role !== "assistant" || last.stopReason !== "error") break;
      return {
        entries: [
          ...(event.entries ?? []),
          { type: "context_edit", targetId: entry.sourceEntry.id, replacement: null },
        ],
        continue: true,
      };
    }
    // The armed retry cannot run; close its lifecycle like any other cancel.
    this.finishLifecycle(false);
    return undefined;
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
    onRemaining?: (remainingMs: number) => void,
  ): Promise<boolean> {
    if (
      delayMs <= 0 &&
      !signal?.aborted &&
      !this.cancellation.signal.aborted &&
      generation === this.generation
    ) {
      onRemaining?.(0);
      return Promise.resolve(true);
    }
    return new Promise(resolve => {
      let settled = false;
      let elapsed = 0;
      const checkInterval = 100;
      const timer = setTimeout(() => finish(true), Math.max(0, delayMs));
      const countdownTimer = setInterval(() => {
        elapsed += checkInterval;
        onRemaining?.(Math.max(0, delayMs - elapsed));
      }, checkInterval);
      const finish = (ready: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(countdownTimer);
        signal?.removeEventListener("abort", onAbort);
        this.cancellation.signal.removeEventListener("abort", onAbort);
        resolve(ready && generation === this.generation && !this.closed);
      };
      const onAbort = (): void => finish(false);
      onRemaining?.(Math.max(0, delayMs));
      signal?.addEventListener("abort", onAbort, { once: true });
      this.cancellation.signal.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted || this.cancellation.signal.aborted) finish(false);
    });
  }

  /**
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
   * Replace the child retry countdown in one footer/status row.
   *
   * @param ctx SDK context used for UI output.
   * @param attempt Ordinary retry attempt number.
   * @param remainingMs Milliseconds remaining before the hidden turn.
   */
  private updateRetryStatus(
    ctx: ExtensionContext,
    attempt: number,
    remainingMs: number,
  ): void {
    if (typeof ctx.ui.setStatus !== "function") return;
    try {
      ctx.ui.setStatus(
        RETRY_STATUS_KEY,
        formatRetryCountdown(attempt, remainingMs),
      );
    } catch {
      // Headless or closing child UIs are advisory and must not break retries.
    }
  }

  /**
   * Remove the child retry countdown from the footer/status row.
   *
   * @param ctx SDK context used for UI output.
   */
  private clearRetryStatus(ctx: ExtensionContext): void {
    if (typeof ctx.ui.setStatus !== "function") return;
    try {
      ctx.ui.setStatus(RETRY_STATUS_KEY, undefined);
    } catch {
      // Headless or closing child UIs are advisory and must not break retries.
    }
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
