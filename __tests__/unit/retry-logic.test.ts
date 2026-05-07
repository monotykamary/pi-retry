/**
 * Unit tests for retry logic utilities
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  calculateDelay,
  formatDuration,
  isUserMessageWithContent,
  isTextContent,
  extractTextContent,
  getLastAssistantMessage,
  RetryState,
  ContinuationState,
  DEFAULT_BACKOFF_CONFIG,
  type BackoffConfig,
} from '../../src/retry-logic.js';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { TextContent, ImageContent } from '@mariozechner/pi-ai';

describe('calculateDelay', () => {
  it('calculates correct delays for attempts 1-5 with default config', () => {
    expect(calculateDelay(1)).toBe(2000);
    expect(calculateDelay(2)).toBe(4000);
    expect(calculateDelay(3)).toBe(8000);
    expect(calculateDelay(4)).toBe(16000);
    expect(calculateDelay(5)).toBe(32000);
  });

  it('caps at max delay (60s) for high attempts', () => {
    expect(calculateDelay(6)).toBe(60000);
    expect(calculateDelay(10)).toBe(60000);
    expect(calculateDelay(100)).toBe(60000);
  });

  it('uses custom config when provided', () => {
    const customConfig: BackoffConfig = {
      baseDelayMs: 1000,
      maxDelayMs: 10000,
      multiplier: 3,
    };
    expect(calculateDelay(1, customConfig)).toBe(1000);
    expect(calculateDelay(2, customConfig)).toBe(3000);
    expect(calculateDelay(3, customConfig)).toBe(9000);
    expect(calculateDelay(4, customConfig)).toBe(10000); // capped
  });

  it('handles attempt 1 as base delay', () => {
    const config: BackoffConfig = {
      baseDelayMs: 5000,
      maxDelayMs: 30000,
      multiplier: 2,
    };
    expect(calculateDelay(1, config)).toBe(5000);
  });
});

describe('formatDuration', () => {
  it('formats milliseconds', () => {
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('formats seconds', () => {
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(2500)).toBe('2.5s');
    expect(formatDuration(59999)).toMatch(/^[0-9]+\.[0-9]s$/);
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(60000)).toBe('1m 0s');
    expect(formatDuration(90000)).toBe('1m 30s');
    expect(formatDuration(125000)).toBe('2m 5s');
  });

  it('handles edge cases', () => {
    expect(formatDuration(0)).toBe('0ms');
  });
});

describe('isUserMessageWithContent', () => {
  it('returns true for user messages with string content', () => {
    const msg = { role: 'user', content: 'hello' } as unknown as AgentMessage;
    expect(isUserMessageWithContent(msg)).toBe(true);
  });

  it('returns true for user messages with array content', () => {
    const msg = {
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    } as unknown as AgentMessage;
    expect(isUserMessageWithContent(msg)).toBe(true);
  });

  it('returns false for assistant messages', () => {
    const msg = { role: 'assistant', content: [] } as unknown as AgentMessage;
    expect(isUserMessageWithContent(msg)).toBe(false);
  });

  it('returns false for user messages without content property', () => {
    const msg = { role: 'user' } as unknown as AgentMessage;
    expect(isUserMessageWithContent(msg)).toBe(false);
  });
});

describe('isTextContent', () => {
  it('returns true for valid text content', () => {
    const content = { type: 'text', text: 'hello' } as TextContent;
    expect(isTextContent(content)).toBe(true);
  });

  it('returns false for image content', () => {
    const content = {
      type: 'image',
      source: { type: 'base64', mediaType: 'image/png', data: 'abc' },
    } as ImageContent;
    expect(isTextContent(content)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isTextContent(null)).toBe(false);
  });

  it('returns false for non-object values', () => {
    expect(isTextContent('string')).toBe(false);
    expect(isTextContent(123)).toBe(false);
    expect(isTextContent(undefined)).toBe(false);
  });

  it('returns false for objects without type', () => {
    expect(isTextContent({ text: 'hello' })).toBe(false);
  });

  it('returns false for objects with wrong type', () => {
    expect(isTextContent({ type: 'image', text: 'hello' })).toBe(false);
  });
});

describe('extractTextContent', () => {
  it('returns empty string for undefined', () => {
    expect(extractTextContent(undefined)).toBe('');
  });

  it('returns string as-is', () => {
    expect(extractTextContent('hello world')).toBe('hello world');
  });

  it('extracts text from content array', () => {
    const content: (TextContent | ImageContent)[] = [
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world' },
    ];
    expect(extractTextContent(content)).toBe('hello world');
  });

  it('ignores image content in array', () => {
    const content = [
      { type: 'text', text: 'hello ' },
      { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'abc' } },
      { type: 'text', text: 'world' },
    ] as (TextContent | ImageContent)[];
    expect(extractTextContent(content)).toBe('hello world');
  });

  it('returns empty string for empty array', () => {
    expect(extractTextContent([])).toBe('');
  });

  it('returns empty string for array with only images', () => {
    const content = [
      { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'abc' } },
    ] as ImageContent[];
    expect(extractTextContent(content)).toBe('');
  });
});

describe('getLastAssistantMessage', () => {
  it('returns undefined for empty entries', () => {
    expect(getLastAssistantMessage([])).toBeUndefined();
  });

  it('returns the last assistant message', () => {
    const entries = [
      { type: 'message', message: { role: 'user', content: 'hi' } },
      { type: 'message', message: { role: 'assistant', content: 'hello' } },
      { type: 'message', message: { role: 'toolResult', content: [] } },
    ];
    const result = getLastAssistantMessage(entries);
    expect(result?.role).toBe('assistant');
  });

  it('skips non-message entries', () => {
    const entries = [
      { type: 'custom', customType: 'test' },
      { type: 'message', message: { role: 'assistant', content: 'hello' } },
    ];
    const result = getLastAssistantMessage(entries);
    expect(result?.role).toBe('assistant');
  });

  it('returns undefined when no assistant messages', () => {
    const entries = [
      { type: 'message', message: { role: 'user', content: 'hi' } },
      { type: 'message', message: { role: 'toolResult', content: [] } },
    ];
    expect(getLastAssistantMessage(entries)).toBeUndefined();
  });

  it('searches from the end', () => {
    const entries = [
      { type: 'message', message: { role: 'assistant', content: 'first', id: '1' } },
      { type: 'message', message: { role: 'user', content: 'hi' } },
      { type: 'message', message: { role: 'assistant', content: 'second', id: '2' } },
    ];
    const result = getLastAssistantMessage(entries);
    expect((result as any)?.id).toBe('2');
  });
});

describe('RetryState', () => {
  let state: RetryState;

  beforeEach(() => {
    state = new RetryState();
  });

  it('initializes with zero attempt', () => {
    expect(state.getAttempt()).toBe(0);
    expect(state.getIsRetrying()).toBe(false);
    expect(state.getLastErrorMessage()).toBe('');
  });

  it('increments attempt on startRetry', () => {
    state.startRetry('error 1');
    expect(state.getAttempt()).toBe(1);
    expect(state.getIsRetrying()).toBe(true);
    expect(state.getLastErrorMessage()).toBe('error 1');

    state.endRetry();
    state.startRetry('error 2');
    expect(state.getAttempt()).toBe(2);
  });

  it('sets isRetrying to false on endRetry', () => {
    state.startRetry('error');
    expect(state.getIsRetrying()).toBe(true);
    state.endRetry();
    expect(state.getIsRetrying()).toBe(false);
  });

  it('resets all state on reset', () => {
    state.startRetry('error');
    state.reset();
    expect(state.getAttempt()).toBe(0);
    expect(state.getIsRetrying()).toBe(false);
    expect(state.getLastErrorMessage()).toBe('');
  });

  it('resets all state on succeed', () => {
    state.startRetry('error');
    state.startRetry('error 2');
    expect(state.getAttempt()).toBe(2);
    
    state.succeed();
    expect(state.getAttempt()).toBe(0);
    expect(state.getIsRetrying()).toBe(false);
    expect(state.getLastErrorMessage()).toBe('');
  });

  it('tracks different error messages', () => {
    state.startRetry('first error');
    expect(state.getLastErrorMessage()).toBe('first error');
    
    state.startRetry('second error');
    expect(state.getLastErrorMessage()).toBe('second error');
  });
});

describe('DEFAULT_BACKOFF_CONFIG', () => {
  it('has correct default values', () => {
    expect(DEFAULT_BACKOFF_CONFIG.baseDelayMs).toBe(2000);
    expect(DEFAULT_BACKOFF_CONFIG.maxDelayMs).toBe(60000);
    expect(DEFAULT_BACKOFF_CONFIG.multiplier).toBe(2);
  });
});

describe('ContinuationState', () => {
  let state: ContinuationState;

  beforeEach(() => {
    state = new ContinuationState();
  });

  it('initializes with zero count', () => {
    expect(state.getCount()).toBe(0);
    expect(state.getIsContinuing()).toBe(false);
  });

  it('increments count on startContinuation', () => {
    state.startContinuation();
    expect(state.getCount()).toBe(1);
    expect(state.getIsContinuing()).toBe(true);
  });

  it('sets isContinuing to false on endContinuation', () => {
    state.startContinuation();
    expect(state.getIsContinuing()).toBe(true);
    state.endContinuation();
    expect(state.getIsContinuing()).toBe(false);
    // Count is preserved
    expect(state.getCount()).toBe(1);
  });

  it('tracks multiple continuations', () => {
    state.startContinuation();
    state.endContinuation();
    state.startContinuation();
    state.endContinuation();
    state.startContinuation();
    state.endContinuation();
    expect(state.getCount()).toBe(3);
  });

  it('resets all state on reset', () => {
    state.startContinuation();
    state.reset();
    expect(state.getCount()).toBe(0);
    expect(state.getIsContinuing()).toBe(false);
  });

  it('resets all state on complete', () => {
    state.startContinuation();
    state.endContinuation();
    state.startContinuation();
    expect(state.getCount()).toBe(2);
    state.complete();
    expect(state.getCount()).toBe(0);
    expect(state.getIsContinuing()).toBe(false);
  });
});
