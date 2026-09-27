import { afterEach, describe, expect, it } from "vitest";
import type { PiRetryConfig } from "../../src/config.js";
import {
  getRetrySession,
  getSessionAgent,
  recordRetrySessionAgent,
  registerRetrySession,
  resetRetryTracker,
  unregisterRetrySession,
} from "../../src/session-registry.js";

const config: PiRetryConfig = {
  baseDelayMs: 2000,
  maxDelayMs: 60000,
  multiplier: 2,
  maxRetriesAtMaxDelay: 3,
};

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
      managedRetry: true,
      config,
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
  it("isolates ownership, identity, and policy between sibling sessions", () => {
    const first = createRegistration();
    const second = createRegistration();
    const firstOptions = {
      isChild: false,
      managedRetry: true,
      config,
    };
    const secondOptions = {
      isChild: true,
      managedRetry: true,
      config: { ...config, baseDelayMs: 500 },
    };

    const firstBinding = registerRetrySession(first.manager, first.owner, firstOptions);
    const secondBinding = registerRetrySession(second.manager, second.owner, secondOptions);

    expect(firstBinding?.binding).not.toBe(secondBinding?.binding);
    expect(getRetrySession(first.manager)?.isChild).toBe(false);
    expect(getRetrySession(second.manager)?.isChild).toBe(true);
    expect(getRetrySession(first.manager)?.config.baseDelayMs).toBe(2000);
    expect(getRetrySession(second.manager)?.config.baseDelayMs).toBe(500);
    expect(getSessionAgent(first.manager)).toBe(first.agent);
    expect(getSessionAgent(second.manager)).toBe(second.agent);
  });

  // Resetting one session's tracker must not touch a sibling's counters.
  it("resets the tracker of the bound session only", () => {
    const first = createRegistration();
    const second = createRegistration();
    const options = { isChild: false, managedRetry: true, config };
    const firstBinding = registerRetrySession(first.manager, first.owner, options)!.binding;
    registerRetrySession(second.manager, second.owner, options);

    resetRetryTracker(firstBinding);
    expect(firstBinding.retry.failuresAtCap).toEqual({});
    expect(getRetrySession(second.manager)?.retry.failuresAtCap).toEqual({});
  });

  // Disabled child policies stay unmanaged so the patches delegate to native.
  it("keeps managedRetry false available for native-only sessions", () => {
    const { manager, owner } = createRegistration();
    const binding = registerRetrySession(manager, owner, {
      isChild: true,
      managedRetry: false,
      config,
    })!.binding;
    expect(binding.managedRetry).toBe(false);
  });
});
