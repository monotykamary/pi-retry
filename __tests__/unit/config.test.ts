/**
 * Unit tests for settings-backed pi-retry configuration.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_RETRY_CONFIG,
  loadPiRetryConfig,
  loadPiRetrySettings,
  resolvePiRetryConfig,
  resolvePiRetrySettings,
} from "../../src/config.js";

const temporaryRoots: string[] = [];

// Remove temporary settings trees so tests never modify the real Pi config.
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

/**
 * Create an isolated home/project pair for a settings-file test.
 *
 * @returns Temporary root and home directory paths.
 */
function createSettingsTree(): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-retry-config-"));
  const home = join(root, "home");
  temporaryRoots.push(root);
  return { root, home };
}

/**
 * Write one JSON settings file at the same path Pi uses.
 *
 * @param scope Whether to write the global or project settings file.
 * @param root Project root returned by createSettingsTree.
 * @param home Home directory returned by createSettingsTree.
 * @param settings JSON-compatible settings object.
 */
function writeSettings(
  scope: "global" | "project",
  root: string,
  home: string,
  settings: object,
): void {
  const filePath = scope === "global"
    ? join(home, ".pi", "agent", "settings.json")
    : join(root, ".pi", "settings.json");
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(settings), "utf8");
}

describe("resolvePiRetrySettings", () => {
  // Absent child settings inherit the already effective main policy.
  it("inherits the effective main policy when subagents is absent", () => {
    const settings = resolvePiRetrySettings(
      { piRetry: { baseDelayMs: 25, maxDelayMs: 500, multiplier: 1.5 } },
      { piRetry: { multiplier: 2 } },
    );

    expect(settings.main).toEqual({
      baseDelayMs: 25,
      maxDelayMs: 500,
      multiplier: 2,
      maxRetriesAtMaxDelay: 3,
    });
    expect(settings.subagents).toEqual({
      enabled: true,
      ...settings.main,
      match: { systemPromptRegex: [] },
    });
  });

  // Nested project fields merge over nested global fields, then main values.
  it("merges nested project fields over global and main settings", () => {
    const settings = resolvePiRetrySettings(
      {
        piRetry: {
          baseDelayMs: 10,
          maxDelayMs: 100,
          multiplier: 2,
          subagents: { baseDelayMs: 3, multiplier: 1.25 },
        },
      },
      {
        piRetry: {
          maxDelayMs: 200,
          maxRetriesAtMaxDelay: 7,
          subagents: { maxDelayMs: 33 },
        },
      },
    );

    expect(settings.main).toEqual({
      baseDelayMs: 10,
      maxDelayMs: 200,
      multiplier: 2,
      maxRetriesAtMaxDelay: 7,
    });
    expect(settings.subagents).toEqual({
      enabled: true,
      baseDelayMs: 3,
      maxDelayMs: 33,
      multiplier: 1.25,
      maxRetriesAtMaxDelay: 7,
      match: { systemPromptRegex: [] },
    });
  });

  // Every invalid child field falls back independently to main policy values.
  it("falls back per child field when nested values are invalid", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const settings = resolvePiRetrySettings(
      {},
      {
        piRetry: {
          subagents: {
            enabled: "yes",
            baseDelayMs: -1,
            maxDelayMs: "large",
            multiplier: 0,
            maxRetriesAtMaxDelay: 1.5,
          },
        },
      },
    );

    expect(settings.subagents).toEqual({
      enabled: true,
      ...DEFAULT_RETRY_CONFIG,
      match: { systemPromptRegex: [] },
    });
    expect(warning).toHaveBeenCalledTimes(5);
  });

  // Boolean shorthand is invalid; only an object with enabled:false disables.
  it("accepts enabled:false but ignores boolean shorthand", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const disabled = resolvePiRetrySettings({}, {
      piRetry: { subagents: { enabled: false } },
    });
    const shorthand = resolvePiRetrySettings({}, {
      piRetry: { subagents: false },
    });

    expect(disabled.subagents.enabled).toBe(false);
    expect(shorthand.subagents).toEqual({
      enabled: true,
      ...DEFAULT_RETRY_CONFIG,
      match: { systemPromptRegex: [] },
    });
    expect(warning).toHaveBeenCalledOnce();
  });

  // An invalid project namespace cannot erase a valid global child policy.
  it("warns and retains the valid global namespace when project is invalid", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const settings = resolvePiRetrySettings(
      { piRetry: { subagents: { baseDelayMs: 11 } } },
      { piRetry: { subagents: ["invalid"] } },
    );

    expect(settings.subagents.baseDelayMs).toBe(11);
    expect(settings.subagents.enabled).toBe(true);
    expect(warning).toHaveBeenCalledOnce();
  });

  // The unsupported top-level enabled field must not disable child takeover.
  it("does not treat top-level enabled as the child switch", () => {
    const settings = resolvePiRetrySettings({}, {
      piRetry: { enabled: false },
    });

    expect(settings.subagents.enabled).toBe(true);
  });

  // A configured list compiles each source and selects a match with OR semantics.
  it("compiles arbitrary system-prompt regex rules with flags", () => {
    const settings = resolvePiRetrySettings({}, {
      piRetry: {
        subagents: {
          match: {
            systemPromptRegex: [
              { pattern: "<ordinary-child>", flags: "i" },
              { pattern: "^second$", flags: "m" },
              { pattern: "/path/segment" },
            ],
          },
        },
      },
    });

    const rules = settings.subagents.match.systemPromptRegex;
    expect(rules).toHaveLength(3);
    expect(rules[0]).toBeInstanceOf(RegExp);
    expect(rules[0]?.flags).toBe("i");
    expect(rules[0]?.test("<ORDINARY-CHILD>")).toBe(true);
    expect(rules[1]?.test("first\nsecond\nthird")).toBe(true);
    expect(rules[2]?.test("/path/segment")).toBe(true);
  });

  // Slash characters are valid regex source and are never parsed as delimiters.
  it("accepts slash-containing regex sources", () => {
    const valid = resolvePiRetrySettings({}, {
      piRetry: {
        subagents: {
          match: { systemPromptRegex: [{ pattern: "/path/segment" }] },
        },
      },
    });
    const slashDelimited = resolvePiRetrySettings({}, {
      piRetry: {
        subagents: {
          match: { systemPromptRegex: [{ pattern: "/path/" }] },
        },
      },
    });

    expect(valid.subagents.match.systemPromptRegex).toHaveLength(1);
    expect(slashDelimited.subagents.match.systemPromptRegex).toHaveLength(1);
  });

  // A project list replaces the global list, while an omitted project list inherits it.
  it("replaces or inherits the configured project regex list", () => {
    const global = {
      piRetry: {
        subagents: {
          match: { systemPromptRegex: [{ pattern: "global" }] },
        },
      },
    };
    const inherited = resolvePiRetrySettings(global, { piRetry: { subagents: {} } });
    const replaced = resolvePiRetrySettings(global, {
      piRetry: {
        subagents: {
          match: { systemPromptRegex: [{ pattern: "project" }] },
        },
      },
    });
    const disabled = resolvePiRetrySettings(global, {
      piRetry: { subagents: { match: { systemPromptRegex: [] } } },
    });

    expect(inherited.subagents.match.systemPromptRegex[0]?.source).toBe("global");
    expect(replaced.subagents.match.systemPromptRegex).toHaveLength(1);
    expect(replaced.subagents.match.systemPromptRegex[0]?.source).toBe("project");
    expect(disabled.subagents.match.systemPromptRegex).toEqual([]);
  });

  // A malformed explicit project group disables matching instead of reviving global rules.
  it("invalidates the whole explicit match group on malformed input", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const settings = resolvePiRetrySettings(
      {
        piRetry: {
          subagents: {
            match: { systemPromptRegex: [{ pattern: "global" }] },
          },
        },
      },
      {
        piRetry: {
          subagents: {
            match: { systemPromptRegex: [{ pattern: "project", flags: "g" }] },
          },
        },
      },
    );

    expect(settings.subagents.match.systemPromptRegex).toEqual([]);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("piRetry.subagents.match.systemPromptRegex[0].flags"),
    );
  });

  // Missing child-match configuration preserves ordinary pi-retry takeover.
  it("has no implicit child matcher when match configuration is absent", () => {
    const settings = resolvePiRetrySettings({}, {});

    expect(settings.subagents.match.systemPromptRegex).toEqual([]);
  });
});
describe("resolvePiRetryConfig", () => {
  it("preserves defaults when no piRetry namespace is present", () => {
    expect(resolvePiRetryConfig({}, {})).toEqual(DEFAULT_RETRY_CONFIG);
  });

  it("merges project values over global values", () => {
    const config = resolvePiRetryConfig(
      {
        piRetry: {
          baseDelayMs: 10_000,
          maxDelayMs: 3_600_000,
          multiplier: 2,
        },
      },
      {
        piRetry: {
          maxRetriesAtMaxDelay: 3,
        },
      },
    );

    expect(config).toEqual({
      baseDelayMs: 10_000,
      maxDelayMs: 3_600_000,
      multiplier: 2,
      maxRetriesAtMaxDelay: 3,
    });
  });

  it("falls back per field when a setting is invalid", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const config = resolvePiRetryConfig(
      {
        piRetry: {
          baseDelayMs: -1,
          maxDelayMs: "one hour",
          multiplier: 0,
          maxRetriesAtMaxDelay: 1.5,
        },
      },
      {},
    );

    expect(config).toEqual(DEFAULT_RETRY_CONFIG);
    expect(warning).toHaveBeenCalledTimes(4);
  });
});

