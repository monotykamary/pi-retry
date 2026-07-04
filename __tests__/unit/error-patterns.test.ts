/**
 * Unit tests for error pattern matching
 */

import { describe, it, expect } from 'vitest';
import {
  isAssistantMessage,
  has400or413Error,
  hasCreditError,
  hasConnectionError,
  hasRetryableError,
  isNonRetryableError,
  isSilencedError,
  hasMaxTokensStop,
  isContextOverflowError,
  getErrorCategory,
  CONNECTION_ERROR_PATTERNS,
} from '../../src/error-patterns.js';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

describe('isAssistantMessage', () => {
  it('returns true for assistant messages', () => {
    const msg = { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } as unknown as AgentMessage;
    expect(isAssistantMessage(msg)).toBe(true);
  });

  it('returns false for user messages', () => {
    const msg = { role: 'user', content: [{ type: 'text', text: 'hi' }] } as unknown as AgentMessage;
    expect(isAssistantMessage(msg)).toBe(false);
  });

  it('returns false for toolResult messages', () => {
    const msg = { role: 'toolResult', content: [] } as unknown as AgentMessage;
    expect(isAssistantMessage(msg)).toBe(false);
  });
});

describe('has400or413Error', () => {
  const createAssistantError = (errorMessage: string): AgentMessage =>
    ({ role: 'assistant', stopReason: 'error', errorMessage, content: [] } as unknown as AgentMessage);

  const createUserMessage = (): AgentMessage =>
    ({ role: 'user', content: [{ type: 'text', text: 'test' }] } as unknown as AgentMessage);

  it('detects 400 status code errors', () => {
    const msg = createAssistantError('400 status code (no body)');
    expect(has400or413Error(msg)).toBe(true);
  });

  it('detects 413 status code errors', () => {
    const msg = createAssistantError('413 status code: Payload Too Large');
    expect(has400or413Error(msg)).toBe(true);
  });

  it('detects "bad request" errors', () => {
    const msg = createAssistantError('Bad Request: invalid payload');
    expect(has400or413Error(msg)).toBe(true);
  });

  it('detects "payload too large" errors', () => {
    const msg = createAssistantError('Error: payload too large for context window');
    expect(has400or413Error(msg)).toBe(true);
  });

  it('returns false for non-error messages', () => {
    const msg = { role: 'assistant', stopReason: 'endTurn', content: [] } as unknown as AgentMessage;
    expect(has400or413Error(msg)).toBe(false);
  });

  it('returns false for user messages', () => {
    const msg = createUserMessage();
    expect(has400or413Error(msg)).toBe(false);
  });

  it('returns false for other error types', () => {
    const msg = createAssistantError('500 Internal Server Error');
    expect(has400or413Error(msg)).toBe(false);
  });

  it('returns false for messages without errorMessage', () => {
    const msg = { role: 'assistant', stopReason: 'error', content: [] } as unknown as AgentMessage;
    expect(has400or413Error(msg)).toBe(false);
  });
});

describe('hasCreditError', () => {
  const createAssistantError = (errorMessage: string): AgentMessage =>
    ({ role: 'assistant', stopReason: 'error', errorMessage, content: [] } as unknown as AgentMessage);

  const testCases = [
    { pattern: 'Error: Not Enough Credits', expected: true },
    { pattern: 'insufficient credits for this request', expected: true },
    { pattern: 'Insufficient balance', expected: true },
    { pattern: 'out of credits', expected: true },
    { pattern: 'Payment Required: 402 status code', expected: true },
    { pattern: '402 status code', expected: true },
    // False cases
    { pattern: '400 status code (no body)', expected: false },
    { pattern: 'Connection error', expected: false },
    { pattern: 'Some random error', expected: false },
  ];

  testCases.forEach(({ pattern, expected }) => {
    it(`${expected ? 'detects' : 'rejects'} "${pattern}"`, () => {
      const msg = createAssistantError(pattern);
      expect(hasCreditError(msg)).toBe(expected);
    });
  });

  it('returns false for non-error messages', () => {
    const msg = { role: 'assistant', stopReason: 'endTurn', content: [] } as unknown as AgentMessage;
    expect(hasCreditError(msg)).toBe(false);
  });

  it('returns false for user messages', () => {
    const msg = { role: 'user', content: [{ type: 'text', text: 'test' }] } as unknown as AgentMessage;
    expect(hasCreditError(msg)).toBe(false);
  });
});

