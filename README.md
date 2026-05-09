# pi-retry Extension

Unified retry extension for the [pi coding agent](https://github.com/badlogic/pi) that provides comprehensive automatic retry handling for 400/413 errors, connection errors, and max_tokens continuation.

## Overview

This extension automatically detects and retries:

| Error Type | Retry Behavior | Use Case |
|------------|----------------|----------|
| HTTP 400/413 | **Indefinite** with capped backoff, NO compaction | Transient context overflow that might resolve |
| Connection errors | **Indefinite** with capped backoff | Network hiccups, connection drops, socket errors |
| Max tokens (`stopReason: "length"`) | **Auto-continue** indefinitely (invisible — no prompt pollution) | Model hits output token limit mid-generation |

## Problem

By default, pi has built-in retry for some errors (rate limits, 5xx, overloaded), but:

1. **400/413 errors** are treated as context overflow → triggers compaction but NO retry
2. **Connection errors** sometimes get only limited retries before giving up
3. Some transient network errors aren't retried at all

## Solution

This extension provides **automatic** infinite retry with sensible exponential backoff (2s → 4s → 8s → ... → 60s max).

**Features:**
- Automatic detection of 400/413 and connection errors
- **Auto-continuation** when the model hits its max output tokens (`stopReason: "length"`) — indefinite, no cap, **invisible** to the LLM
- **Indefinite retry** — Keeps retrying until success
- Exponential backoff with cap: max 60s between retries
- **ALL triggers are invisible** — custom messages with `display: false`, stripped by context handler (no TUI clutter, no conversation pollution)
- Manual controls via unified `/retry` command

## Installation

### Option 1: Install via pi package (Recommended)

Install directly from GitHub as a pi package:

```bash
pi install git:github.com:monotykamary/pi-retry.git
```

Or add to your `settings.json`:

```json
{
  "packages": [
    "git:github.com:monotykamary/pi-retry.git"
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

## Usage

Once loaded, the extension **automatically** detects and retries both 400/413 and connection errors.

### Manual Controls

| Command | Description |
|---------|-------------|
| `/retry` | Manually trigger immediate retry (auto-detects: 400/413, connection, or max_tokens) |
| `/retry status` | Show current retry diagnostics for all error types + continuation state |
| `/retry reset` | Reset all retry counters and state |

## Configuration

Edit the constants at the top of `retry.ts`:

```typescript
const BASE_DELAY_MS = 2000;        // Start with 2 seconds
const MAX_DELAY_MS = 60000;        // Cap at 60 seconds
const BACKOFF_MULTIPLIER = 2;      // Double each time
// Continuation is now invisible — no CONTINUATION_PROMPT needed
```

## How It Works

1. **Listen to `agent_end` event** — Fires after each agent turn completes
2. **Check for error patterns or max_tokens** — Examine the last assistant message for specific error signatures or `stopReason === "length"`
3. **Retry or continue (both invisible)** — Wait (exponential backoff for errors), then trigger a new turn via `pi.sendMessage()` with `customType`, `display: false`, and `triggerTurn: true`
4. **Context cleanup** — The `context` event strips all custom-type triggers before the LLM sees them (insurance against custom `convertToLlm` overrides)
5. **Indefinite continuation** — Max_tokens auto-continues are uncapped; each continuation produces valid output and the model naturally terminates when done

The pi's built-in `transform-messages` already strips aborted/errored assistant messages from the LLM context, so the model never sees the failed attempts.

## Detected Error Patterns

**Max Tokens (stopReason: "length"):**
- The model hit its `max_tokens` / output token limit
- The model's response was truncated mid-generation
- Auto-continuation sends an invisible custom message — no visible "Continue" prompt in the conversation

**400/413 Errors:**
- HTTP 400 Bad Request
- HTTP 413 Payload Too Large
- "bad request" messages
- "payload too large" messages

**Connection Errors:**
- Connection / network errors
- Fetch failures
- Socket hang up / socket errors
- `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`
- DNS lookup failures
- "Request ended without sending any chunks"
- Upstream connect errors
- TLS handshake errors
- Timeouts awaiting response

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
npm test              # 76 unit tests
npm run typecheck     # TypeScript type checking
npm run lint:dead     # Dead code detection with knip
```

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

The extensions send notifications on retry attempts. Look at the footer status line for retry status updates.

### Too many retries?

Use `/retry reset` to clear the counters, or press `Ctrl+C` to abort the session.

## Comparison with @georgebashi/pi-retry

The npm package `@georgebashi/pi-retry` handles "aborted" streaming errors but explicitly excludes "connection error" (assuming pi's built-in retry handles it). This extension:

1. **Handles connection errors** that pi might not retry sufficiently
2. **Handles 400/413 errors** without compaction

They can work together for maximum coverage:

```bash
pi install npm:@georgebashi/pi-retry
# Plus install this extension
```

## Limitations

- Extensions cannot override pi's internal `isRetryableError()` check — they run *after* pi decides not to auto-retry
- Error messages remain in the session history (but are invisible to the LLM)
- May hit the same error repeatedly if the issue is persistent (use `Ctrl+C` to abort)
- **Warning**: Retrying 400/413 without reducing context may fail repeatedly if the payload is genuinely too large

## Related

- [Pi Coding Agent Extensions Docs](https://github.com/badlogic/pi/tree/main/packages/coding-agent/docs/extensions.md)
- [@georgebashi/pi-retry](https://github.com/georgebashi/pi-retry) — Handles "aborted" streaming errors
- [Issue #252: Connection error with no retry](https://github.com/badlogic/pi-mono/issues/252)
