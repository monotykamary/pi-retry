# pi-retry Extension Suite

Extensions for the [pi coding agent](https://github.com/badlogic/pi) that provide comprehensive retry handling for various error types.

## Extensions

This package contains two complementary extensions:

| Extension | Handles | Retry Behavior | Use Case |
|-----------|---------|----------------|----------|
| `retry-400-413.ts` | HTTP 400/413 errors | **Indefinite** with capped backoff, NO compaction | Context overflow that might be transient |
| `retry-connection.ts` | Connection/network errors | **Indefinite** with capped backoff | Network hiccups, connection drops |

## Problem

By default, pi has built-in retry for some errors (rate limits, 5xx, overloaded), but:

1. **400/413 errors** are treated as context overflow → triggers compaction but NO retry
2. **Connection errors** sometimes get only 3 retries before giving up
3. Some transient network errors aren't retried at all

## Solutions

### retry-400-413.ts

Handles `400 Bad Request` and `413 Payload Too Large` errors by retrying WITHOUT compaction.

**⚠️ Warning**: Retrying 400/413 without reducing context may fail repeatedly if the payload is genuinely too large. Use this if:
- The error is transient (provider glitch)
- You want to retry before attempting compaction
- You're testing provider behavior

**Features:**
- Automatic detection of 400/413 errors
- **Indefinite retry** — Keeps retrying until success
- Exponential backoff with cap: 2s → 4s → 8s → ... → 60s max
- Hidden retry triggers (no TUI clutter)
- Manual retry command (`/retry-413`)

### retry-connection.ts

Handles connection/network errors with **indefinite retry** and capped exponential backoff.

**Features:**
- Retries indefinitely until success (or user abort)
- Exponential backoff with 60-second cap: 2s → 4s → 8s → ... → 60s max
- Covers: "Connection error", network timeouts, socket errors, DNS failures, etc.
- Hidden retry triggers (no TUI clutter)
- Manual controls via commands

**Detected error patterns:**
- `Connection error`
- `Network error`
- `Fetch failed`
- `Socket hang up` / `Socket error`
- `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`
- `Request ended without sending any chunks`
- `Upstream connect error`
- `TLS handshake error`
- And more...

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

Copy the extensions to pi's global extensions directory:

```bash
# Install both
cp retry-400-413.ts ~/.pi/agent/extensions/
cp retry-connection.ts ~/.pi/agent/extensions/

# Or install just one
cp retry-connection.ts ~/.pi/agent/extensions/
```

### Option 3: Project-Local Installation

Copy to your project's `.pi/extensions/` directory:

```bash
mkdir -p .pi/extensions
cp retry-400-413.ts .pi/extensions/
cp retry-connection.ts .pi/extensions/
```

### Option 4: Quick Test

```bash
# Test individual extension
pi -e ./retry-connection.ts

# Or both
pi -e ./retry-400-413.ts -e ./retry-connection.ts
```

## Usage

Once loaded, the extensions automatically detect and retry their respective error types.

### retry-400-413.ts Commands

| Command | Description |
|---------|-------------|
| `/retry-413` | Manually trigger immediate retry (no compaction) |
| `/retry-config` | Show current retry settings |
| `/retry-config reset` | Reset the retry attempt counter |

### retry-connection.ts Commands

| Command | Description |
|---------|-------------|
| `/retry-connection` | Manually trigger a connection retry |
| `/retry-connection-status` | Show current retry status and diagnostics |
| `/retry-connection-reset` | Reset the retry counter to zero |

## Configuration

### retry-400-413.ts

Edit the constants at the top of the file:

```typescript
const BASE_DELAY_MS = 2000;        // Start with 2 seconds
const MAX_DELAY_MS = 60000;        // Cap at 60 seconds
const BACKOFF_MULTIPLIER = 2;     // Double each time
```

### retry-connection.ts

Edit the constants at the top of the file:

```typescript
const BASE_DELAY_MS = 2000;        // Start with 2 seconds
const MAX_DELAY_MS = 60000;        // Cap at 60 seconds
const BACKOFF_MULTIPLIER = 2;     // Double each time
```

## How It Works

Both extensions use the same pattern:

1. **Listen to `agent_end` event** — Fires after each agent turn completes
2. **Check for error patterns** — Examine the last assistant message for specific error signatures
3. **Retry with backoff** — Wait (exponential backoff), then trigger a new turn
4. **Hidden retry triggers** — Use `sendMessage()` with `display: false` and `triggerTurn: true`
5. **Context cleanup** — The `context` event strips hidden triggers before the LLM sees them

The pi's built-in `transform-messages` already strips aborted/errored assistant messages from the LLM context, so the model never sees the failed attempts.

## Using Both Extensions Together

You can use both extensions simultaneously for comprehensive coverage:

```bash
pi -e ./retry-400-413.ts -e ./retry-connection.ts
```

They handle different error types and don't interfere with each other:
- `retry-400-413.ts` → 400/413 HTTP errors
- `retry-connection.ts` → Network/connection errors

## Comparison with @georgebashi/pi-retry

The npm package `@georgebashi/pi-retry` handles "aborted" streaming errors but explicitly excludes "connection error" (assuming pi's built-in retry handles it). This extension suite:

1. **`retry-connection.ts`** — Handles connection errors that pi might not retry
2. **`retry-400-413.ts`** — Handles context overflow errors without compaction

They can all work together for maximum coverage:

```bash
pi install npm:@georgebashi/pi-retry
# Plus install this extension suite
```

## Troubleshooting

### Extension not working?

Check that it's loaded in the startup header:
```
Loaded extensions: retry-400-413.ts, retry-connection.ts
```

### Retry not triggering?

Use the status command to diagnose:
```
/retry-connection-status
```

### Want to see what's happening?

The extensions send notifications on retry attempts. If you're not seeing them:
- Check that `ctx.hasUI` is true (notifications don't work in JSON/print mode)
- Look at the footer status line for retry status updates

### Too many retries?

For `retry-connection.ts`, you can:
1. Press `Ctrl+C` to abort the session
2. Use `/retry-connection-reset` to reset the counter
3. Edit the file to add a max retry limit

## Limitations

- Extensions cannot override pi's internal `isRetryableError()` check — they run *after* pi decides not to auto-retry
- Error messages remain in the session history (but are invisible to the LLM)
- May hit the same error repeatedly if the issue is persistent (use `Ctrl+C` to abort)

## Related

- [Pi Coding Agent Extensions Docs](https://github.com/badlogic/pi/tree/main/packages/coding-agent/docs/extensions.md)
- [@georgebashi/pi-retry](https://github.com/georgebashi/pi-retry) — Handles "aborted" streaming errors
- [Issue #252: Connection error with no retry](https://github.com/badlogic/pi-mono/issues/252)
- [Context Overflow Detection](https://github.com/badlogic/pi-mono/blob/main/packages/pi-ai/src/utils/overflow.ts)
