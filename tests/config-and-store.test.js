import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { normalizePhone, toWhatsAppId, phonesMatch } from '../src/utils/phone.js';
import { createStateStore } from '../src/state/store.js';
import {
  resolveCallSettings,
  isScheduledQuietAt,
  evaluateQuietStatus,
  computeIstanbulTimeTargetMs,
  parseHhMm,
} from '../src/trigger/settings.js';

test('normalizePhone handles Turkish formats and WhatsApp JIDs', () => {
  assert.equal(normalizePhone('0532 111 22 33'), '905321112233');
  assert.equal(normalizePhone('+90 (532) 111-2233'), '905321112233');
  assert.equal(normalizePhone('905321112233@c.us'), '905321112233');
  assert.equal(toWhatsAppId('05321112233'), '905321112233@c.us');
  assert.equal(phonesMatch('+905321112233', '05321112233@c.us'), true);
});

test('normalizePhone handles 10-digit format, device suffixes, and mismatch', () => {
  assert.equal(normalizePhone('5321112233'), '905321112233');
  assert.equal(normalizePhone('905321112233:0@s.whatsapp.net'), '905321112233');
  assert.equal(phonesMatch('05321112233', '05339998877'), false);
  assert.equal(phonesMatch('', '05321112233'), false);
  assert.equal(toWhatsAppId(''), '');
});

test('loadConfig throws on missing required keys and applies spec defaults', () => {
  assert.throws(() => loadConfig({}), /OWNER_PHONE/);
  const cfg = loadConfig({ OWNER_PHONE: '05321112233', GEMINI_API_KEY: 'test-key' });
  assert.equal(cfg.ownerPhone, '905321112233');
  assert.equal(cfg.ownerChatId, '905321112233@c.us');
  assert.equal(cfg.cooldownMinutes, 120);
  assert.equal(cfg.missedRetryMinutes, 30);
  assert.equal(cfg.ownerActiveWindowMinutes, 15);
  assert.equal(cfg.callRingTimeoutSec, 35);
  assert.equal(cfg.callMaxDurationSec, 300);
  assert.equal(cfg.thirdPartyOutreachHours, 24);
});