describe("loadPiRetryConfig", () => {
  it("loads and merges Pi's global and project settings files", () => {
    const { root, home } = createSettingsTree();
    writeSettings("global", root, home, {
      piRetry: { baseDelayMs: 10_000, maxDelayMs: 3_600_000 },
    });
    writeSettings("project", root, home, {
      piRetry: { maxRetriesAtMaxDelay: 3 },
    });

    expect(loadPiRetryConfig(root, home)).toEqual({
      baseDelayMs: 10_000,
      maxDelayMs: 3_600_000,
      multiplier: 2,
      maxRetriesAtMaxDelay: 3,
    });
  });

  it("uses defaults when either settings file is absent", () => {
    const { root, home } = createSettingsTree();

    expect(loadPiRetryConfig(root, home)).toEqual(DEFAULT_RETRY_CONFIG);
  });

  it("compiles child match rules while loading settings files", () => {
    const { root, home } = createSettingsTree();
    writeSettings("project", root, home, {
      piRetry: {
        subagents: {
          match: {
            systemPromptRegex: [{ pattern: "^worker$", flags: "m" }],
          },
        },
      },
    });

    const settings = loadPiRetrySettings(root, home);
    const rule = settings.subagents.match.systemPromptRegex[0];
    expect(rule).toBeInstanceOf(RegExp);
    expect(rule?.test("worker")).toBe(true);
  });

  it("ignores malformed JSON without preventing startup", () => {
    const { root, home } = createSettingsTree();
    const filePath = join(home, ".pi", "agent", "settings.json");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, "{ malformed", "utf8");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(loadPiRetryConfig(root, home)).toEqual(DEFAULT_RETRY_CONFIG);
    expect(readFileSync(filePath, "utf8")).toBe("{ malformed");
    expect(warning).toHaveBeenCalledOnce();
  });
});
