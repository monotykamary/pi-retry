/**
 * Shared test utilities and helpers
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';

/**
 * Create a mock assistant error message
 */
export function createAssistantErrorMessage(errorMessage: string): AgentMessage {
  return {
    role: 'assistant',
    stopReason: 'error',
    errorMessage,
    content: [],
  } as unknown as AgentMessage;
}

/**
 * Create a mock assistant success message
 */
export function createAssistantSuccessMessage(content: string = 'Success'): AgentMessage {
  return {
    role: 'assistant',
    stopReason: 'endTurn',
    content: [{ type: 'text', text: content }],
  } as unknown as AgentMessage;
}

/**
 * Create a mock assistant message that hit max_tokens
 */
export function createAssistantMaxTokensMessage(content: string = 'Truncated response'): AgentMessage {
  return {
    role: 'assistant',
    stopReason: 'length',
    content: [{ type: 'text', text: content }],
  } as unknown as AgentMessage;
}

/**
 * Create a mock user message
 */
export function createUserMessage(content: string): AgentMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: content }],
  } as unknown as AgentMessage;
}

/**
 * Create a mock session entry
 */
export function createSessionEntry(type: string, message?: AgentMessage): unknown {
  return { type, message };
}

/**
 * Create multiple session entries for testing getLastAssistantMessage
 */
export function createMixedSessionEntries(): unknown[] {
  return [
    createSessionEntry('message', createUserMessage('Hello')),
    createSessionEntry('message', createAssistantSuccessMessage('Hi there')),
    createSessionEntry('custom', undefined),
    createSessionEntry('message', createUserMessage('How are you?')),
    createSessionEntry('message', createAssistantErrorMessage('Connection error')),
  ];
}
