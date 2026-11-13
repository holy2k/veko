import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { normalizePhone, toWhatsAppId, phonesMatch } from '../src/utils/phone.js';
import { createStateStore } from '../src/state/store.js';

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
  assert.equal(def.appVersion, '0.2.0');
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