test('loadConfig parses all keys and supports custom overrides', () => {
  assert.throws(() => loadConfig({ OWNER_PHONE: '05321112233' }), /GEMINI_API_KEY/);
  const custom = loadConfig({
    OWNER_PHONE: '905551234567',
    GEMINI_API_KEY: 'custom-key',
    GEMINI_LIVE_MODEL: 'gemini-exp-custom',
    TTS_VOICE_NAME: 'Kore',
    COOLDOWN_MINUTES: '60',
    MISSED_RETRY_MINUTES: '15',
    OWNER_ACTIVE_WINDOW_MINUTES: '10',
    CALL_RING_TIMEOUT_SEC: '25',
    CALL_MAX_DURATION_SEC: '180',
    THIRD_PARTY_OUTREACH_HOURS: '12',
    CHROME_HEADLESS: 'false',
    CHROME_EXECUTABLE_PATH: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    STATE_FILE_PATH: './custom/path.json',
    ASSISTANT_NAME: 'JarvisCustom',
    ASSISTANT_STYLE: '  diyarbakir  ',
  });
  assert.equal(custom.ownerPhone, '905551234567');
  assert.equal(custom.ownerChatId, '905551234567@c.us');
  assert.equal(custom.geminiApiKey, 'custom-key');
  assert.equal(custom.geminiLiveModel, 'gemini-exp-custom');
  assert.equal(custom.ttsVoiceName, 'Kore');
  assert.equal(custom.cooldownMinutes, 60);
  assert.equal(custom.missedRetryMinutes, 15);
  assert.equal(custom.ownerActiveWindowMinutes, 10);
  assert.equal(custom.callRingTimeoutSec, 25);
  assert.equal(custom.callMaxDurationSec, 180);
  assert.equal(custom.thirdPartyOutreachHours, 12);
  assert.equal(custom.chromeHeadless, false);
  assert.equal(custom.chromeExecutablePath, 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
  assert.equal(custom.stateFilePath, './custom/path.json');
  assert.equal(custom.assistantName, 'JarvisCustom');
  assert.equal(custom.assistantStyle, 'diyarbakir');

  // Verify default assistantName is Veko and default providers are gemini
  const def = loadConfig({ OWNER_PHONE: '05321112233', GEMINI_API_KEY: 'test-key' });
  assert.equal(def.assistantName, 'Veko');
  assert.equal(def.assistantStyle, '');
  assert.equal(def.geminiLiveModel, 'gemini-3.8-live');
  assert.equal(def.geminiTextModel, 'gemini-3.8-flash');
  assert.equal(def.aiVoiceProvider, 'gemini');
  assert.equal(def.aiVoiceModel, 'gemini-3.8-live');
  assert.equal(def.aiTextProvider, 'gemini');
  assert.equal(def.aiTextProtocol, 'gemini');
  assert.equal(def.aiTextModel, 'gemini-3.8-flash');
  assert.equal(def.ttsVoiceName, 'Aoede');
  assert.equal(def.chromeHeadless, 'new');
  assert.equal(def.chromeExecutablePath, '');
  assert.equal(def.stateFilePath, './data/state.json');
});

test('loadConfig supports non-Gemini AI providers without requiring GEMINI_API_KEY', () => {
  const ollamaOnly = loadConfig({
    OWNER_PHONE: '05321112233',
    AI_VOICE_PROVIDER: 'none',
    AI_TEXT_PROVIDER: 'ollama',
    AI_TEXT_MODEL: 'qwen3:8b',
  });
  assert.equal(ollamaOnly.aiVoiceProvider, 'none');
  assert.equal(ollamaOnly.aiTextProvider, 'ollama');
  assert.equal(ollamaOnly.aiTextProtocol, 'openai-compatible');
  assert.equal(ollamaOnly.aiTextBaseUrl, 'http://localhost:11434/v1');
  assert.equal(ollamaOnly.aiTextModel, 'qwen3:8b');
  assert.equal(ollamaOnly.aiTextApiKey, '');

  const hybridOpenAI = loadConfig({
    OWNER_PHONE: '05321112233',
    AI_VOICE_PROVIDER: 'openai',
    OPENAI_API_KEY: 'sk-openai-test',
    AI_TEXT_PROVIDER: 'deepseek',
    DEEPSEEK_API_KEY: 'sk-ds-test',
  });
  assert.equal(hybridOpenAI.aiVoiceProvider, 'openai');
  assert.equal(hybridOpenAI.aiVoiceModel, 'gpt-realtime-2.1');
  assert.equal(hybridOpenAI.aiVoiceApiKey, 'sk-openai-test');
  assert.equal(hybridOpenAI.ttsVoiceName, 'cedar');
  assert.equal(hybridOpenAI.aiTextProvider, 'deepseek');
  assert.equal(hybridOpenAI.aiTextModel, 'deepseek-v4-flash');
  assert.equal(hybridOpenAI.aiTextApiKey, 'sk-ds-test');

  assert.throws(
    () => loadConfig({ OWNER_PHONE: '05321112233', AI_VOICE_PROVIDER: 'none', AI_TEXT_PROVIDER: 'deepseek' }),
    /DEEPSEEK_API_KEY|AI_TEXT_API_KEY/
  );
  assert.throws(
    () => loadConfig({ OWNER_PHONE: '05321112233', AI_VOICE_PROVIDER: 'none', AI_TEXT_PROVIDER: 'openai-compatible' }),
    /AI_TEXT_BASE_URL/
  );
});

test('createStateStore persists chat state and tracks bot message IDs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpj-'));
  const file = path.join(dir, 'state.json');
  const store1 = createStateStore(file);
  store1.updateChatState('905551234567@c.us', { lastCallStatus: 'missed', missedRetryCount: 0 });
  store1.setPendingCallChatId('905551234567@c.us');
  store1.markBotMessageId('msg-1');
  store1.flush();

  const store2 = createStateStore(file);
  assert.equal(store2.getChatState('905551234567@c.us').lastCallStatus, 'missed');
  assert.equal(store2.getPendingCallChatId(), '905551234567@c.us');
  assert.equal(store2.consumeBotMessageId('msg-1'), true);
  assert.equal(store2.consumeBotMessageId('msg-1'), false);
});