describe('hasConnectionError', () => {
  const createAssistantError = (errorMessage: string): AgentMessage =>
    ({ role: 'assistant', stopReason: 'error', errorMessage, content: [] } as unknown as AgentMessage);

  const testCases = [
    { pattern: 'Connection error', expected: true },
    { pattern: 'Network error occurred', expected: true },
    { pattern: 'Fetch failed: network timeout', expected: true },
    { pattern: 'Socket hang up', expected: true },
    { pattern: 'ECONNRESET: connection reset by peer', expected: true },
    { pattern: 'ECONNREFUSED: connection refused', expected: true },
    { pattern: 'ETIMEDOUT: operation timed out', expected: true },
    { pattern: 'ENOTFOUND: dns lookup failed', expected: true },
    { pattern: 'DNS lookup failed for api.example.com', expected: true },
    { pattern: 'Request ended without sending any chunks', expected: true },
    { pattern: 'Upstream connect error', expected: true },
    { pattern: 'Other side closed connection', expected: true },
    { pattern: 'Reset before headers', expected: true },
    { pattern: 'Broken pipe error', expected: true },
    { pattern: 'Unexpected end of file', expected: true },
    { pattern: 'TLS handshake timeout', expected: true },
    { pattern: 'SSL connection error', expected: true },
    { pattern: 'Timeout awaiting response', expected: true },
    { pattern: 'Request timeout after 30s', expected: true },
    // False cases
    { pattern: '400 status code (no body)', expected: false },
    { pattern: 'Rate limit exceeded', expected: false },
    { pattern: 'Overloaded error', expected: false },
    { pattern: 'Some random error', expected: false },
  ];

  testCases.forEach(({ pattern, expected }) => {
    it(`${expected ? 'detects' : 'rejects'} "${pattern}"`, () => {
      const msg = createAssistantError(pattern);
      expect(hasConnectionError(msg)).toBe(expected);
    });
  });

  it('returns false for non-error messages', () => {
    const msg = { role: 'assistant', stopReason: 'endTurn', content: [] } as unknown as AgentMessage;
    expect(hasConnectionError(msg)).toBe(false);
  });

  it('returns false for user messages', () => {
    const msg = { role: 'user', content: [{ type: 'text', text: 'test' }] } as unknown as AgentMessage;
    expect(hasConnectionError(msg)).toBe(false);
  });
});

describe('isContextOverflowError', () => {
  const createAssistantError = (errorMessage: string): AgentMessage =>
    ({ role: 'assistant', stopReason: 'error', errorMessage, content: [] } as unknown as AgentMessage);

  // Mirrors pi-core's isContextOverflow Case 1 patterns. These are the errors
  // pi-retry must NOT retry (defer to compaction) — see error-patterns.ts.
  const overflowCases = [
    'prompt is too long: 213462 tokens > 200000 maximum',
    'request_too_large: Request exceeds the maximum size',
    'Your input exceeds the context window of this model',
    'Requested token count exceeds the model\'s maximum context length of 131072 tokens',
    'The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)',
    'This model\'s maximum prompt length is 131072 but the request contains 537812 tokens',
    'Please reduce the length of the messages or completion',
    'This endpoint\'s maximum context length is 131072 tokens. However, you requested about 265330 tokens',
    'Input length (265330) exceeds model\'s maximum context length (262144).',
    'prompt token count of 265330 exceeds the limit of 262144',
    'invalid params, context window exceeds limit',
    'Your request exceeded model token limit: 200000 (requested: 213462)',
    'Prompt contains 213462 tokens ... too large for model with 200000 maximum context length',
    'model_context_window_exceeded',
    'prompt too long; exceeded max context length by 13462 tokens',
    'context_length_exceeded',
    'too many tokens',
    'token limit exceeded',
    '400 (no body)',
    '413 (no body)',
  ];

  overflowCases.forEach((pattern) => {
    it(`detects overflow "${pattern.slice(0, 50)}"`, () => {
      const msg = createAssistantError(pattern);
      expect(isContextOverflowError(msg)).toBe(true);
    });
  });

  // Throttling / rate-limit strings that contain overflow-looking substrings
  // must NOT be classified as overflow — they are retried normally.
  const nonOverflowCases = [
    'Throttling error: Too many tokens, please wait before trying again.',
    'Service unavailable: temporarily offline',
    'rate limit exceeded',
    'Too many requests — slow down',
  ];

  nonOverflowCases.forEach((pattern) => {
    it(`does not classify throttling/rate-limit as overflow: "${pattern}"`, () => {
      const msg = createAssistantError(pattern);
      expect(isContextOverflowError(msg)).toBe(false);
    });
  });

  it('returns false for non-overflow errors', () => {
    expect(isContextOverflowError(createAssistantError('Connection error'))).toBe(false);
    expect(isContextOverflowError(createAssistantError('500 Internal Server Error'))).toBe(false);
    expect(isContextOverflowError(createAssistantError('Not enough credits'))).toBe(false);
  });

  it('returns false for non-error messages', () => {
    const msg = { role: 'assistant', stopReason: 'stop', content: [] } as unknown as AgentMessage;
    expect(isContextOverflowError(msg)).toBe(false);
  });

  it('returns false for messages without errorMessage', () => {
    const msg = { role: 'assistant', stopReason: 'error', content: [] } as unknown as AgentMessage;
    expect(isContextOverflowError(msg)).toBe(false);
  });

  it('returns false for user messages', () => {
    const msg = { role: 'user', content: [{ type: 'text', text: 'test' }] } as unknown as AgentMessage;
    expect(isContextOverflowError(msg)).toBe(false);
  });
});

