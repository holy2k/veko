import fs from 'node:fs';
import { normalizePhone, toWhatsAppId } from './utils/phone.js';
import { resolveTextProviderConfig, resolveVoiceProviderConfig } from './ai/providers.js';
import { DEFAULT_GITHUB_REPO_URL, DEFAULT_UPDATE_CHECK_URL } from './update/checker.js';
import {
  DEFAULT_CALL_DELAY_MINUTES,
  DEFAULT_CALL_POLICY,
  DEFAULT_QUIET_END,
  DEFAULT_QUIET_START,
  DEFAULT_RESUME_MODE,
  VALID_CALL_POLICIES,
  VALID_RESUME_MODES,
  parseHhMm,
} from './trigger/settings.js';

let PACKAGE_META = {
  version: '0.2.0',
  repositoryUrl: DEFAULT_GITHUB_REPO_URL,
};
try {
  const pkgPath = new URL('../package.json', import.meta.url);
  const parsedPkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const rawRepo =
    typeof parsedPkg?.repository === 'string'
      ? parsedPkg.repository
      : parsedPkg?.repository?.url || '';
  const cleanedRepo = String(rawRepo)
    .replace(/^git\+/i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .trim();
  PACKAGE_META = {
    version: String(parsedPkg?.version || '0.2.0').trim() || '0.2.0',
    repositoryUrl: cleanedRepo || DEFAULT_GITHUB_REPO_URL,
  };
} catch {
  // Fallback safely if package.json cannot be read
}

/**
 * Loads application configuration from an environment map (defaults to process.env).
 * Enforces presence of required keys (OWNER_PHONE plus active AI provider keys) and applies defaults.
 *
 * @param {Record<string, string | undefined>} [env=process.env]
 * @param {object} [deps={}]
 * @returns {object}
 */
export function loadConfig(env = process.env, deps = {}) {
  if (!env || typeof env !== 'object') {
    throw new Error('Missing or invalid environment variables: OWNER_PHONE is required');
  }

  if (!env.OWNER_PHONE || !normalizePhone(env.OWNER_PHONE)) {
    throw new Error('Missing or invalid required environment variable: OWNER_PHONE');
  }

  const ownerPhone = normalizePhone(env.OWNER_PHONE);
  const ownerChatId = toWhatsAppId(env.OWNER_PHONE);

  const voiceCfg = resolveVoiceProviderConfig(env);
  const textCfg = resolveTextProviderConfig(env);

  let chromeHeadless = 'new';
  if (env.CHROME_HEADLESS !== undefined) {
    if (env.CHROME_HEADLESS === 'true') {
      chromeHeadless = true;
    } else if (env.CHROME_HEADLESS === 'false') {
      chromeHeadless = false;
    } else {
      chromeHeadless = env.CHROME_HEADLESS;
    }
  }

  const rawGeminiKey = String(env.GEMINI_API_KEY || '').trim();
  const geminiLiveModel =
    env.GEMINI_LIVE_MODEL?.trim() ||
    (voiceCfg.provider === 'gemini' ? voiceCfg.model : 'gemini-3.8-live');
  const geminiTextModel =
    env.GEMINI_TEXT_MODEL?.trim() ||
    (textCfg.provider === 'gemini' ? textCfg.model : 'gemini-3.8-flash');

  const rawCallPolicy = String(env.CALL_POLICY || DEFAULT_CALL_POLICY).trim().toLowerCase();
  const callPolicy = VALID_CALL_POLICIES.includes(rawCallPolicy) ? rawCallPolicy : DEFAULT_CALL_POLICY;
  const rawDelayMinutes = env.CALL_DELAY_MINUTES;
  const parsedDelayMinutes = rawDelayMinutes !== undefined && rawDelayMinutes !== '' ? Number(rawDelayMinutes) : NaN;
  const callDelayMinutes =
    Number.isFinite(parsedDelayMinutes) && parsedDelayMinutes >= 0
      ? Math.min(parsedDelayMinutes, 180)
      : DEFAULT_CALL_DELAY_MINUTES;

  const rawQuietStart = parseHhMm(String(env.QUIET_HOURS_START || ''));
  const rawQuietEnd = parseHhMm(String(env.QUIET_HOURS_END || ''));
  const rawQuietFlag = String(env.QUIET_HOURS_ENABLED ?? '').trim().toLowerCase();
  const quietHoursEnabled =
    rawQuietFlag === 'false' || rawQuietFlag === '0' || rawQuietFlag === 'no'
      ? false
      : rawQuietFlag === 'true' || rawQuietFlag === '1' || rawQuietFlag === 'yes'
        ? true
        : Boolean(rawQuietStart && rawQuietEnd);
  const rawResumeMode = String(env.QUIET_HOURS_RESUME_MODE || DEFAULT_RESUME_MODE).trim().toLowerCase();
  const quietHoursResumeMode = VALID_RESUME_MODES.includes(rawResumeMode)
    ? rawResumeMode
    : DEFAULT_RESUME_MODE;
  const rawAllowUrgent = String(env.QUIET_HOURS_ALLOW_URGENT ?? '').trim().toLowerCase();
  const quietHoursAllowUrgent =
    rawAllowUrgent === 'true' || rawAllowUrgent === '1' || rawAllowUrgent === 'yes';

  return {
    ownerPhone,
    ownerChatId,
    geminiApiKey:
      rawGeminiKey ||
      (voiceCfg.provider === 'gemini' ? voiceCfg.apiKey : '') ||
      (textCfg.provider === 'gemini' ? textCfg.apiKey : ''),
    geminiLiveModel,
    geminiTextModel,
    ttsVoiceName: voiceCfg.voiceName || '',
    aiVoiceProvider: voiceCfg.provider,
    aiVoiceModel: voiceCfg.model,
    aiVoiceApiKey: voiceCfg.apiKey,
    aiVoiceBaseUrl: voiceCfg.baseUrl,
    aiTextProvider: textCfg.provider,
    aiTextProtocol: textCfg.protocol,
    aiTextModel: textCfg.model,
    aiTextApiKey: textCfg.apiKey,
    aiTextBaseUrl: textCfg.baseUrl,
    cooldownMinutes: Number(env.COOLDOWN_MINUTES ?? 120),
    missedRetryMinutes: Number(env.MISSED_RETRY_MINUTES ?? 30),
    ownerActiveWindowMinutes: Number(env.OWNER_ACTIVE_WINDOW_MINUTES ?? 15),
    callRingTimeoutSec: Number(env.CALL_RING_TIMEOUT_SEC ?? 35),
    callMaxDurationSec: Number(env.CALL_MAX_DURATION_SEC ?? 300),
    thirdPartyOutreachHours: Number(env.THIRD_PARTY_OUTREACH_HOURS ?? 24),
    callPolicy,
    callDelayMinutes,
    quietHoursEnabled,
    quietHoursStart: rawQuietStart ? rawQuietStart.formatted : DEFAULT_QUIET_START,
    quietHoursEnd: rawQuietEnd ? rawQuietEnd.formatted : DEFAULT_QUIET_END,
    quietHoursResumeMode,
    quietHoursAllowUrgent,
    chromeHeadless,
    chromeExecutablePath: env.CHROME_EXECUTABLE_PATH?.trim() || '',
    stateFilePath: env.STATE_FILE_PATH || './data/state.json',
    assistantName: env.ASSISTANT_NAME?.trim() || 'Veko',
    assistantStyle: String(env.ASSISTANT_STYLE || '').trim(),
    appVersion: String(deps.appVersion || PACKAGE_META.version).trim() || '0.2.0',
    githubRepoUrl:
      String(env.GITHUB_REPO_URL || '').trim().replace(/\/+$/, '') || PACKAGE_META.repositoryUrl,
    updateCheckUrl: String(env.UPDATE_CHECK_URL || '').trim() || DEFAULT_UPDATE_CHECK_URL,
  };
}