test('createStateStore handles silence state, unconfigured chat lookup, and bot ID cap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpj-silence-'));
  const file = path.join(dir, 'state.json');
  const store = createStateStore(file);

  assert.deepEqual(store.getChatState('unknown@c.us'), {});
  assert.equal(store.isSilenced(1000), false);

  store.setSilencedUntil(5000);
  assert.equal(store.isSilenced(4999), true);
  assert.equal(store.isSilenced(5000), false);
  assert.equal(store.isSilenced(5001), false);

  // Test 500 ID bound
  for (let i = 0; i < 550; i++) {
    store.markBotMessageId(`bot-id-${i}`);
  }
  // The first 50 should have been pruned
  assert.equal(store.consumeBotMessageId('bot-id-0'), false);
  assert.equal(store.consumeBotMessageId('bot-id-49'), false);
  // bot-id-50 through 549 should exist
  assert.equal(store.consumeBotMessageId('bot-id-50'), true);
  assert.equal(store.consumeBotMessageId('bot-id-549'), true);
});

test('createStateStore manages ownerChatHistory (cap 24) and pendingOutgoingDraft (15-min TTL) with persistence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpj-store-text-'));
  const file = path.join(dir, 'state.json');
  const store = createStateStore(file);

  assert.deepEqual(store.getOwnerChatHistory(), []);
  for (let i = 1; i <= 30; i++) {
    store.appendOwnerChatMessage({
      role: i % 2 === 0 ? 'assistant' : 'user',
      content: `msg-${i}`,
      timestamp: 1000 + i,
    });
  }
  const hist = store.getOwnerChatHistory();
  assert.equal(hist.length, 24);
  assert.equal(hist[0].content, 'msg-7');
  assert.equal(hist[23].content, 'msg-30');

  const t0 = 1_000_000;
  store.setPendingOutgoingDraft({
    chatId: '905551110001@c.us',
    recipientName: 'Eren',
    messageText: 'Fiyat 5000 TL',
    isThirdParty: false,
    proposedAt: t0,
    proposedInTurnId: 'turn-1',
  });
  assert.equal(store.getPendingOutgoingDraft(t0 + 14 * 60_000).messageText, 'Fiyat 5000 TL');

  store.flush();
  const reloaded = createStateStore(file);
  assert.equal(reloaded.getOwnerChatHistory().length, 24);
  assert.equal(reloaded.getOwnerChatHistory()[23].content, 'msg-30');
  assert.equal(reloaded.getPendingOutgoingDraft(t0 + 10 * 60_000).chatId, '905551110001@c.us');

  // Expires at 15 minutes
  assert.equal(reloaded.getPendingOutgoingDraft(t0 + 15 * 60_000), null);
  assert.equal(reloaded.getPendingOutgoingDraft(t0 + 1000), null);

  // Manual clear
  reloaded.setPendingOutgoingDraft({
    chatId: '905551110001@c.us',
    messageText: 'Test',
    proposedAt: t0,
    proposedInTurnId: 'turn-2',
  });
  reloaded.clearPendingOutgoingDraft();
  assert.equal(reloaded.getPendingOutgoingDraft(t0 + 1000), null);

  reloaded.clearOwnerChatHistory();
  assert.deepEqual(reloaded.getOwnerChatHistory(), []);
});

