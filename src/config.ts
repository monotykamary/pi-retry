/**
 * Settings-backed configuration for the pi-retry extension.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_BACKOFF_CONFIG,
  type BackoffConfig,
} from "./retry-logic.js";

/**
 * Complete retry configuration used by the extension.
 */
export interface PiRetryConfig extends BackoffConfig {
  /** Number of failed retries allowed after the delay reaches maxDelayMs. */
  maxRetriesAtMaxDelay: number;
}

/**
 * Default values preserve the extension's existing behavior while making it
 * possible to tune the schedule through settings.json.
 */
export const DEFAULT_RETRY_CONFIG: PiRetryConfig = {
  ...DEFAULT_BACKOFF_CONFIG,
  maxRetriesAtMaxDelay: 3,
};

/** Root settings key owned by this extension. */
export const PI_RETRY_SETTINGS_KEY = "piRetry";

type SettingsObject = Record<string, unknown>;

/**
 * Check whether a decoded JSON value can be read as a settings object.
 *
 * @param value Decoded JSON value to inspect.
 * @returns True when the value is a non-array object.
 */
function isSettingsObject(value: unknown): value is SettingsObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read one numeric setting and fall back when it fails validation.
 *
 * @param settings Settings namespace to inspect.
 * @param key Setting name to read.
 * @param fallback Default value used for invalid or missing input.
 * @param isValid Predicate for the accepted numeric range.
 * @returns A validated number.
 */
function readNumberSetting(
  settings: SettingsObject,
  key: string,
  fallback: number,
  isValid: (value: number) => boolean,
): number {
  const value = settings[key];
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isFinite(value) && isValid(value)) {
    return value;
  }

  // Invalid settings should not prevent pi from starting; use the field's
  // default and make the configuration error visible to the user.
  console.warn(
    `[pi-retry] Ignoring invalid ${PI_RETRY_SETTINGS_KEY}.${key} value: ${String(value)}`,
  );
  return fallback;
}

/**
 * Extract the extension namespace from a decoded settings file.
 *
 * @param settings Decoded settings file contents.
 * @returns The piRetry namespace, or an empty object when absent/invalid.
 */
function getRetrySettings(settings: unknown): SettingsObject {
  if (!isSettingsObject(settings)) return {};
  const retrySettings = settings[PI_RETRY_SETTINGS_KEY];
  return isSettingsObject(retrySettings) ? retrySettings : {};
}

/**
 * Merge global and project namespaces, then validate every supported field.
 *
 * @param globalSettings Decoded global settings.json contents.
 * @param projectSettings Decoded project settings.json contents.
 * @returns The validated effective retry configuration.
 *
 * TEST:__tests__/unit/config.test.ts[resolvePiRetryConfig]
 */
export function resolvePiRetryConfig(
  globalSettings: unknown,
  projectSettings: unknown,
): PiRetryConfig {
  const mergedSettings = {
    ...getRetrySettings(globalSettings),
    ...getRetrySettings(projectSettings),
  };

  return {
    baseDelayMs: readNumberSetting(
      mergedSettings,
      "baseDelayMs",
      DEFAULT_RETRY_CONFIG.baseDelayMs,
      value => value >= 0,
    ),
    maxDelayMs: readNumberSetting(
      mergedSettings,
      "maxDelayMs",
      DEFAULT_RETRY_CONFIG.maxDelayMs,
      value => value >= 0,
    ),
    multiplier: readNumberSetting(
      mergedSettings,
      "multiplier",
      DEFAULT_RETRY_CONFIG.multiplier,
      value => value >= 1,
    ),
    maxRetriesAtMaxDelay: readNumberSetting(
      mergedSettings,
      "maxRetriesAtMaxDelay",
      DEFAULT_RETRY_CONFIG.maxRetriesAtMaxDelay,
      value => Number.isInteger(value) && value >= 1,
    ),
  };
}

/**
 * Load and merge Pi's global and project settings files.
 *
 * @param cwd Project working directory containing .pi/settings.json.
 * @param homeDirectory Home directory containing .pi/agent/settings.json.
 * @returns The validated effective retry configuration.
 *
 * TEST:__tests__/unit/config.test.ts[loadPiRetryConfig]
 */
export function loadPiRetryConfig(
  cwd: string = process.cwd(),
  homeDirectory: string = homedir(),
): PiRetryConfig {
  const globalSettings = readSettingsFile(
    join(homeDirectory, ".pi", "agent", "settings.json"),
  );
  const projectSettings = readSettingsFile(join(cwd, ".pi", "settings.json"));
  return resolvePiRetryConfig(globalSettings, projectSettings);
}

/**
 * Read a settings file without making startup dependent on optional files.
 *
 * @param filePath Absolute settings file path.
 * @returns Decoded JSON contents, or an empty object when unavailable.
 */
function readSettingsFile(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    const code = isSettingsObject(error) && typeof error.code === "string"
      ? error.code
      : undefined;
    if (code !== "ENOENT") {
      console.warn(
        `[pi-retry] Could not read settings file ${filePath}: ${String(error)}`,
      );
    }
    return {};
  }
}