describe('hasRetryableError', () => {
  const createAssistantError = (errorMessage: string): AgentMessage =>
    ({ role: 'assistant', stopReason: 'error', errorMessage, content: [] } as unknown as AgentMessage);

  it('returns true for any generic error by default', () => {
    const msg = createAssistantError('Something went wrong');
    expect(hasRetryableError(msg)).toBe(true);
  });

  it('returns true for stream exhaustion errors', () => {
    const msg = createAssistantError('Max outbound streams is 100, 100 open');
    expect(hasRetryableError(msg)).toBe(true);
  });

  it('returns false for non-error messages', () => {
    const msg = { role: 'assistant', stopReason: 'endTurn', content: [] } as unknown as AgentMessage;
    expect(hasRetryableError(msg)).toBe(false);
  });

  it('returns false for user messages', () => {
    const msg = { role: 'user', content: [{ type: 'text', text: 'test' }] } as unknown as AgentMessage;
    expect(hasRetryableError(msg)).toBe(false);
  });
});

describe('isNonRetryableError', () => {
  const createAssistantError = (errorMessage: string): AgentMessage =>
    ({ role: 'assistant', stopReason: 'error', errorMessage, content: [] } as unknown as AgentMessage);

  it('detects invalid api key', () => {
    const msg = createAssistantError('Invalid API key provided');
    expect(isNonRetryableError(msg)).toBe(true);
  });

  it('detects model not found', () => {
    const msg = createAssistantError('Model not found: gpt-99');
    expect(isNonRetryableError(msg)).toBe(true);
  });

  it('detects unknown model', () => {
    const msg = createAssistantError('Unknown model');
    expect(isNonRetryableError(msg)).toBe(true);
  });

  it('detects "cannot continue from message role" errors', () => {
    const msg = createAssistantError('Cannot continue from message role: assistant');
    expect(isNonRetryableError(msg)).toBe(true);
  });

  it('returns false for retryable errors', () => {
    const msg = createAssistantError('Connection error');
    expect(isNonRetryableError(msg)).toBe(false);
  });

  it('returns false for non-error messages', () => {
    const msg = { role: 'assistant', stopReason: 'endTurn', content: [] } as unknown as AgentMessage;
    expect(isNonRetryableError(msg)).toBe(false);
  });
});

