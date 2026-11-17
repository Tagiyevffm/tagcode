import { VERSION } from "../version.js";

export type UpdateInfo = {
  currentVersion: string;
  latestVersion?: string;
  updateAvailable: boolean;
  checkedAt: string;
  packageUrl: string;
  installCommand: string;
  publishedAt?: string;
  error?: string;
};

export type UpdateCheckOptions = {
  currentVersion?: string;
  packageName?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

type VersionParts = {
  numbers: number[];
  prerelease: string[];
};

function parseVersion(value: string): VersionParts | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    value.trim(),
  );
  if (!match) return undefined;
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

/** Compare two semver strings. Returns -1, 0 or 1; invalid versions sort first. */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  for (let index = 0; index < 3; index += 1) {
    const difference = a.numbers[index]! - b.numbers[index]!;
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.min(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const one = a.prerelease[index]!;
    const two = b.prerelease[index]!;
    const oneNumber = /^\d+$/.test(one) ? Number(one) : undefined;
    const twoNumber = /^\d+$/.test(two) ? Number(two) : undefined;
    if (oneNumber !== undefined && twoNumber !== undefined) {
      if (oneNumber !== twoNumber) return oneNumber > twoNumber ? 1 : -1;
      continue;
    }
    if (oneNumber !== undefined) return -1;
    if (twoNumber !== undefined) return 1;
    if (one !== two) return one > two ? 1 : -1;
  }
  if (a.prerelease.length === b.prerelease.length) return 0;
  return a.prerelease.length > b.prerelease.length ? 1 : -1;
}

/**
 * Check the public npm registry for a newer release. Failures are returned in
 * the result rather than thrown so an offline machine never blocks the app.
 */
export async function checkForUpdate(options: UpdateCheckOptions = {}): Promise<UpdateInfo> {
  const currentVersion = options.currentVersion ?? VERSION;
  const packageName = options.packageName ?? "tagcode";
  const packageUrl = `https://www.npmjs.com/package/${packageName}`;
  const checkedAt = new Date().toISOString();
  const base: UpdateInfo = {
    currentVersion,
    updateAvailable: false,
    checkedAt,
    packageUrl,
    installCommand: `npm install -g ${packageName}@latest`,
  };
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(
      `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
      {
        headers: { Accept: "application/json", "User-Agent": `TagCode/${currentVersion}` },
        signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
      },
    );
    if (!response.ok) throw new Error(`Registry returned HTTP ${response.status}`);
    const data = (await response.json()) as {
      version?: unknown;
      dist?: { tarball?: unknown };
    };
    if (typeof data.version !== "string" || !parseVersion(data.version)) {
      throw new Error("Registry response did not include a valid version.");
    }
    return {
      ...base,
      latestVersion: data.version,
      updateAvailable: compareVersions(data.version, currentVersion) > 0,
    };
  } catch (error) {
    return {
      ...base,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
