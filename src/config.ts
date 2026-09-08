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
 * Optional child-session fields accepted below piRetry.subagents.
 */
export interface PiRetrySubagentsOverride {
  /** Whether pi-retry takes over retries for recognized child sessions. */
  enabled?: boolean;
  /** Delay before the first child retry, in milliseconds. */
  baseDelayMs?: number;
  /** Maximum child retry delay, in milliseconds. */
  maxDelayMs?: number;
  /** Child retry exponential multiplier. */
  multiplier?: number;
  /** Failed child retries allowed at the maximum delay. */
  maxRetriesAtMaxDelay?: number;
}

/**
 * Effective retry policy used by one recognized child session.
 */
export interface PiRetrySubagentsConfig extends PiRetryConfig {
  /** Whether extension-managed child retry is enabled. */
  enabled: boolean;
}

/**
 * Main and child policies resolved from the two Pi settings scopes.
 */
export interface PiRetrySettings {
  /** Effective policy for an ordinary session. */
  main: PiRetryConfig;
  /** Effective policy for a recognized child; absent fields inherit main. */
  subagents: PiRetrySubagentsConfig;
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
 * @param displayKey User-facing setting path used in warnings.
 * @returns A validated number.
 */
function readNumberSetting(
  settings: SettingsObject,
  key: string,
  fallback: number,
  isValid: (value: number) => boolean,
  displayKey = `${PI_RETRY_SETTINGS_KEY}.${key}`,
): number {
  const value = settings[key];
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isFinite(value) && isValid(value)) {
    return value;
  }

  // Invalid settings should not prevent pi from starting; use the field's
  // inherited/default value and make the configuration error visible.
  console.warn(
    `[pi-retry] Ignoring invalid ${displayKey} value: ${String(value)}`,
  );
  return fallback;
}

/**
 * Read a child enabled flag and fall back to the documented default.
 *
 * @param settings Child settings namespace to inspect.
 * @param fallback Default enabled state.
 * @returns A validated boolean.
 */
function readEnabledSetting(
  settings: SettingsObject,
  fallback: boolean,
): boolean {
  const value = settings.enabled;
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  console.warn(
    `[pi-retry] Ignoring invalid ${PI_RETRY_SETTINGS_KEY}.subagents.enabled value: ${String(value)}`,
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
 * Read a valid nested child namespace while preserving a valid lower scope.
 *
 * @param settings Decoded settings file contents.
 * @param scopeName Global or project scope label for diagnostics.
 * @returns The child namespace, or undefined when absent/invalid.
 */
function getSubagentsSettings(
  settings: unknown,
  scopeName: "global" | "project",
): SettingsObject | undefined {
  const retrySettings = getRetrySettings(settings);
  if (!Object.hasOwn(retrySettings, "subagents")) return undefined;
  const subagents = retrySettings.subagents;
  if (isSettingsObject(subagents)) return subagents;
  console.warn(
    `[pi-retry] Ignoring invalid ${PI_RETRY_SETTINGS_KEY}.subagents namespace in ${scopeName} settings; expected an object.`,
  );
  return undefined;
}

/**
 * Resolve the ordinary policy from global and project namespaces.
 *
 * @param globalSettings Decoded global settings.json contents.
 * @param projectSettings Decoded project settings.json contents.
 * @returns The validated ordinary retry configuration.
 */
function resolveMainRetryConfig(
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
 * Resolve main and child policies with explicit project-over-global precedence.
 *
 * The child object is field-merged from global then project settings and finally
 * overlaid on the effective main policy. An absent child object inherits main;
 * only `{ "enabled": false }` disables extension takeover for recognized child
 * sessions. Non-object child namespaces are warned about and ignored.
 *
 * @param globalSettings Decoded global settings.json contents.
 * @param projectSettings Decoded project settings.json contents.
 * @returns Validated main and child retry policies.
 *
 * TEST:__tests__/unit/config.test.ts[resolvePiRetrySettings]
 */
export function resolvePiRetrySettings(
  globalSettings: unknown,
  projectSettings: unknown,
): PiRetrySettings {
  const main = resolveMainRetryConfig(globalSettings, projectSettings);
  const globalSubagents = getSubagentsSettings(globalSettings, "global");
  const projectSubagents = getSubagentsSettings(projectSettings, "project");
  const mergedSubagents = {
    ...(globalSubagents ?? {}),
    ...(projectSubagents ?? {}),
  } as SettingsObject & PiRetrySubagentsOverride;

  return {
    main,
    subagents: {
      enabled: readEnabledSetting(mergedSubagents, true),
      baseDelayMs: readNumberSetting(
        mergedSubagents,
        "baseDelayMs",
        main.baseDelayMs,
        value => value >= 0,
        `${PI_RETRY_SETTINGS_KEY}.subagents.baseDelayMs`,
      ),
      maxDelayMs: readNumberSetting(
        mergedSubagents,
        "maxDelayMs",
        main.maxDelayMs,
        value => value >= 0,
        `${PI_RETRY_SETTINGS_KEY}.subagents.maxDelayMs`,
      ),
      multiplier: readNumberSetting(
        mergedSubagents,
        "multiplier",
        main.multiplier,
        value => value >= 1,
        `${PI_RETRY_SETTINGS_KEY}.subagents.multiplier`,
      ),
      maxRetriesAtMaxDelay: readNumberSetting(
        mergedSubagents,
        "maxRetriesAtMaxDelay",
        main.maxRetriesAtMaxDelay,
        value => Number.isInteger(value) && value >= 1,
        `${PI_RETRY_SETTINGS_KEY}.subagents.maxRetriesAtMaxDelay`,
      ),
    },
  };
}

/**
 * Resolve only the ordinary retry configuration.
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
  return resolveMainRetryConfig(globalSettings, projectSettings);
}

/**
 * Load and merge Pi's global, project, and nested child settings files.
 *
 * @param cwd Project working directory containing .pi/settings.json.
 * @param homeDirectory Home directory containing .pi/agent/settings.json.
 * @returns Validated ordinary and child retry configurations.
 *
 * TEST:__tests__/unit/config.test.ts[loadPiRetrySettings]
 */
export function loadPiRetrySettings(
  cwd: string = process.cwd(),
  homeDirectory: string = homedir(),
): PiRetrySettings {
  const globalSettings = readSettingsFile(
    join(homeDirectory, ".pi", "agent", "settings.json"),
  );
  const projectSettings = readSettingsFile(join(cwd, ".pi", "settings.json"));
  return resolvePiRetrySettings(globalSettings, projectSettings);
}

/**
 * Load only the ordinary policy for compatibility with existing callers.
 *
 * @param cwd Project working directory containing .pi/settings.json.
 * @param homeDirectory Home directory containing .pi/agent/settings.json.
 * @returns The validated effective ordinary retry configuration.
 */
export function loadPiRetryConfig(
  cwd: string = process.cwd(),
  homeDirectory: string = homedir(),
): PiRetryConfig {
  return loadPiRetrySettings(cwd, homeDirectory).main;
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
