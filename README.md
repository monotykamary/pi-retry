<div align="center">

# 🔄 pi-retry

Unified retry extension for the [pi coding agent](https://github.com/badlogic/pi) that provides **automatic retry for every error** — 400/413, connection errors, credit errors, stream exhaustion, and anything else a provider throws at you.

</div>

---

## Overview

This extension automatically detects and retries **all** errors by default, with only a tiny blacklist of known permanent failures (invalid API key, missing model, etc.).

| Error Type | Retry Behavior | Use Case |
|------------|----------------|----------|
| **Any retryable error** (catch-all) | **Indefinite** with capped backoff | Everything else — provider hiccups, stream exhaustion, credit issues, unknown errors |
| HTTP 400/413 | **Indefinite** with capped backoff, NO compaction | Transient context overflow that might resolve |
| Credit / payment errors | **Indefinite** with capped backoff | "Not Enough Credits", insufficient balance, 402 |
| Connection errors | **Indefinite** with capped backoff | Network hiccups, connection drops, socket errors, stream exhaustion |
| Max tokens (`stopReason: "length"`) | **Auto-continue** indefinitely (invisible — no prompt pollution) | Model hits output token limit mid-generation |

---

## The Problem

By default, pi has built-in retry for some errors (rate limits, 5xx, overloaded), but:

1. **400/413 errors** are treated as context overflow → triggers compaction but NO retry
2. **Connection errors** sometimes get only limited retries before giving up
3. **Credit errors** ("Not Enough Credits") are never retried
4. **Stream exhaustion** ("Max outbound streams") and other provider-specific errors are never retried
5. **Any unknown error** from a new provider is silently ignored

## The Solution

This extension provides **automatic** infinite retry with sensible exponential backoff (2s → 4s → 8s → ... → 60s max).

**Philosophy: retry EVERYTHING by default.** The only things we skip are a tiny blacklist of known permanent failures (invalid API key, model not found, unsupported model, etc.).

**Features:**
- **Catch-all retry** — Any `stopReason: "error"` is retried, regardless of error message
- Automatic detection of 400/413, connection, credit, and stream exhaustion errors
- **Auto-continuation** when the model hits its max output tokens (`stopReason: "length"`) — indefinite, no cap, **invisible** to the LLM
- **Indefinite retry** — Keeps retrying until success
- Exponential backoff with cap: max 60s between retries
- **ALL triggers are invisible** — custom messages with `display: false`, stripped by context handler (no TUI clutter, no conversation pollution)
- Manual controls via unified `/retry` command
- Non-retryable errors are explicitly logged so you know why we didn't retry

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
| `/retry` | Manually trigger immediate retry (auto-detects: 400/413, credit, connection, max_tokens, or any other error) |
| `/retry status` | Show current retry diagnostics for all error types + continuation state |
| `/retry reset` | Reset all retry counters and state |

---

## Configuration

Edit the constants at the top of `retry.ts`:

```typescript
const BASE_DELAY_MS = 2000;        // Start with 2 seconds
const MAX_DELAY_MS = 60000;        // Cap at 60 seconds
const BACKOFF_MULTIPLIER = 2;      // Double each time
// Continuation is now invisible — no CONTINUATION_PROMPT needed
```

---

## How It Works

1. **Listen to `agent_end` event** — Fires after each agent turn completes
2. **Check for any error** — Examine the last assistant message for `stopReason === "error"`
3. **Blacklist check** — Skip known permanent failures (invalid API key, model not found, etc.)
4. **Categorize for messaging** — Classify into 400/413, credit, connection, or other for nice UI notifications
5. **Retry or continue (both invisible)** — Wait (exponential backoff for errors), then trigger a new turn via `pi.sendMessage()` with `customType`, `display: false`, and `triggerTurn: true`
6. **Context cleanup** — The `context` event strips all custom-type triggers before the LLM sees them (insurance against custom `convertToLlm` overrides)
7. **Indefinite continuation** — Max_tokens auto-continues are uncapped; each continuation produces valid output and the model naturally terminates when done

The pi's built-in `transform-messages` already strips aborted/errored assistant messages from the LLM context, so the model never sees the failed attempts.

---

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

### Max Tokens (stopReason: "length")
- The model hit its `max_tokens` / output token limit
- The model's response was truncated mid-generation
- Auto-continuation sends an invisible custom message — no visible "Continue" prompt in the conversation

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
├── retry.ts                   # Main unified extension
├── src/                       # Shared utilities (testable, DRY)
│   ├── error-patterns.ts      # Error pattern matching, custom types, hasMaxTokensStop
│   ├── retry-logic.ts         # Retry utilities (calculateDelay, RetryState, ContinuationState, etc.)
│   └── index.ts               # Barrel exports
├── __tests__/                 # Unit tests
│   └── unit/
│       ├── error-patterns.test.ts
│       └── retry-logic.test.ts
├── vitest.config.ts           # Test configuration
└── knip.json                  # Dead code detection config
```

### Code Quality

```bash
# Run all quality checks
npm test              # 99 unit tests
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

- Extensions cannot override pi's internal `isRetryableError()` check — they run *after* pi decides not to auto-retry
- Error messages remain in the session history (but are invisible to the LLM)
- May hit the same error repeatedly if the issue is persistent (use `Ctrl+C` to abort)
- **Warning**: Retrying 400/413 without reducing context may fail repeatedly if the payload is genuinely too large
- Non-retryable errors (invalid API key, missing model) are logged but not retried — you'll need to fix the underlying issue

---

## Related

- [Pi Coding Agent Extensions Docs](https://github.com/badlogic/pi/tree/main/packages/coding-agent/docs/extensions.md)
- [@georgebashi/pi-retry](https://github.com/georgebashi/pi-retry) — Handles "aborted" streaming errors
- [Issue #252: Connection error with no retry](https://github.com/badlogic/pi-mono/issues/252)

## License

MIT
