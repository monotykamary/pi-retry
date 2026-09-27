<div align="center">

# 🔄 pi-retry

**Automatic retry for every error in [pi](https://github.com/earendil-works/pi-coding-agent)**

_400/413, connection errors, credit errors, stream exhaustion — retry them all through pi's native retry seam, with zero injected messages._

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

---

---

## Overview

This extension automatically detects and retries **all** errors by default, with only a tiny blacklist of known permanent failures (invalid API key, missing model, etc.).

| Error Type | Retry Behavior | Use Case |
|------------|----------------|----------|
| **Any retryable error** (catch-all) | **Capped exponential retry** | Everything else — provider hiccups, stream exhaustion, credit issues, unknown errors |
| HTTP 400/413 | **Capped** with exponential backoff, NO compaction | Transient context overflow that might resolve |
| Credit / payment errors | **Capped** with exponential backoff | "Not Enough Credits", insufficient balance, 402 — top up and the retry loop auto-resumes |
| **Quota / session-limit / budget exhaustion** | **Not retried** — notify + stop | "You've hit your limit", `insufficient_quota`, "out of budget", suspended accounts |
| Connection errors | **Capped** with exponential backoff | Network hiccups, connection drops, socket errors, stream exhaustion |

> **Breaking change in 0.11.0:** retries are no longer driven by injected hidden
> messages. pi-retry now delegates to pi's native retry seam, and the
> max-tokens auto-continue and empty-stop nudge features were **removed** (see
> [Removed features](#removed-features)). All `piRetry` configuration keys
> remain valid with unchanged semantics.

---

## The Problem

By default, pi has built-in retry for some errors (rate limits, 5xx, overloaded), but:

1. **400/413 errors** are treated as context overflow → triggers compaction but NO retry
2. **Connection errors** sometimes get only limited retries before giving up
3. **Credit errors** ("Not Enough Credits") are never retried
4. **Stream exhaustion** ("Max outbound streams") and other provider-specific errors are never retried
5. **Any unknown error** from a new provider is silently ignored

## The Solution

This extension provides automatic retry for all errors with configurable exponential backoff and a maximum-delay failure limit (2s → 4s → 8s → ... → 60s by default) — **driven entirely through pi's native retry seam, with zero injected messages**.

**Philosophy: retry EVERYTHING by default.** The only things we skip are a tiny blacklist of known permanent failures (invalid API key, model not found, unsupported model, etc.).

**Features:**
- **Catch-all retry** — Any `stopReason: "error"` is retried, regardless of error message
- Automatic detection of 400/413, connection, credit, and stream exhaustion errors
- **Message-free retries** — pi's native seam durably pops the failed attempt from model context and continues with identical context; nothing is added to your session
- **Retry cutoff** — Keeps retrying until success, abort, or the configured number of failures at the maximum delay
- **Auto-stop on quota/budget exhaustion** — Session limits, plan quotas, and budget caps ("You've hit your limit", "out of budget", `insufficient_quota`, suspended accounts) are detected and **not** retried, with a notification explaining why
- Exponential backoff with configurable base delay, cap, multiplier, and maximum-delay failure count
- **Native TUI for free** — pi's own countdown indicator, `esc`-to-cancel, and `willRetry` annotation ride along
- Manual controls via the merged `/retry` command (`/continue` alias)
- Non-retryable errors are explicitly logged so you know why we didn't retry

## Removed features (0.11.0)

Two behaviors from earlier versions are gone:

- **Max-tokens auto-continue** (`stopReason: "length"`)
- **Empty / think-only stop nudge** (`stopReason: "stop"` with no usable output)

Why: both mechanisms worked by injecting a hidden user turn after an
assistant-final context. `Agent.continue()` — the only message-free
continuation path in pi — refuses assistant-final context, so these cases
cannot be handled without re-injecting messages, which this extension no
longer does. If a turn ends truncated or empty, use `/retry` from a user/tool
boundary or simply type a follow-up message.

---

## Installation

### Option 1: Install via pi package (Recommended)

Install directly from GitHub as a pi package:

```bash
pi install https://github.com/monotykamary/pi-retry
```

Or add to your `settings.json`:

```json
{
  "packages": [
    "https://github.com/monotykamary/pi-retry"
  ]
}
```

### Option 2: Global Installation

Copy the extension to pi's global extensions directory:

```bash
cp retry.ts ~/.pi/agent/extensions/
```

### Option 3: Project-Local Installation

Copy to your project's `.pi/extensions/` directory:

```bash
mkdir -p .pi/extensions
cp retry.ts .pi/extensions/
```

### Option 4: Quick Test

```bash
pi -e ./retry.ts
```

---

## Usage

Once loaded, the extension **automatically** detects and retries all errors.

### Manual Controls

| Command | Description |
|---------|-------------|
| `/retry` (or `/continue`) | Message-free continue: pops a trailing error assistant message durably and continues with identical context; continues directly when context already ends at a user/tool boundary. Explicit intent — bypasses the classifier and the failure cap |
| `/retry status` | Show current retry diagnostics: per-category counters, config, last error classification, native retry attempt |
| `/retry reset` | Reset pi-retry's per-category counters and failure cap |

Note: continuing directly from an assistant message is refused — rewind to a
user/tool boundary or type a message instead. For context overflow, use
`/compact`.

---

## Configuration

The extension reads a `piRetry` object from Pi's settings files:

- `~/.pi/agent/settings.json` applies globally.
- `.pi/settings.json` overrides matching global values for the current project.

```json
{
  "piRetry": {
    "baseDelayMs": 10000,
    "maxDelayMs": 3600000,
    "multiplier": 2,
    "maxRetriesAtMaxDelay": 3
  }
}
```

The example above waits 10 seconds before the first retry, doubles each delay, caps the delay at one hour, and stops after three failed retries at that cap. Supported values are:

| Setting | Default | Description |
|---------|---------|-------------|
| `baseDelayMs` | `2000` | Delay before the first retry, in milliseconds |
| `maxDelayMs` | `60000` | Maximum delay between retries, in milliseconds |
| `multiplier` | `2` | Exponential backoff multiplier; must be at least `1` |
| `maxRetriesAtMaxDelay` | `3` | Failed ordinary retries allowed after the delay reaches `maxDelayMs` |

`piRetry` is separate from Pi's built-in `retry` object so the two retry policies do not share ambiguous settings. pi-retry does not run its own retry loop; it steers pi's native retry scheduler (see [How It Works](#how-it-works)).

`multiplier` is honored exactly as before: pi's native schedule doubles the
delay each attempt (`baseDelayMs * 2^(N-1)`), so pi-retry compensates the base
per attempt (`base * (multiplier/2)^(N-1)`, clamped to `maxDelayMs`) to land on
`baseDelayMs * multiplier^(N-1)`. With the default `multiplier: 2` the
schedule is identical to plain doubling.

Settings are read when the extension starts. Restart pi or use `/reload` after editing them.

---

## How It Works

pi-retry installs three narrow wraps on pi's `AgentSession` prototype and then
lets **pi's native retry machinery do the work**:

1. **`bindExtensions`** — snapshots each session's manager/agent identity into a
   process-wide registry so policy can be bound per session (main or child).
2. **`_isRetryableError`** — extends native classification with pi-retry's
   broader pattern set (400/413, credit, connection, catch-all). Context
   overflow still returns `false` so pi's compaction recovery path stays
   authoritative, and the quota/billing blacklist still wins.
3. **`_prepareRetry`** — vetoes retries once a category has scheduled
   `maxRetriesAtMaxDelay` attempts whose delay reached `maxDelayMs`, then
   injects pi-retry's backoff settings for the delegated attempt and lets the
   native method run.

Native `_prepareRetry` then does everything message-free:

- durably pops the failed assistant attempt from the model projection
  (`context_edit` on pi 0.87+, live-state removal on 0.86), so retries resend
  **identical context** with zero injected turns
- sleeps with abortable exponential backoff (`esc` cancels)
- emits `auto_retry_start` / `auto_retry_end` — pi's TUI renders its own
  countdown indicator from these events
- keeps `session.isStreaming` true during backoff, so concurrent user input
  queues as steer/follow-up instead of colliding with the retry

Because the seam is a prototype patch, it applies automatically to every
`AgentSession` in the process — the main TUI session, RPC sessions, and
in-process SDK child sessions alike.

Counters reset on success, fresh user input, user abort, `/retry reset`, and
session start. Per-category counters exist for pacing the failure cap and for
`/retry status`; the attempt numbers shown by pi's native indicator are the
native unified counter.

### Lifecycle events

The legacy `pi-retry:started`, `pi-retry:completed`, and `pi-retry:cancelled`
events are still emitted on pi's shared extension event bus — now bridged from
the native `auto_retry_start` / `auto_retry_end` session events of managed
sessions, so external integrations keep working unchanged.

## Detected Error Patterns

### Catch-All (Any Error)
- **Any** assistant message with `stopReason === "error"` is retried by default
- Unknown provider errors, stream errors, unexpected failures — all handled automatically
- Only skipped if it matches a known permanent failure (invalid API key, missing model, etc.)

### Non-Retryable (Permanent Failures)
These are explicitly **not** retried:
- Invalid API key / invalid authentication
- API key not found / missing / revoked
- Model not found / unknown model / no such model / model does not exist
- Unsupported model

### Non-Retryable (Quota / Session Limit / Budget)
Exhausted quotas, session limits, and budgets are auto-detected and stop the retry loop (with an explanatory notification), because retrying is pointless until you act or the reset window passes:
- **Usage / session limits with reset windows** — "You've hit your limit · resets …" and "5-hour limit reached" (Claude Code), "You've hit your usage limit" / "You've exceeded your usage limit" (Codex), "You have hit your ChatGPT usage limit (plus plan)" (ChatGPT subscription caps via the Codex backend, also `usage_limit_reached`)
- **Plan / billing quotas** — OpenAI `insufficient_quota`, "You exceeded your current quota, please check your plan and billing details" (OpenAI, Gemini — reached only after pi's built-in 429 retry gives up)
- **Google subscription caps** — "You have exhausted your capacity on this model. Your quota will reset after …" (Gemini Code Assist), "You have reached the quota limit for …" / "You can resume using this model at …" (Antigravity)
- **Hard allotments** — OpenRouter `free-models-per-day`, Alibaba Coding Plan window quotas "hour/week/month allocated quota exceeded" and free-quota exhaustion "free allocated quota exceeded" (the bare "Allocated quota exceeded" is TPM rate limiting and stays retryable), GitHub Copilot "premium request allowance", z.ai GLM Coding Plan "Usage limit reached for 5 hour" / "no resource package"
- **Budget exhaustion** — "out of budget", "Budget has been exceeded" (LiteLLM-style proxies), max/spending/monthly limits
- **Suspended accounts** — "Your account … is suspended" (Kimi `exceeded_current_quota_error`)

Deliberate distinction: plain pay-as-you-go **balance** errors stay retryable — DeepSeek 402 "Insufficient Balance", OpenRouter 402 "Insufficient credits", Kimi "exceeded your current token quota". A mid-session top-up lets the retry loop auto-resume, whereas session limits and budgets do not self-resolve for hours.

### 400/413 Errors
- HTTP 400 Bad Request
- HTTP 413 Payload Too Large
- "bad request" messages
- "payload too large" messages

### Credit / Payment Errors
- "Not Enough Credits"
- "insufficient credits"
- "insufficient balance"
- "out of credits"
- "Payment Required"
- HTTP 402 status code

### Connection Errors
- Connection / network errors
- Fetch failures
- Socket hang up / socket errors
- `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`
- DNS lookup failures
- "Request ended without sending any chunks"
- Upstream connect errors
- TLS handshake errors
- Timeouts awaiting response
- Stream exhaustion ("Max outbound streams is 100, 100 open")
- Stream limit errors

---

## Development

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Type check
npm run typecheck

# Dead code detection
npm run lint:dead
```

### Project Structure

```
.
├── retry.ts                   # Extension factory: policy binding, /retry command, event wiring
├── src/                       # Shared utilities (testable, DRY)
│   ├── config.ts              # Settings-backed retry configuration
│   ├── error-patterns.ts      # Error pattern matching and classification
│   ├── retry-logic.ts         # Retry utilities (calculateDelay, RetryState)
│   ├── session-registry.ts    # Native-seam prototype wraps + per-session policy bindings
│   └── index.ts               # Barrel exports
├── __tests__/                 # Unit tests
│   └── unit/
├── vitest.config.ts           # Test configuration
└── knip.json                  # Dead code detection config
```

### Code Quality

```bash
# Run all quality checks
npm test
npm run typecheck     # TypeScript type checking
npm run lint:dead     # Dead code detection with knip
```

---

## Troubleshooting

### Extension not working?

Check that it's loaded in the startup header:
```
Loaded extensions: retry.ts
```

### Retry not triggering?

Use the status command to diagnose:
```
/retry status
```

### Want to see what's happening?

The extensions send notifications on retry attempts. Look at the footer status line for retry status updates. Non-retryable errors are logged as errors so you know why we stopped.

### Too many retries?

Use `/retry reset` to clear the counters, or press `Ctrl+C` to abort the session.

---

## Comparison with @georgebashi/pi-retry

The npm package `@georgebashi/pi-retry` handles "aborted" streaming errors but explicitly excludes "connection error" (assuming pi's built-in retry handles it). This extension:

1. **Handles ALL errors** via a catch-all — no more playing whack-a-mole with new error patterns
2. **Handles connection errors** that pi might not retry sufficiently
3. **Handles 400/413 errors** without compaction
4. **Handles credit errors** and stream exhaustion

They can work together for maximum coverage:

```bash
pi install npm:@georgebashi/pi-retry
# Plus install this extension
```

---

## Limitations

- Context overflow errors are not retried in place — pi's compaction recovery handles them (compact, then retry once)
- Failed attempts are omitted from the model context but remain visible in the raw session history
- May hit the same error repeatedly if the issue is persistent (use `esc` during backoff, or `Ctrl+C`, to stop)
- **Warning**: Retrying 400/413 without reducing context may fail repeatedly if the payload is genuinely too large
- Non-retryable errors (invalid API key, missing model, quota/session-limit/budget exhaustion) are logged but not retried — you'll need to fix the underlying issue, then use `/retry`
- Length-truncated and empty turns are no longer auto-continued (see [Removed features](#removed-features))

---

## Related

- [Pi Coding Agent Extensions Docs](https://github.com/badlogic/pi/tree/main/packages/coding-agent/docs/extensions.md)
- [@georgebashi/pi-retry](https://github.com/georgebashi/pi-retry) — Handles "aborted" streaming errors
- [Issue #252: Connection error with no retry](https://github.com/badlogic/pi-mono/issues/252)

## License

MIT

## Subagent retry policies

Sessions that should retry with a different policy can be selected by matching
their effective system prompt. This is user configuration: the extension ships
no built-in marker or identity check for any specific subagent tool.

```json
{
  "piRetry": {
    "subagents": {
      "enabled": true,
      "match": {
        "systemPromptRegex": [
          {
            "pattern": "^<active_agent name=\"[^\"\\r\\n]+\"/>$",
            "flags": "m"
          }
        ]
      },
      "baseDelayMs": 1000,
      "maxDelayMs": 10000,
      "maxRetriesAtMaxDelay": 2
    }
  }
}
```

Semantics:

- Sessions whose effective system prompt matches any listed rule use the
  child policy config for the same native seam; rules combine with OR.
- Omitted child fields inherit from the effective top-level policy, field by
  field. Project matcher lists replace global ones.
- A matching rule with `enabled: false` unbinds the session from pi-retry, so
  the prototype wraps delegate straight through to pi's native retry
  scheduler; a missing, empty, malformed, or nonmatching configuration keeps
  the ordinary `pi-retry` policy.
- Patterns are compiled when settings resolve. Invalid syntax, unsupported or
  duplicate flags, and malformed groups warn and become no-match instead of
  matching everything.
- The extension must also be loaded in the target session (for pi-subagents
  that means listing it in the child's `subagentOnlyExtensions`), not only in
the parent.

Because the seam is a prototype patch, child sessions driven through
`createAgentSession()` (pi-subagents style) get the same message-free retries
as the main session, with the child policy's backoff — including backoff that
keeps `session.prompt()` pending so the SDK's post-run transcript handling is
preserved.

The example pattern above matches the `<active_agent name="…"/>` line that
`pi-subagents` prefixes to native child system prompts; substitute your own
marker if you select child sessions differently.