describe('isSilencedError', () => {
  const createAssistantError = (errorMessage: string): AgentMessage =>
    ({ role: 'assistant', stopReason: 'error', errorMessage, content: [] } as unknown as AgentMessage);

  it('silences "cannot continue from message role" errors', () => {
    const msg = createAssistantError('Cannot continue from message role: assistant');
    expect(isSilencedError(msg)).toBe(true);
  });

  it('does not silence invalid API key errors', () => {
    const msg = createAssistantError('Invalid API key provided');
    expect(isSilencedError(msg)).toBe(false);
  });

  it('does not silence model not found errors', () => {
    const msg = createAssistantError('Model not found: gpt-99');
    expect(isSilencedError(msg)).toBe(false);
  });

  it('returns false for non-error messages', () => {
    const msg = { role: 'assistant', stopReason: 'endTurn', content: [] } as unknown as AgentMessage;
    expect(isSilencedError(msg)).toBe(false);
  });
});

describe('getErrorCategory', () => {
  it('categorizes 400/413 errors', () => {
    expect(getErrorCategory('400 status code')).toBe('400-413');
    expect(getErrorCategory('Bad Request')).toBe('400-413');
    expect(getErrorCategory('Payload too large')).toBe('400-413');
  });

  it('categorizes credit errors', () => {
    expect(getErrorCategory('Error: Not Enough Credits')).toBe('credit');
    expect(getErrorCategory('insufficient balance')).toBe('credit');
    expect(getErrorCategory('402 status code')).toBe('credit');
  });

  it('categorizes connection errors', () => {
    expect(getErrorCategory('Connection error')).toBe('connection');
    expect(getErrorCategory('ECONNRESET')).toBe('connection');
    expect(getErrorCategory('Fetch failed')).toBe('connection');
  });

  it('categorizes stream errors', () => {
    expect(getErrorCategory('Max outbound streams is 100, 100 open')).toBe('connection');
    expect(getErrorCategory('stream limit exhausted')).toBe('connection');
  });

  it('categorizes builtin-handled errors', () => {
    expect(getErrorCategory('Rate limit exceeded')).toBe('builtin');
    expect(getErrorCategory('Server overloaded')).toBe('builtin');
    expect(getErrorCategory('500 Internal Server Error')).toBe('builtin');
  });

  it('categorizes other errors', () => {
    expect(getErrorCategory('Some random error')).toBe('other');
    expect(getErrorCategory('Unknown error')).toBe('other');
  });
});

describe('CONNECTION_ERROR_PATTERNS', () => {
  it('has 21 patterns defined', () => {
    expect(CONNECTION_ERROR_PATTERNS.length).toBe(21);
  });

  it('all patterns are valid regex', () => {
    CONNECTION_ERROR_PATTERNS.forEach((pattern, i) => {
      expect(pattern).toBeInstanceOf(RegExp);
      expect(() => 'test'.match(pattern)).not.toThrow();
    });
  });
});

describe('hasMaxTokensStop', () => {
  it('returns true for assistant messages with stopReason "length"', () => {
    const msg = { role: 'assistant', stopReason: 'length', content: [] } as unknown as AgentMessage;
    expect(hasMaxTokensStop(msg)).toBe(true);
  });

  it('returns false for assistant messages with stopReason "stop"', () => {
    const msg = { role: 'assistant', stopReason: 'stop', content: [] } as unknown as AgentMessage;
    expect(hasMaxTokensStop(msg)).toBe(false);
  });

  it('returns false for assistant messages with stopReason "toolUse"', () => {
    const msg = { role: 'assistant', stopReason: 'toolUse', content: [] } as unknown as AgentMessage;
    expect(hasMaxTokensStop(msg)).toBe(false);
  });

  it('returns false for assistant messages with stopReason "error"', () => {
    const msg = { role: 'assistant', stopReason: 'error', errorMessage: 'something', content: [] } as unknown as AgentMessage;
    expect(hasMaxTokensStop(msg)).toBe(false);
  });

  it('returns false for assistant messages with stopReason "aborted"', () => {
    const msg = { role: 'assistant', stopReason: 'aborted', content: [] } as unknown as AgentMessage;
    expect(hasMaxTokensStop(msg)).toBe(false);
  });

  it('returns false for user messages', () => {
    const msg = { role: 'user', content: [{ type: 'text', text: 'test' }] } as unknown as AgentMessage;
    expect(hasMaxTokensStop(msg)).toBe(false);
  });

  it('returns false for toolResult messages', () => {
    const msg = { role: 'toolResult', content: [] } as unknown as AgentMessage;
    expect(hasMaxTokensStop(msg)).toBe(false);
  });
});

