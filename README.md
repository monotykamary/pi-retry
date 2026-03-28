# pi-retry Extension

Extension for the [pi coding agent](https://github.com/badlogic/pi) that retries **400** and **413** errors WITHOUT compaction.

## Problem

By default, pi treats `400 Bad Request` and `413 Payload Too Large` as **context overflow errors**, which triggers compaction (summarization) but **not** automatic retry. This is hardcoded in the `isContextOverflow()` function:

```javascript
// Cerebras returns 400/413 with no body for context overflow
if (/^4(00|13)\s*(status code)?\s*\(no body\)/i.test(message.errorMessage)) {
  return true;  // Treated as context overflow
}
```

## Solution

This extension intercepts 400/413 errors via the `agent_end` event and provides **pure retry logic** with exponential backoff - NO compaction. It re-sends the last user message to trigger a fresh attempt.

⚠️ **Warning**: Retrying 400/413 without reducing context may fail repeatedly if the payload is genuinely too large. Use this if:
- The error is transient (provider glitch)
- You want to retry before attempting compaction
- You're testing provider behavior

## Features

- **Automatic detection** of 400/413 errors in assistant messages
- **Exponential backoff retry** (configurable max retries and base delay)
- **NO compaction** - retries with full context intact
- **Manual retry command** (`/retry-413`) to force immediate retry
- **Status notifications** in the TUI footer

## Installation

### Option 1: Install via pi package (Recommended)

Install directly from GitHub as a pi package:

```bash
pi --install git:github.com:monotykamary/pi-retry.git
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
cp retry-400-413.ts ~/.pi/agent/extensions/
```

### Option 3: Project-Local Installation

Copy to your project's `.pi/extensions/` directory:

```bash
cp retry-400-413.ts ./.pi/extensions/
```

### Option 4: Quick Test

```bash
pi -e ./retry-400-413.ts
```

## Usage

Once loaded, the extension automatically:

1. **Detects** when a 400 or 413 error occurs
2. **Notifies** you via TUI notification
3. **Retries** with exponential backoff (default: 3 retries, starting at 2s delay)
4. **Re-sends** the last user message to trigger a fresh attempt

### Commands

| Command | Description |
|---------|-------------|
| `/retry-413` | Manually trigger immediate retry (no compaction) |
| `/retry-config` | Show current retry settings |
| `/retry-config reset` | Reset the retry attempt counter |

## Configuration

Edit the constants at the top of the file:

```typescript
const MAX_CUSTOM_RETRIES = 3;      // Maximum retry attempts
const CUSTOM_RETRY_DELAY_MS = 2000; // Base delay (doubles each retry)
```

## How It Works

The extension listens to the `agent_end` event, which fires after each agent turn completes. It checks if the last assistant message:

1. Has `stopReason: "error"`
2. Contains a 400 or 413 error pattern

When detected, it:
1. Shows a notification
2. Increments the retry counter
3. Waits with exponential backoff
4. **Re-sends the last user message** via `sendUserMessage()` with `deliverAs: "followUp"`
5. The agent retries with the same context (no compaction)

## Limitations

- **No context reduction** - if the context is genuinely too large, retries will keep failing
- **Cannot fully override** pi's internal `isRetryableError()` check - this extension runs *after* pi decides not to auto-retry
- The error message remains in the session history (unlike compaction which removes it)
- May hit the same error repeatedly if the provider consistently rejects the payload size

## Alternative Approaches

If pure retry doesn't work and you need compaction:

1. **Use pi's built-in auto-compaction** - Enable in settings: `compaction: { enabled: true }`
2. **Custom compaction** - Use `session_before_compact` event to customize how context is reduced
3. **Overriding the provider** - Register a custom provider with `pi.registerProvider()` that handles 400/413 at the API level
4. **Pre-emptive truncation** - Listen to `before_provider_request` to check payload size before sending

## Related

- [Pi Coding Agent Extensions Docs](https://github.com/badlogic/pi/tree/main/packages/coding-agent/docs/extensions.md)
- [Context Overflow Detection](https://github.com/badlogic/pi/blob/main/packages/pi-ai/src/utils/overflow.ts)
