import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getRetrySession,
  getSessionAgent,
  recordRetrySessionAgent,
  registerRetrySession,
  removeErrorFromRetryContext,
  unregisterRetrySession,
  waitForSessionIdle,
} from "../../src/session-registry.js";

const registrations: Array<{ manager: object; owner: object }> = [];

// Release every test identity so a process-wide symbol registry cannot leak
// ownership between independent Vitest cases.
afterEach(() => {
  for (const registration of registrations.splice(0)) {
    unregisterRetrySession(registration.manager, registration.owner);
  }
});

/**
 * Register one lightweight session identity for registry behavior tests.
 *
 * @returns Manager, agent, and owner objects used by the test.
 */
function createRegistration(): {
  manager: object;
  agent: object;
  owner: object;
} {
  const manager = {};
  const agent = {};
  const owner = {};
  recordRetrySessionAgent(manager, agent as any);
  registrations.push({ manager, owner });
  return { manager, agent, owner };
}

describe("session registry ownership", () => {
  // Duplicate extension factories may observe a session but cannot claim it.
  it("keeps the first factory owner through duplicate shutdown", () => {
    const { manager, agent, owner } = createRegistration();
    const duplicateOwner = {};
    const options = {
      isChild: true,
      suppressNativeRetry: true,
      childRetryEnabled: true,
    };

    const first = registerRetrySession(manager, owner, options);
    const duplicate = registerRetrySession(manager, duplicateOwner, options);
    expect(first?.owned).toBe(true);
    expect(duplicate?.owned).toBe(false);
    expect(getSessionAgent(manager)).toBe(agent);

    unregisterRetrySession(manager, duplicateOwner);
    expect(getRetrySession(manager)).toBe(first?.binding);
    expect(getSessionAgent(manager)).toBe(agent);

    unregisterRetrySession(manager, owner);
    expect(getRetrySession(manager)).toBeUndefined();
    expect(getSessionAgent(manager)).toBeUndefined();
  });

  // Pi 0.87+ exposes canonical context omission through the session object.
  // TEST:__tests__/unit/session-registry.test.ts[uses canonical retry omission]
  it("uses the canonical omission hook when the SDK provides one", () => {
    const manager = {};
    const failedMessage = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "transient connection error",
    };
    const agent = { state: { messages: [failedMessage] } } as any;
    const owner = {};
    const omitRecoveryAttempt = vi.fn();
    recordRetrySessionAgent(manager, agent, {
      sessionManager: manager,
      agent,
      _omitRecoveryAttempt: omitRecoveryAttempt,
    });
    registrations.push({ manager, owner });

    removeErrorFromRetryContext(manager, agent);

    expect(omitRecoveryAttempt).toHaveBeenCalledWith(failedMessage);
    expect(agent.state.messages).toEqual([failedMessage]);
  });

  // The private hook can throw; the retry loop must not see that as an unhandled rejection.
  // TEST:__tests__/unit/session-registry.test.ts[falls back when the canonical omission hook throws]
  it("falls back to the live-state edit when the canonical omission hook throws", () => {
    const manager = {};
    const keptMessage = { role: "user", content: "hello" };
    const failedMessage = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "transient connection error",
    };
    const agent = { state: { messages: [keptMessage, failedMessage] } } as any;
    const owner = {};
    const omitRecoveryAttempt = vi.fn(() => {
      throw new Error(
        "Cannot persist recovery omission because a projected message has no source entry",
      );
    });
    recordRetrySessionAgent(manager, agent, {
      sessionManager: manager,
      agent,
      _omitRecoveryAttempt: omitRecoveryAttempt,
    });
    registrations.push({ manager, owner });

    expect(() => removeErrorFromRetryContext(manager, agent)).not.toThrow();

    expect(omitRecoveryAttempt).toHaveBeenCalledTimes(1);
    expect(agent.state.messages).toEqual([keptMessage]);
  });

  // Session-manager WeakMap keys keep sibling main/child sessions isolated.
  it("isolates ownership and Agent identity between sibling sessions", () => {
    const first = createRegistration();
    const second = createRegistration();
    const firstOptions = {
      isChild: false,
      suppressNativeRetry: true,
      childRetryEnabled: false,
    };
    const secondOptions = {
      isChild: true,
      suppressNativeRetry: true,
      childRetryEnabled: true,
    };

    const firstBinding = registerRetrySession(first.manager, first.owner, firstOptions);
    const secondBinding = registerRetrySession(second.manager, second.owner, secondOptions);

    expect(firstBinding?.binding).not.toBe(secondBinding?.binding);
    expect(getRetrySession(first.manager)?.isChild).toBe(false);
    expect(getRetrySession(second.manager)?.isChild).toBe(true);
    expect(getSessionAgent(first.manager)).toBe(first.agent);
    expect(getSessionAgent(second.manager)).toBe(second.agent);
  });
});

describe("waitForSessionIdle", () => {
  // TEST target: src/session-registry.ts[waitForSessionIdle]
  // The session lifecycle is the barrier: the Agent may look idle while the
  // session is still preparing the run it just started.
  it("waits on the session lifecycle instead of the Agent when the session owns the agent", async () => {
    const manager = {};
    const calls: string[] = [];
    const agent = {
      waitForIdle: async () => {
        calls.push("agent");
      },
    };
    let releaseSession: (() => void) | undefined;
    const session = {
      sessionManager: manager,
      agent,
      waitForIdle: () => {
        calls.push("session");
        return new Promise<void>(resolve => {
          releaseSession = resolve;
        });
      },
    };
    recordRetrySessionAgent(manager, agent as any, session as any);

    let settled = false;
    const waiting = waitForSessionIdle(manager, agent as any).then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    // The Agent is already idle, yet the wait must stay pending on the session.
    expect(settled).toBe(false);
    expect(calls).toEqual(["session"]);

    releaseSession?.();
    await waiting;
    expect(settled).toBe(true);
    expect(calls).toEqual(["session"]);
  });

  // Fixtures and older mappings without a session-level wait keep working.
  it("falls back to Agent.waitForIdle when the session has no waitForIdle", async () => {
    const manager = {};
    let agentWaits = 0;
    const agent = {
      waitForIdle: async () => {
        agentWaits++;
      },
    };
    recordRetrySessionAgent(manager, agent as any);

    await waitForSessionIdle(manager, agent as any);
    expect(agentWaits).toBe(1);
  });

  // A session that now owns a different Agent must not gate an old loop.
  it("ignores the session when it owns a different Agent", async () => {
    const manager = {};
    let sessionWaits = 0;
    let agentWaits = 0;
    const ownedAgent = { waitForIdle: async () => {} };
    const staleAgent = {
      waitForIdle: async () => {
        agentWaits++;
      },
    };
    const session = {
      sessionManager: manager,
      agent: ownedAgent,
      waitForIdle: async () => {
        sessionWaits++;
      },
    };
    recordRetrySessionAgent(manager, ownedAgent as any, session as any);

    await waitForSessionIdle(manager, staleAgent as any);
    expect(sessionWaits).toBe(0);
    expect(agentWaits).toBe(1);
  });

  // An unmapped or missing manager degrades to the plain Agent barrier.
  it("falls back to Agent.waitForIdle for an unmapped session manager", async () => {
    let agentWaits = 0;
    const agent = {
      waitForIdle: async () => {
        agentWaits++;
      },
    };

    await waitForSessionIdle({}, agent as any);
    await waitForSessionIdle(undefined, agent as any);
    expect(agentWaits).toBe(2);
  });
});