test('review fixes: pendingOutgoingDraft and ownerChatHistory persist immediately across reload without flush', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veko-store-immediate-'));
  const file = path.join(tmpDir, 'state.json');
  try {
    const store = createStateStore(file);
    const t0 = 2_000_000;
    store.appendOwnerChatMessage({ role: 'user', content: 'Selam Veko', timestamp: t0 });
    store.setPendingOutgoingDraft({
      chatId: '905551110001@c.us',
      recipientName: 'Eren',
      messageText: 'Hemen dönüyoruz',
      isThirdParty: true,
      proposedAt: t0,
      proposedInTurnId: 'turn-imm-1',
    });

    const reloaded1 = createStateStore(file);
    assert.equal(reloaded1.getOwnerChatHistory().length, 1);
    assert.equal(reloaded1.getOwnerChatHistory()[0].content, 'Selam Veko');
    const draft = reloaded1.getPendingOutgoingDraft(t0 + 1000);
    assert.equal(draft.chatId, '905551110001@c.us');
    assert.equal(draft.isThirdParty, true);

    store.clearPendingOutgoingDraft();
    store.clearOwnerChatHistory();

    const reloaded2 = createStateStore(file);
    assert.equal(reloaded2.getPendingOutgoingDraft(t0 + 1000), null);
    assert.deepEqual(reloaded2.getOwnerChatHistory(), []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('loadConfig reads appVersion, githubRepoUrl, and updateCheckUrl with overrides', () => {
  const def = loadConfig({ OWNER_PHONE: '05321112233', GEMINI_API_KEY: 'test-key' });
  assert.equal(def.appVersion, '0.2.1');
  assert.equal(def.githubRepoUrl, 'https://github.com/holy2k/veko');
  assert.equal(def.updateCheckUrl, 'https://raw.githubusercontent.com/holy2k/veko/main/package.json');

  const custom = loadConfig(
    {
      OWNER_PHONE: '05321112233',
      GEMINI_API_KEY: 'test-key',
      GITHUB_REPO_URL: 'https://github.com/example/veko-fork/',
      UPDATE_CHECK_URL: 'https://example.com/veko/package.json',
    },
    { appVersion: '9.9.9' }
  );
  assert.equal(custom.appVersion, '9.9.9');
  assert.equal(custom.githubRepoUrl, 'https://github.com/example/veko-fork');
  assert.equal(custom.updateCheckUrl, 'https://example.com/veko/package.json');
});

test('createStateStore defaults legacy update state and persists destructured update methods', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpj-store-update-'));
  const file = path.join(tmpDir, 'state.json');
  try {
    fs.writeFileSync(
      file,
      JSON.stringify({ chats: { '905551110001@c.us': { lastCallStatus: 'missed', missedRetryCount: 0 } } }),
      'utf8'
    );
    const legacyStore = createStateStore(file);
    assert.deepEqual(legacyStore.getUpdateState(), {
      installNotifiedAt: null,
      lastStartupNoticeAt: null,
      updateNotificationsEnabled: true,
      lastUpdateCheckAt: null,
      cachedLatestVersion: null,
      lastNotifiedVersion: null,
    });

    const { setUpdateState, getUpdateState } = legacyStore;
    const updated = setUpdateState({
      installNotifiedAt: 1000,
      lastStartupNoticeAt: 2000,
      updateNotificationsEnabled: false,
      lastUpdateCheckAt: 3000,
      cachedLatestVersion: '0.3.0',
      lastNotifiedVersion: '0.3.0',
    });
    assert.deepEqual(updated, getUpdateState());

    const reloaded = createStateStore(file);
    assert.deepEqual(reloaded.getUpdateState(), {
      installNotifiedAt: 1000,
      lastStartupNoticeAt: 2000,
      updateNotificationsEnabled: false,
      lastUpdateCheckAt: 3000,
      cachedLatestVersion: '0.3.0',
      lastNotifiedVersion: '0.3.0',
    });
    assert.equal(reloaded.getChatState('905551110001@c.us').lastCallStatus, 'missed');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('loadConfig reads smart call policy, 10m delay, and quiet hours defaults/overrides', () => {
  const def = loadConfig({ OWNER_PHONE: '05321112233', GEMINI_API_KEY: 'test-key' });
  assert.equal(def.callPolicy, 'smart');
  assert.equal(def.callDelayMinutes, 10);
  assert.equal(def.quietHoursEnabled, false);
  assert.equal(def.quietHoursStart, '22:00');
  assert.equal(def.quietHoursEnd, '09:00');
  assert.equal(def.quietHoursResumeMode, 'auto');
  assert.equal(def.quietHoursAllowUrgent, false);

  const implicitQuiet = loadConfig({
    OWNER_PHONE: '05321112233',
    GEMINI_API_KEY: 'test-key',
    CALL_POLICY: 'on_demand',
    CALL_DELAY_MINUTES: '3',
    QUIET_HOURS_START: '23:30',
    QUIET_HOURS_END: '08:30',
    QUIET_HOURS_RESUME_MODE: 'ask',
    QUIET_HOURS_ALLOW_URGENT: 'true',
  });
  assert.equal(implicitQuiet.callPolicy, 'on_demand');
  assert.equal(implicitQuiet.callDelayMinutes, 3);
  assert.equal(implicitQuiet.quietHoursEnabled, true);
  assert.equal(implicitQuiet.quietHoursStart, '23:30');
  assert.equal(implicitQuiet.quietHoursEnd, '08:30');
  assert.equal(implicitQuiet.quietHoursResumeMode, 'ask');
  assert.equal(implicitQuiet.quietHoursAllowUrgent, true);

  const explicitDisabled = loadConfig({
    OWNER_PHONE: '05321112233',
    GEMINI_API_KEY: 'test-key',
    QUIET_HOURS_ENABLED: 'false',
    QUIET_HOURS_START: '22:00',
    QUIET_HOURS_END: '09:00',
  });
  assert.equal(explicitDisabled.quietHoursEnabled, false);
});

test('createStateStore persists callSettings, pendingDelayedCalls, quietQueue, and quietScheduleState', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpj-store-settings-'));
  const file = path.join(tmpDir, 'state.json');
  try {
    const store = createStateStore(file);
    const cfg = loadConfig({ OWNER_PHONE: '05321112233', GEMINI_API_KEY: 'test-key' });

    store.setCallSettingsOverrides({
      callDelayMinutes: 5,
      quietHoursEnabled: true,
      quietHoursStart: '21:00',
      quietHoursEnd: '10:00',
      quietHoursResumeMode: 'ask',
      quietHoursAllowUrgent: true,
    });
    store.upsertPendingDelayedCall({
      chatId: '905551110001@c.us',
      customerName: 'Mehmet',
      dueAtMs: 2_000_000,
      firstMessageAt: 1_400_000,
      lastMessageAt: 1_400_000,
      messages: ['Fiyat alabilir miyim?'],
      priority: 'normal',
    });
    store.enqueueQuietMessage({
      chatId: '905551110002@c.us',
      customerName: 'Ayşe',
      phone: '905551110002',
      priority: 'normal',
      summary: 'Bilgi sordu',
      latestMessage: 'Fiyat nedir?',
      atMs: 1_500_000,
    });
    store.enqueueQuietMessage({
      chatId: '905551110002@c.us',
      customerName: 'Ayşe',
      phone: '905551110002',
      priority: 'urgent',
      summary: 'Acil dönüş bekliyor',
      latestMessage: 'Acil bilgi lütfen',
      atMs: 1_600_000,
    });
    store.setQuietScheduleState({
      lastMorningPromptYmd: '2026-11-13',
      wasQuietPendingResume: true,
      awaitingOwnerConfirm: true,
      snoozedUntilMs: 3_000_000,
      resumeConfirmedYmd: null,
    });

    const reloaded = createStateStore(file);
    const resolved = resolveCallSettings(cfg, reloaded);
    assert.equal(resolved.callPolicy, 'smart');
    assert.equal(resolved.callDelayMinutes, 5);
    assert.equal(resolved.quietHoursEnabled, true);
    assert.equal(resolved.quietHoursStart, '21:00');
    assert.equal(resolved.quietHoursEnd, '10:00');
    assert.equal(resolved.quietHoursResumeMode, 'ask');
    assert.equal(resolved.quietHoursAllowUrgent, true);

    assert.equal(reloaded.getPendingDelayedCall('905551110001@c.us').customerName, 'Mehmet');
    const q = reloaded.getQuietQueue();
    assert.equal(q.length, 1);
    assert.equal(q[0].messageCount, 2);
    assert.equal(q[0].priority, 'urgent');
    assert.equal(reloaded.getQuietScheduleState().awaitingOwnerConfirm, true);

    reloaded.resetCallSettingsOverrides();
    assert.equal(resolveCallSettings(cfg, reloaded).callDelayMinutes, 10);
    assert.equal(resolveCallSettings(cfg, reloaded).quietHoursEnabled, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('quiet hours evaluator handles Europe/Istanbul overnight, same-day, snooze, and morning confirm windows', () => {
  assert.deepEqual(parseHhMm('09:30'), {
    hour: 9,
    minute: 30,
    totalMinutes: 570,
    formatted: '09:30',
  });
  assert.equal(parseHhMm('25:00'), null);

  const settings = {
    quietHoursEnabled: true,
    quietHoursStart: '22:00',
    quietHoursEnd: '09:00',
    quietHoursResumeMode: 'ask',
  };
  // 2026-11-13 22:30 Istanbul == 19:30 UTC
  const nightMs = Date.UTC(2026, 10, 13, 19, 30, 0);
  // 2026-11-14 08:59 Istanbul == 05:59 UTC
  const earlyMorningMs = Date.UTC(2026, 10, 14, 5, 59, 0);
  // 2026-11-14 09:00 Istanbul == 06:00 UTC
  const nineAmMs = Date.UTC(2026, 10, 14, 6, 0, 0);
  // 2026-11-14 14:00 Istanbul == 11:00 UTC
  const afternoonMs = Date.UTC(2026, 10, 14, 11, 0, 0);

  assert.equal(isScheduledQuietAt(settings, nightMs), true);
  assert.equal(isScheduledQuietAt(settings, earlyMorningMs), true);
  assert.equal(isScheduledQuietAt(settings, nineAmMs), false);

  // Same-day window 13:00 - 15:00
  const midday = { quietHoursEnabled: true, quietHoursStart: '13:00', quietHoursEnd: '15:00' };
  assert.equal(isScheduledQuietAt(midday, afternoonMs), true);
  assert.equal(isScheduledQuietAt(midday, nineAmMs), false);

  // Enabling at 14:00 without prior quiet session does NOT emit morning prompt
  const noSpurious = evaluateQuietStatus(
    settings,
    { wasQuietPendingResume: false, lastMorningPromptYmd: null, awaitingOwnerConfirm: false },
    afternoonMs,
    0
  );
  assert.equal(noSpurious.isQuietNow, false);
  assert.equal(noSpurious.shouldSendMorningPrompt, false);

  // Transition at 09:00 after quiet session emits morning prompt once
  const morningDue = evaluateQuietStatus(
    settings,
    { wasQuietPendingResume: true, lastMorningPromptYmd: '2026-11-13', awaitingOwnerConfirm: false },
    nineAmMs,
    0
  );
  assert.equal(morningDue.isQuietNow, false);
  assert.equal(morningDue.shouldSendMorningPrompt, true);
  assert.equal(morningDue.todayYmd, '2026-11-14');

  // Target Istanbul HH:MM solver
  const target1030 = computeIstanbulTimeTargetMs('10:30', nineAmMs);
  assert.equal(target1030, Date.UTC(2026, 10, 14, 7, 30, 0));
});
