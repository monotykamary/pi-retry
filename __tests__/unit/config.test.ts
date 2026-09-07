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
  resolvePiRetryConfig,
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
