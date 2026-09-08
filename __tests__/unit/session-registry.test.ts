import { afterEach, describe, expect, it } from "vitest";
import {
  getRetrySession,
  getSessionAgent,
  recordRetrySessionAgent,
  registerRetrySession,
  unregisterRetrySession,
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
