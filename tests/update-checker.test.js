import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStateStore } from '../src/state/store.js';
import {
  UPDATE_CHECK_CACHE_TTL_MS,
  checkForUpdateIfStale,
  compareSemver,
  isNewerVersion,
  normalizeVersionString,
} from '../src/update/checker.js';

function makeTempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veko-upd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createStateStore(path.join(dir, 'state.json'));
}

test('compareSemver and isNewerVersion handle v-prefixes, multi-digit components, prereleases, and invalid values', () => {
  assert.equal(normalizeVersionString(' v0.2.1 '), '0.2.1');
  assert.equal(normalizeVersionString('invalid'), null);

  assert.equal(compareSemver('0.2.1', '0.2.0'), 1);
  assert.equal(compareSemver('v0.10.0', 'v0.2.0'), 1);
  assert.equal(compareSemver('1.0.0', '0.99.99'), 1);
  assert.equal(compareSemver('0.2.0', 'v0.2.0'), 0);
  assert.equal(compareSemver('0.2.0', '0.2.1'), -1);
  assert.equal(compareSemver('1.0.0', '1.0.0-beta.1'), 1);
  assert.equal(compareSemver('1.0.0-beta.2', '1.0.0-beta.1'), 1);
  assert.equal(compareSemver('not-semver', '0.2.0'), null);

  assert.equal(isNewerVersion('v0.10.0', '0.2.0'), true);
  assert.equal(isNewerVersion('0.2.0', '0.2.0'), false);
  assert.equal(isNewerVersion('0.1.9', '0.2.0'), false);
  assert.equal(isNewerVersion('bad', '0.2.0'), false);
});

test('checkForUpdateIfStale caches 24h, honors force=true, and never throws on HTTP/network/JSON errors', async (t) => {
  const store = makeTempStore(t);
  const config = {
    appVersion: '0.2.0',
    githubRepoUrl: 'https://github.com/holy2k/veko',
    updateCheckUrl: 'https://raw.githubusercontent.com/holy2k/veko/main/package.json',
  };

  let fetchCalls = 0;
  let remoteVersion = '0.2.0';
  const okFetch = async (url, init) => {
    fetchCalls += 1;
    assert.equal(url, config.updateCheckUrl);
    assert.ok(init?.signal);
    return {
      ok: true,
      status: 200,
      async json() {
        return { name: 'veko', version: remoteVersion };
      },
    };
  };

  const t0 = 1_700_000_000_000;
  const r1 = await checkForUpdateIfStale({ store, config, fetchImpl: okFetch, nowMs: t0 });
  assert.equal(r1.ok, true);
  assert.equal(r1.cached, false);
  assert.equal(r1.latestVersion, '0.2.0');
  assert.equal(r1.hasUpdate, false);
  assert.equal(fetchCalls, 1);

  // Within 24h TTL: uses cache without calling fetch
  remoteVersion = '0.3.0';
  const rCached = await checkForUpdateIfStale({
    store,
    config,
    fetchImpl: okFetch,
    nowMs: t0 + UPDATE_CHECK_CACHE_TTL_MS - 1000,
  });
  assert.equal(rCached.ok, true);
  assert.equal(rCached.cached, true);
  assert.equal(rCached.latestVersion, '0.2.0');
  assert.equal(rCached.hasUpdate, false);
  assert.equal(fetchCalls, 1);

  // force=true bypasses cache
  const rForced = await checkForUpdateIfStale({
    store,
    config,
    fetchImpl: okFetch,
    nowMs: t0 + 5000,
    force: true,
  });
  assert.equal(rForced.ok, true);
  assert.equal(rForced.cached, false);
  assert.equal(rForced.latestVersion, '0.3.0');
  assert.equal(rForced.hasUpdate, true);
  assert.equal(fetchCalls, 2);

  // Past 24h TTL: refreshes automatically & persists cachedLatestVersion
  remoteVersion = '0.3.1';
  const rStale = await checkForUpdateIfStale({
    store,
    config,
    fetchImpl: okFetch,
    nowMs: t0 + 5000 + UPDATE_CHECK_CACHE_TTL_MS + 1,
  });
  assert.equal(rStale.ok, true);
  assert.equal(rStale.latestVersion, '0.3.1');
  assert.equal(fetchCalls, 3);
  assert.equal(store.getUpdateState().cachedLatestVersion, '0.3.1');

  // HTTP 404 (e.g. private repo) never throws and preserves cached state
  const r404 = await checkForUpdateIfStale({
    store,
    config,
    force: true,
    nowMs: t0 + UPDATE_CHECK_CACHE_TTL_MS + 2000,
    fetchImpl: async () => ({ ok: false, status: 404 }),
  });
  assert.deepEqual(
    { ok: r404.ok, currentVersion: r404.currentVersion, latestVersion: r404.latestVersion, hasUpdate: r404.hasUpdate },
    { ok: false, currentVersion: '0.2.0', latestVersion: null, hasUpdate: false }
  );
  assert.equal(store.getUpdateState().cachedLatestVersion, '0.3.1');

  // Network error / timeout / invalid JSON / bad URL never throw
  const rErr = await checkForUpdateIfStale({
    store,
    config,
    force: true,
    fetchImpl: async () => {
      throw new Error('The operation timed out');
    },
  });
  assert.equal(rErr.ok, false);
  assert.equal(rErr.hasUpdate, false);
  assert.equal(rErr.latestVersion, null);

  const rBadJson = await checkForUpdateIfStale({
    store,
    config,
    force: true,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        throw new SyntaxError('Unexpected token <');
      },
    }),
  });
  assert.equal(rBadJson.ok, false);

  const rBadUrl = await checkForUpdateIfStale({
    store,
    config: { ...config, updateCheckUrl: 'ftp://invalid/pkg.json' },
    force: true,
    fetchImpl: okFetch,
  });
  assert.equal(rBadUrl.ok, false);
});
