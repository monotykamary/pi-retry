/**
 * Installed-SDK version helpers for tests that assert SDK-specific behavior.
 *
 * The CI matrix runs the suite against several Pi SDK releases. Some assertions
 * check fields that only newer SDKs emit (for example `agent_settled.aborted`,
 * added in Pi 1.1.0); those assertions must only run where the field exists.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Read the version of the installed `@earendil-works/pi-coding-agent`.
 *
 * The package does not export its own package.json, so the file is read from
 * the project's node_modules (vitest runs with the project root as cwd).
 *
 * @returns The installed version, or undefined when it cannot be determined.
 */
function readInstalledSdkVersion(): string | undefined {
  try {
    const manifest = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/** Version of the SDK this test run uses; read once because it cannot change mid-run. */
const installedSdkVersion = readInstalledSdkVersion();

/**
 * Compare two dotted numeric versions; pre-release suffixes are ignored.
 *
 * @param left First version, such as "1.0.4".
 * @param right Second version, such as "1.1.0".
 * @returns A negative number when left < right, 0 when equal, positive when left > right.
 */
function compareVersions(left: string, right: string): number {
  const parse = (version: string) => version.split("-")[0]!.split(".").map(part => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Check whether the installed SDK is at least a given release.
 *
 * An unreadable version counts as "new enough", so a broken lookup makes the
 * assertions run (and fail loudly) instead of silently skipping them.
 *
 * @param minimum Lowest SDK version that provides the behavior, such as "1.1.0".
 * @returns True when the installed SDK is the same as or newer than `minimum`.
 *
 * TEST:__tests__/integration/native-child-lifecycle.test.ts[preserves single retry ownership for Pi 1.1 transient error, settles a prompt promptly when abort interrupts child backoff]
 */
export function sdkAtLeast(minimum: string): boolean {
  if (installedSdkVersion === undefined) return true;
  return compareVersions(installedSdkVersion, minimum) >= 0;
}
