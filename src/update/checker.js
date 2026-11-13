export const DEFAULT_GITHUB_REPO_URL = 'https://github.com/holy2k/veko';
export const DEFAULT_UPDATE_CHECK_URL =
  'https://raw.githubusercontent.com/holy2k/veko/main/package.json';
export const UPDATE_CHECK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_FETCH_TIMEOUT_MS = 4000;

/**
 * Parses a semantic version string (accepting an optional leading `v`).
 * Returns `null` when the string is not a valid `major.minor.patch` version.
 *
 * @param {string} raw
 * @returns {{ major: number, minor: number, patch: number, pre: string[] } | null}
 */
export function parseSemver(raw) {
  const cleaned = String(raw || '')
    .trim()
    .replace(/^v/i, '');
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(cleaned);
  if (!match) return null;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }

  const pre = match[4] ? match[4].split('.').filter(Boolean) : [];
  return { major, minor, patch, pre };
}

/**
 * Normalizes a valid semver string by trimming whitespace and removing any leading `v`.
 *
 * @param {string} raw
 * @returns {string | null}
 */
export function normalizeVersionString(raw) {
  if (!parseSemver(raw)) return null;
  return String(raw || '')
    .trim()
    .replace(/^v/i, '')
    .replace(/\+.*$/, '');
}

/**
 * Compares two semver strings (`1` if `a > b`, `-1` if `a < b`, `0` if equal, `null` if invalid).
 *
 * @param {string} a
 * @param {string} b
 * @returns {1 | -1 | 0 | null}
 */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;

  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;

  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;

  const maxLen = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < maxLen; i++) {
    const idA = pa.pre[i];
    const idB = pb.pre[i];
    if (idA === undefined) return -1;
    if (idB === undefined) return 1;

    const numA = /^\d+$/.test(idA) ? Number(idA) : null;
    const numB = /^\d+$/.test(idB) ? Number(idB) : null;
    if (numA !== null && numB !== null) {
      if (numA !== numB) return numA > numB ? 1 : -1;
    } else if (numA !== null) {
      return -1;
    } else if (numB !== null) {
      return 1;
    } else if (idA !== idB) {
      return idA > idB ? 1 : -1;
    }
  }

  return 0;
}

/**
 * Returns `true` strictly when `candidate` is a valid semver greater than `current`.
 *
 * @param {string} candidate
 * @param {string} current
 * @returns {boolean}
 */
export function isNewerVersion(candidate, current) {
  return compareSemver(candidate, current) === 1;
}

/**
 * Checks for Veko updates via `UPDATE_CHECK_URL` (`raw.githubusercontent.com/.../package.json`)
 * when forced or when the 24-hour cache in `store` is stale. Never throws on network or JSON errors.
 *
 * @param {object} [params]
 * @returns {Promise<{ ok: boolean, currentVersion: string, latestVersion: string | null, hasUpdate: boolean, repoUrl: string, cached?: boolean, error?: string }>}
 */
export async function checkForUpdateIfStale({
  store,
  config = {},
  fetchImpl = globalThis.fetch,
  nowMs = Date.now(),
  force = false,
  cacheTtlMs = UPDATE_CHECK_CACHE_TTL_MS,
  timeoutMs = UPDATE_FETCH_TIMEOUT_MS,
} = {}) {
  const currentVersion = normalizeVersionString(config?.appVersion) || '0.2.0';
  const repoUrl = String(config?.githubRepoUrl || DEFAULT_GITHUB_REPO_URL).trim() || DEFAULT_GITHUB_REPO_URL;
  const updateUrl = String(config?.updateCheckUrl || DEFAULT_UPDATE_CHECK_URL).trim() || DEFAULT_UPDATE_CHECK_URL;
  const updateState = store?.getUpdateState?.() || {};

  if (!force) {
    const lastCheck = updateState.lastUpdateCheckAt;
    if (
      typeof lastCheck === 'number' &&
      Number.isFinite(lastCheck) &&
      nowMs - lastCheck >= 0 &&
      nowMs - lastCheck < cacheTtlMs
    ) {
      const cachedLatest = normalizeVersionString(updateState.cachedLatestVersion);
      return {
        ok: true,
        cached: true,
        currentVersion,
        latestVersion: cachedLatest,
        hasUpdate: Boolean(cachedLatest && isNewerVersion(cachedLatest, currentVersion)),
        repoUrl,
      };
    }
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(updateUrl);
  } catch {
    return {
      ok: false,
      currentVersion,
      latestVersion: null,
      hasUpdate: false,
      repoUrl,
      error: 'Invalid UPDATE_CHECK_URL',
    };
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return {
      ok: false,
      currentVersion,
      latestVersion: null,
      hasUpdate: false,
      repoUrl,
      error: 'Unsupported UPDATE_CHECK_URL protocol',
    };
  }

  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      currentVersion,
      latestVersion: null,
      hasUpdate: false,
      repoUrl,
      error: 'Fetch implementation unavailable',
    };
  }

  try {
    const signal =
      typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
    const res = await fetchImpl(updateUrl, {
      headers: { Accept: 'application/json' },
      ...(signal ? { signal } : {}),
    });
    if (!res || !res.ok) {
      return {
        ok: false,
        currentVersion,
        latestVersion: null,
        hasUpdate: false,
        repoUrl,
        error: `HTTP ${res?.status ?? 'error'}`,
      };
    }

    let data;
    if (typeof res.json === 'function') {
      data = await res.json();
    } else if (typeof res.text === 'function') {
      data = JSON.parse(await res.text());
    } else {
      data = null;
    }

    const latestVersion = normalizeVersionString(data?.version);
    if (!latestVersion) {
      return {
        ok: false,
        currentVersion,
        latestVersion: null,
        hasUpdate: false,
        repoUrl,
        error: 'Remote package.json missing valid version',
      };
    }

    store?.setUpdateState?.({
      lastUpdateCheckAt: nowMs,
      cachedLatestVersion: latestVersion,
    });

    return {
      ok: true,
      cached: false,
      currentVersion,
      latestVersion,
      hasUpdate: isNewerVersion(latestVersion, currentVersion),
      repoUrl,
    };
  } catch (err) {
    return {
      ok: false,
      currentVersion,
      latestVersion: null,
      hasUpdate: false,
      repoUrl,
      error: err?.message || 'Update check failed',
    };
  }
}
