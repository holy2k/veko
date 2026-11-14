import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createStateStore } from '../src/state/store.js';
import { createOrchestrator } from '../src/index.js';

const OWNER_CHAT_ID = '905550000100@c.us';
const CUSTOMER_CHAT_ID = '905551112233@c.us';

function createBaseConfig() {
  return {
    ownerPhone: '905550000100',
    ownerChatId: OWNER_CHAT_ID,
    assistantName: 'Veko',
    cooldownMinutes: 120,
    missedRetryMinutes: 30,
    ownerActiveWindowMinutes: 15,
    thirdPartyOutreachHours: 24,
  };
}

async function createTempStore(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wp-jarvis-orch-'));
  const filePath = path.join(dir, 'state.json');
  const store = createStateStore(filePath);
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return store;
}

function createFakeWhatsApp({
  historyByChat = {},
  contactsByQuery = {},
  contactsList = [],
} = {}) {
  const sent = [];
  const fetchCalls = [];
  const searchCalls = [];

  return {
    sent,
    fetchCalls,
    searchCalls,
    async sendMessage(chatId, text, options = {}) {
      const id = `bot-msg-${sent.length + 1}`;
      sent.push({ id, chatId, text, options });
      return { id };
    },
    async fetchChatHistory(chatId, limit) {
      fetchCalls.push({ chatId, limit });
      return historyByChat[chatId] ?? [];
    },
    async searchContacts(query) {
      searchCalls.push(query);
      if (query in contactsByQuery) {
        return contactsByQuery[query];
      }
      const q = String(query ?? '').toLowerCase();
      return contactsList.filter(
        (c) =>
          c.name?.toLowerCase().includes(q) ||
          c.phone?.includes(q) ||
          c.chatId?.includes(q)
      );
    },
  };
}

function createFakeToolsFactory() {
  const calls = [];
  const factory = (args) => {
    const entry = { args, triggerEndCall: () => args.onEndCallRequested?.() };
    calls.push(entry);
    return {
      execute: async () => ({ ok: true }),
      triggerEndCall: entry.triggerEndCall,
    };
  };
  return { factory, calls };
}

test('missed call records missed state with retry count 0, keeps pending, notifies owner, and never starts Gemini Live', async (t) => {
  const store = await createTempStore(t);
  let now = 1_700_000_000_000;
  const whatsapp = createFakeWhatsApp({
    historyByChat: {
      [CUSTOMER_CHAT_ID]: [
        { id: 'm-0', fromMe: false, body: 'Merhaba', type: 'chat', timestamp: 1700000 },
      ],
    },
  });
  const tools = createFakeToolsFactory();
  let liveStarted = false;
  let callCount = 0;

  const callController = {
    isCallActive: () => false,
    async startCallWithOwner() {
      callCount += 1;
      return 'missed';
    },
  };

  const orchestrator = createOrchestrator({
    config: createBaseConfig(),
    store,
    whatsapp,
    callController,
    createTools: tools.factory,
    startLiveSession: async () => {
      liveStarted = true;
      return { sendOwnerAudio() {}, close() {} };
    },
    nowFn: () => now,
  });

  await orchestrator.handleIncomingMessage({
    id: 'msg-1',
    chatId: CUSTOMER_CHAT_ID,
    from: CUSTOMER_CHAT_ID,
    to: '908501234567@c.us',
    fromMe: false,
    type: 'chat',
    body: 'Fiyat alabilir miyim?',
    senderName: 'Ahmet Yılmaz',
    timestamp: Math.floor(now / 1000),
  });

  assert.equal(callCount, 1);
  assert.equal(liveStarted, false);
  assert.equal(store.getPendingCallChatId(), CUSTOMER_CHAT_ID);

  const chatState1 = store.getChatState(CUSTOMER_CHAT_ID);
  assert.equal(chatState1.lastCallStatus, 'missed');
  assert.equal(chatState1.lastCallAt, now);
  assert.equal(chatState1.missedRetryCount, 0);

  assert.ok(whatsapp.sent.length >= 2);
  assert.ok(
    whatsapp.sent.some((m) => m.chatId === OWNER_CHAT_ID && /cevap yok|açamadınız/i.test(m.text))
  );
  // All outgoing bot messages must be marked to avoid self-echo command loops.
  for (const m of whatsapp.sent) {
    assert.equal(store.consumeBotMessageId(m.id), true);
  }

  // Second attempt after missedRetryMinutes (30m) within cooldown (120m): retry misses -> missedRetryCount = 1.
  now += 31 * 60 * 1000;
  await orchestrator.handleIncomingMessage({
    id: 'msg-2',
    chatId: CUSTOMER_CHAT_ID,
    from: CUSTOMER_CHAT_ID,
    to: '908501234567@c.us',
    fromMe: false,
    type: 'chat',
    body: 'Tekrar yazıyorum',
    senderName: 'Ahmet Yılmaz',
    timestamp: Math.floor(now / 1000),
  });

  assert.equal(callCount, 2);
  const chatState2 = store.getChatState(CUSTOMER_CHAT_ID);
  assert.equal(chatState2.lastCallStatus, 'missed');
  assert.equal(chatState2.missedRetryCount, 1);

  // Third message still within cooldown: policy enforces missed_max_retries -> notify_only, no call.
  now += 31 * 60 * 1000;
  await orchestrator.handleIncomingMessage({
    id: 'msg-3',
    chatId: CUSTOMER_CHAT_ID,
    from: CUSTOMER_CHAT_ID,
    to: '908501234567@c.us',
    fromMe: false,
    type: 'chat',
    body: 'Hala dönüş bekliyorum',
    senderName: 'Ahmet Yılmaz',
    timestamp: Math.floor(now / 1000),
  });

  assert.equal(callCount, 2);
});

test('answered call bridges audio bidirectionally, buffers early audio during connect, handles barge-in and end_call, and clears pending', async (t) => {
  const store = await createTempStore(t);
  const now = 1_700_005_000_000;
  const whatsapp = createFakeWhatsApp({
    historyByChat: {
      [CUSTOMER_CHAT_ID]: [
        { id: 'h-1', fromMe: false, body: 'Randevu var mı?', type: 'chat', timestamp: 1700001 },
        { id: 'h-2', fromMe: true, body: 'Yarın bakabiliriz', type: 'chat', timestamp: 1700002 },
      ],
    },
  });
  const tools = createFakeToolsFactory();

  const sentOwnerAudio = [];
  const pushedAiAudio = [];
  let flushedCount = 0;
  const hangUpReasons = [];
  let liveClosed = 0;
  let capturedLiveArgs = null;

  let resolveLiveConnect;
  const liveConnectGate = new Promise((resolve) => {
    resolveLiveConnect = resolve;
  });

  let resolveCallDone;
  const callDone = new Promise((resolve) => {
    resolveCallDone = resolve;
  });

  let latestSessionCallbacks = null;
  const fakeCallSession = {
    done: callDone,
    waitForEnd: () => callDone,
    getOutcome: () => 'answered',
    pushAudioToOwner: (b64) => pushedAiAudio.push(b64),
    flushAudioToOwner: () => {
      flushedCount += 1;
    },
    hangUp: async (reason) => {
      hangUpReasons.push(reason);
      latestSessionCallbacks?.onEnded?.('answered', { reason });
      resolveCallDone('answered');
    },
  };

  const callController = {
    isCallActive: () => false,
    async startCallWithOwner(callbacks) {
      latestSessionCallbacks = callbacks;
      queueMicrotask(async () => {
        await callbacks.onConnected(fakeCallSession);
      });
      return fakeCallSession;
    },
  };

  const orchestrator = createOrchestrator({
    config: createBaseConfig(),
    store,
    whatsapp,
    callController,
    createTools: tools.factory,
    startLiveSession: async (args) => {
      capturedLiveArgs = args;
      await liveConnectGate;
      return {
        sendOwnerAudio: (b64) => sentOwnerAudio.push(b64),
        close: () => {
          liveClosed += 1;
        },
      };
    },
    nowFn: () => now,
  });

  const handlePromise = orchestrator.handleIncomingMessage({
    id: 'msg-ans-1',
    chatId: CUSTOMER_CHAT_ID,
    from: CUSTOMER_CHAT_ID,
    to: '908501234567@c.us',
    fromMe: false,
    type: 'chat',
    body: 'Saat 15:00 uygun mu?',
    senderName: 'Zeynep Kaya',
    timestamp: Math.floor(now / 1000),
  });

  // Wait until onConnected has invoked startLiveSession (paused at liveConnectGate).
  await new Promise((r) => setTimeout(r, 15));
  assert.ok(capturedLiveArgs, 'startLiveSession should be called upon onConnected');
  assert.equal(capturedLiveArgs.customerContext.chatId, CUSTOMER_CHAT_ID);
  assert.equal(capturedLiveArgs.customerContext.customerName, 'Zeynep Kaya');
  assert.equal(capturedLiveArgs.customerContext.triggerMessage, 'Saat 15:00 uygun mu?');
  assert.equal(capturedLiveArgs.customerContext.recentMessages.length, 2);
  assert.equal(tools.calls.length, 1);
  assert.equal(tools.calls[0].args.activeCustomerChatId, CUSTOMER_CHAT_ID);

  // Audio arriving while Gemini Live websocket handshake completes should be buffered and flushed.
  latestSessionCallbacks.onAudioFromOwner('early-chunk-1');
  latestSessionCallbacks.onAudioFromOwner('early-chunk-2');

  resolveLiveConnect();
  await new Promise((r) => setTimeout(r, 15));

  // Audio arriving after connect goes straight through.
  latestSessionCallbacks.onAudioFromOwner('live-chunk-3');
  assert.deepEqual(sentOwnerAudio, ['early-chunk-1', 'early-chunk-2', 'live-chunk-3']);

  // Gemini AI audio & barge-in -> callSession.
  capturedLiveArgs.onAudioChunk('ai-audio-1');
  assert.deepEqual(pushedAiAudio, ['ai-audio-1']);
  capturedLiveArgs.onInterrupted();
  assert.equal(flushedCount, 1);

  // Trigger end_call tool callback -> hangs up call -> closes Gemini Live -> records answered state.
  await tools.calls[0].triggerEndCall();
  await handlePromise;

  assert.equal(hangUpReasons.length, 1);
  assert.equal(liveClosed, 1);
  assert.equal(store.getPendingCallChatId(), null);

  const chatState = store.getChatState(CUSTOMER_CHAT_ID);
  assert.equal(chatState.lastCallStatus, 'answered');
  assert.equal(chatState.missedRetryCount, 0);
});

test('rejected call records rejected state without starting Gemini Live and notifies owner', async (t) => {
  const store = await createTempStore(t);
  const now = 1_700_010_000_000;
  const whatsapp = createFakeWhatsApp();
  const tools = createFakeToolsFactory();
  let liveStarted = false;

  const callController = {
    isCallActive: () => false,
    async startCallWithOwner() {
      return 'rejected';
    },
  };

  const orchestrator = createOrchestrator({
    config: createBaseConfig(),
    store,
    whatsapp,
    callController,
    createTools: tools.factory,
    startLiveSession: async () => {
      liveStarted = true;
      return { sendOwnerAudio() {}, close() {} };
    },
    nowFn: () => now,
  });

  await orchestrator.handleIncomingMessage({
    id: 'msg-rej-1',
    chatId: CUSTOMER_CHAT_ID,
    from: CUSTOMER_CHAT_ID,
    to: '908501234567@c.us',
    fromMe: false,
    type: 'chat',
    body: 'Teklif bekliyorum',
    senderName: 'Can Demir',
    timestamp: Math.floor(now / 1000),
  });

  assert.equal(liveStarted, false);
  const chatState = store.getChatState(CUSTOMER_CHAT_ID);
  assert.equal(chatState.lastCallStatus, 'rejected');
  assert.equal(chatState.missedRetryCount, 0);
  assert.ok(whatsapp.sent.some((m) => m.chatId === OWNER_CHAT_ID && /reddettiniz/i.test(m.text)));
});

test('notify_only sends quiet owner notification without starting a call', async (t) => {
  const store = await createTempStore(t);
  const now = 1_700_015_000_000;
  store.setSilencedUntil(now + 60_000);

  const whatsapp = createFakeWhatsApp();
  let called = false;

  const orchestrator = createOrchestrator({
    config: createBaseConfig(),
    store,
    whatsapp,
    callController: {
      isCallActive: () => false,
      startCallWithOwner: async () => {
        called = true;
        return 'answered';
      },
    },
    startLiveSession: async () => ({ sendOwnerAudio() {}, close() {} }),
    nowFn: () => now,
  });

  await orchestrator.handleIncomingMessage({
    id: 'msg-sil-1',
    chatId: CUSTOMER_CHAT_ID,
    from: CUSTOMER_CHAT_ID,
    to: '908501234567@c.us',
    fromMe: false,
    type: 'chat',
    body: 'Acil değil ama yazayım dedim',
    senderName: 'Mert Şahin',
    timestamp: Math.floor(now / 1000),
  });

  assert.equal(called, false);
  assert.equal(whatsapp.sent.length, 1);
  assert.equal(whatsapp.sent[0].chatId, OWNER_CHAT_ID);
  assert.equal(store.consumeBotMessageId(whatsapp.sent[0].id), true);
});

test('handles owner commands (durum, sustur, devam, ara) and ignores human fromMe replies cleanly', async (t) => {
  const store = await createTempStore(t);
  let now = 1_700_020_000_000;

  const contactsList = [
    { name: 'Ahmet Yılmaz', phone: '905551112233', chatId: '905551112233@c.us' },
    { name: 'Mehmet Ak', phone: '905552223344', chatId: '905552223344@c.us' },
    { name: 'Mehmet Can', phone: '905553334455', chatId: '905553334455@c.us' },
  ];
  const whatsapp = createFakeWhatsApp({
    contactsList,
    historyByChat: {
      '905551112233@c.us': [{ id: 'a1', fromMe: false, body: 'Selam', type: 'chat', timestamp: 1 }],
    },
  });
  const callControllerCalls = [];
  const callController = {
    isCallActive: () => false,
    async startCallWithOwner() {
      callControllerCalls.push(now);
      return 'answered';
    },
  };

  const orchestrator = createOrchestrator({
    config: createBaseConfig(),
    store,
    whatsapp,
    callController,
    startLiveSession: async () => ({ sendOwnerAudio() {}, close() {} }),
    nowFn: () => now,
  });

  const ownerEvent = (id, body) => ({
    id,
    chatId: OWNER_CHAT_ID,
    from: OWNER_CHAT_ID,
    to: '908501234567@c.us',
    fromMe: false,
    type: 'chat',
    body,
    senderName: 'Patron',
    timestamp: Math.floor(now / 1000),
  });

  // 1. durum
  await orchestrator.handleIncomingMessage(ownerEvent('cmd-1', 'durum'));
  assert.equal(whatsapp.sent.length, 1);
  assert.ok(/Veko Durum:/i.test(whatsapp.sent[0].text));
  // Bot self-echo back on WhatsApp must be ignored cleanly.
  await orchestrator.handleIncomingMessage({
    id: whatsapp.sent[0].id,
    chatId: OWNER_CHAT_ID,
    from: '908501234567@c.us',
    to: OWNER_CHAT_ID,
    fromMe: true,
    type: 'chat',
    body: whatsapp.sent[0].text,
    timestamp: Math.floor(now / 1000),
  });
  assert.equal(whatsapp.sent.length, 1);

  // 2. sustur 30 & devam
  await orchestrator.handleIncomingMessage(ownerEvent('cmd-2', 'sustur 30'));
  assert.equal(store.isSilenced(now + 1000), true);
  await orchestrator.handleIncomingMessage(ownerEvent('cmd-3', 'devam'));
  assert.equal(store.isSilenced(now + 1000), false);

  // 3. ara without pending chat
  await orchestrator.handleIncomingMessage(ownerEvent('cmd-4', 'ara'));
  assert.equal(callControllerCalls.length, 0);
  assert.ok(/bekleyen/i.test(whatsapp.sent.at(-1).text));

  // 4. ara with pending chat -> calls owner
  store.setPendingCallChatId('905551112233@c.us');
  await orchestrator.handleIncomingMessage(ownerEvent('cmd-5', 'ara'));
  assert.equal(callControllerCalls.length, 1);
  assert.equal(store.getPendingCallChatId(), null);

  // 5. ara Mehmet (multiple matches) -> disambiguates without calling
  await orchestrator.handleIncomingMessage(ownerEvent('cmd-6', 'ara Mehmet'));
  assert.equal(callControllerCalls.length, 1);
  assert.ok(/Mehmet Ak/i.test(whatsapp.sent.at(-1).text));
  assert.ok(/Mehmet Can/i.test(whatsapp.sent.at(-1).text));

  // 6. ara Yokkimse (0 matches) -> informs owner
  await orchestrator.handleIncomingMessage(ownerEvent('cmd-7', 'ara Yokkimse'));
  assert.equal(callControllerCalls.length, 1);
  assert.ok(/bulunamadı/i.test(whatsapp.sent.at(-1).text));

  // 7. ara Ahmet (single match) -> calls owner
  await orchestrator.handleIncomingMessage(ownerEvent('cmd-8', 'ara Ahmet'));
  assert.equal(callControllerCalls.length, 2);

  // 8. Human fromMe reply updates lastOwnerReplyAt and clears matching pendingChatId silently
  store.setPendingCallChatId('905551112233@c.us');
  const sentBeforeReply = whatsapp.sent.length;
  await orchestrator.handleIncomingMessage({
    id: 'human-reply-1',
    chatId: '905551112233@c.us',
    from: '908501234567@c.us',
    to: '905551112233@c.us',
    fromMe: true,
    type: 'chat',
    body: 'Ben ilgileniyorum Ahmet Bey',
    timestamp: Math.floor(now / 1000),
  });
  assert.equal(whatsapp.sent.length, sentBeforeReply);
  assert.equal(store.getPendingCallChatId(), null);
  assert.equal(store.getChatState('905551112233@c.us').lastOwnerReplyAt, now);
});

test('error outcome does not set cooldown, early hangup closes delayed Gemini Live, live onClose hangs up call, and callRunning prevents concurrent double-dial', async (t) => {
  const store = await createTempStore(t);
  const now = 1_700_025_000_000;
  const whatsapp = createFakeWhatsApp({
    historyByChat: {
      [CUSTOMER_CHAT_ID]: [{ id: 'c1', fromMe: false, body: 'Test', type: 'chat', timestamp: 1 }],
    },
  });

  // Scenario A: error outcome should notify owner with warning and leave chat free of cooldown.
  const orchError = createOrchestrator({
    config: createBaseConfig(),
    store,
    whatsapp,
    callController: {
      isCallActive: () => false,
      startCallWithOwner: async () => 'error',
    },
    startLiveSession: async () => ({ sendOwnerAudio() {}, close() {} }),
    nowFn: () => now,
  });

  await orchError.handleIncomingMessage({
    id: 'err-1',
    chatId: CUSTOMER_CHAT_ID,
    from: CUSTOMER_CHAT_ID,
    to: '908501234567@c.us',
    fromMe: false,
    type: 'chat',
    body: 'Arama hata testi',
    senderName: 'Hata Müşterisi',
    timestamp: Math.floor(now / 1000),
  });

  const errState = store.getChatState(CUSTOMER_CHAT_ID);
  assert.notEqual(errState?.lastCallStatus, 'answered');
  assert.notEqual(errState?.lastCallStatus, 'rejected');
  assert.equal(errState?.lastCallAt, undefined);
  assert.ok(whatsapp.sent.some((m) => m.chatId === OWNER_CHAT_ID && /hata|başlatılamadı/i.test(m.text)));

  // Scenario B: call ends while startLiveSession handshake is still awaiting -> closes live once resolved.
  let releaseDelayedLive;
  const delayedLiveGate = new Promise((r) => {
    releaseDelayedLive = r;
  });
  let delayedLiveClosed = 0;

  let resolveEarlyDone;
  const earlyDone = new Promise((r) => {
    resolveEarlyDone = r;
  });
  const earlySession = {
    done: earlyDone,
    pushAudioToOwner() {},
    flushAudioToOwner() {},
    hangUp: async () => {},
  };

  const orchRace = createOrchestrator({
    config: createBaseConfig(),
    store,
    whatsapp,
    callController: {
      isCallActive: () => false,
      async startCallWithOwner(callbacks) {
        queueMicrotask(() => callbacks.onConnected(earlySession));
        return earlySession;
      },
    },
    startLiveSession: async () => {
      await delayedLiveGate;
      return {
        sendOwnerAudio() {},
        close: () => {
          delayedLiveClosed += 1;
        },
      };
    },
    nowFn: () => now,
  });

  const racePromise = orchRace.handleIncomingMessage({
    id: 'race-1',
    chatId: '905559990001@c.us',
    from: '905559990001@c.us',
    to: '908501234567@c.us',
    fromMe: false,
    type: 'chat',
    body: 'Erken kapama testi',
    senderName: 'Erken Kapama',
    timestamp: Math.floor(now / 1000),
  });

  await new Promise((r) => setTimeout(r, 15));
  resolveEarlyDone('answered');
  await racePromise;
  releaseDelayedLive();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(delayedLiveClosed, 1);

  // Scenario C: Gemini Live onClose triggers callSession.hangUp, AND second concurrent message is serialized as notify_only.
  let liveCallbacks;
  let callHangUps = 0;
  let resolveSlowCall;
  const slowCallDone = new Promise((r) => {
    resolveSlowCall = r;
  });
  let startCallAttempts = 0;

  const slowSession = {
    done: slowCallDone,
    pushAudioToOwner() {},
    flushAudioToOwner() {},
    hangUp: async (reason) => {
      callHangUps += 1;
      resolveSlowCall('answered');
      return reason;
    },
  };

  const orchConcurrent = createOrchestrator({
    config: createBaseConfig(),
    store,
    whatsapp,
    callController: {
      isCallActive: () => false,
      async startCallWithOwner(callbacks) {
        startCallAttempts += 1;
        queueMicrotask(() => callbacks.onConnected(slowSession));
        return slowSession;
      },
    },
    startLiveSession: async (args) => {
      liveCallbacks = args;
      return { sendOwnerAudio() {}, close() {} };
    },
    nowFn: () => now,
  });

  const firstCallPromise = orchConcurrent.handleIncomingMessage({
    id: 'conc-1',
    chatId: '905559990002@c.us',
    from: '905559990002@c.us',
    to: '908501234567@c.us',
    fromMe: false,
    type: 'chat',
    body: 'Birinci arama',
    senderName: 'Müşteri 1',
    timestamp: Math.floor(now / 1000),
  });

  await new Promise((r) => setTimeout(r, 15));

  // Second message arrives while first call is active -> notify_only, no second call.
  await orchConcurrent.handleIncomingMessage({
    id: 'conc-2',
    chatId: '905559990003@c.us',
    from: '905559990003@c.us',
    to: '908501234567@c.us',
    fromMe: false,
    type: 'chat',
    body: 'İkinci mesaj aynı anda',
    senderName: 'Müşteri 2',
    timestamp: Math.floor(now / 1000),
  });

  assert.equal(startCallAttempts, 1);

  // Closing Gemini Live hangs up the active call cleanly.
  liveCallbacks.onClose();
  await firstCallPromise;
  assert.equal(callHangUps, 1);
});

test('handleIncomingCall answers 1:1 owner call without pending customer, buffers preconnect audio, and ignores non-owner/video/@lid/concurrent calls', async (t) => {
  const store = await createTempStore(t);
  let now = 1_700_000_000_000;
  const whatsapp = createFakeWhatsApp();
  const tools = createFakeToolsFactory();

  let answerCalls = 0;
  let capturedLiveArgs = null;
  const forwardedAudioToGemini = [];
  const pushedAudioToOwner = [];
  let resolveAnswer;
  let callbacksRef;

  const incomingSession = {
    done: new Promise((r) => {
      resolveAnswer = r;
    }),
    pushAudioToOwner: async (b64) => {
      pushedAudioToOwner.push(b64);
    },
    flushAudioToOwner: async () => {},
    hangUp: async () => {
      resolveAnswer('answered');
    },
  };

  const orch = createOrchestrator({
    config: createBaseConfig(),
    store,
    whatsapp,
    callController: {
      isCallActive: () => false,
      async startCallWithOwner() {
        throw new Error('Must not dial outgoing for incoming owner call');
      },
      async answerIncomingCall(callbacks) {
        answerCalls += 1;
        callbacksRef = callbacks;
        queueMicrotask(() => callbacks.onConnected(incomingSession));
        return incomingSession;
      },
    },
    startLiveSession: async (args) => {
      capturedLiveArgs = args;
      // Delay Live setup slightly to exercise pre-connect audio buffering
      await new Promise((r) => setTimeout(r, 20));
      return {
        sendOwnerAudio: (b64) => forwardedAudioToGemini.push(b64),
        close() {},
      };
    },
    createTools: tools.factory,
    nowFn: () => now,
  });

  // 1) Ignore non-owner, video, unresolved @lid
  const strangerDecision = await orch.handleIncomingCall({
    id: 'stranger-1',
    from: CUSTOMER_CHAT_ID,
    phone: '905551112233',
    outgoing: false,
    isGroup: false,
    isVideo: false,
  });
  assert.equal(strangerDecision.action, 'ignore');
  assert.equal(strangerDecision.reason, 'not_owner');

  const videoDecision = await orch.handleIncomingCall({
    id: 'video-1',
    from: OWNER_CHAT_ID,
    phone: '905550000100',
    outgoing: false,
    isGroup: false,
    isVideo: true,
  });
  assert.equal(videoDecision.reason, 'video_call');

  const lidDecision = await orch.handleIncomingCall({
    id: 'lid-1',
    from: '777888999@lid',
    phone: '',
    outgoing: false,
    isGroup: false,
    isVideo: false,
  });
  assert.equal(lidDecision.reason, 'unresolved_lid');
  assert.equal(answerCalls, 0);

  // 2) Answer valid owner incoming audio call
  const answerPromise = orch.handleIncomingCall({
    id: 'owner-in-1',
    from: OWNER_CHAT_ID,
    phone: '905550000100',
    senderName: 'İşletme Sahibi',
    outgoing: false,
    isGroup: false,
    isVideo: false,
  });

  // Feed early audio chunk while Live session is connecting, plus concurrent call rejection
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 5));
  callbacksRef.onAudioFromOwner('early-pcm-1');

  const concurrentDecision = await orch.handleIncomingCall({
    id: 'owner-in-2',
    from: OWNER_CHAT_ID,
    phone: '905550000100',
    outgoing: false,
    isGroup: false,
    isVideo: false,
  });
  assert.equal(concurrentDecision.reason, 'call_in_progress');
  assert.equal(answerCalls, 1);

  await new Promise((r) => setTimeout(r, 30));
  assert.equal(capturedLiveArgs.customerContext.callMode, 'owner_initiated');
  assert.equal(capturedLiveArgs.customerContext.hasPendingCustomer, false);
  assert.deepEqual(forwardedAudioToGemini, ['early-pcm-1']);

  capturedLiveArgs.onAudioChunk('gemini-audio-1');
  assert.deepEqual(pushedAudioToOwner, ['gemini-audio-1']);

  resolveAnswer('answered');
  callbacksRef.onEnded('answered', { reason: 'remote_dom_closed' });
  const result = await answerPromise;
  assert.equal(result.outcome, 'answered');
  assert.equal(whatsapp.sent.length, 0);
});

test('handleIncomingCall with pending customer loads context lazily and clears pending on answered', async (t) => {
  const store = await createTempStore(t);
  store.setPendingCallChatId(CUSTOMER_CHAT_ID);

  const whatsapp = createFakeWhatsApp({
    historyByChat: {
      [CUSTOMER_CHAT_ID]: [
        { id: 'c1', fromMe: false, body: 'Fiyat alabilir miyim?', type: 'chat', timestamp: 1700001 },
      ],
    },
  });
  whatsapp.getChatById = async () => ({ name: 'Ayşe Yılmaz' });

  let capturedContext = null;
  let resolveDone;
  const session = {
    done: new Promise((r) => {
      resolveDone = r;
    }),
    pushAudioToOwner() {},
    flushAudioToOwner() {},
    hangUp: async () => resolveDone('answered'),
  };

  const orch = createOrchestrator({
    config: createBaseConfig(),
    store,
    whatsapp,
    callController: {
      isCallActive: () => false,
      async answerIncomingCall(callbacks) {
        queueMicrotask(() => callbacks.onConnected(session));
        return session;
      },
    },
    startLiveSession: async (args) => {
      capturedContext = args.customerContext;
      queueMicrotask(() => resolveDone('answered'));
      return { sendOwnerAudio() {}, close() {} };
    },
    nowFn: () => 1_700_000_050_000,
  });

  const res = await orch.handleIncomingCall({
    id: 'owner-in-pending',
    from: OWNER_CHAT_ID,
    phone: '905550000100',
    outgoing: false,
    isGroup: false,
    isVideo: false,
  });

  assert.equal(res.outcome, 'answered');
  assert.equal(capturedContext.callMode, 'owner_initiated');
  assert.equal(capturedContext.hasPendingCustomer, true);
  assert.equal(capturedContext.customerName, 'Ayşe Yılmaz');
  assert.equal(capturedContext.chatId, CUSTOMER_CHAT_ID);
  assert.equal(store.getPendingCallChatId(), null);
  assert.equal(store.getChatState(CUSTOMER_CHAT_ID).lastCallStatus, 'answered');
});

test('owner_chat serializes concurrent turns, chunks long replies (~3500 chars), marks bot IDs, and bridges [Sistem Bildirimi] notices', async (t) => {
  const store = await createTempStore(t);
  const whatsapp = createFakeWhatsApp();
  const executionOrder = [];
  let releaseFirst;
  const firstGate = new Promise((r) => {
    releaseFirst = r;
  });

  const orch = createOrchestrator({
    config: {
      ...createBaseConfig(),
      aiVoice: { provider: 'gemini', apiKey: 'g', model: 'gemini-3.8-live', voiceName: 'Aoede' },
      aiText: { provider: 'gemini', protocol: 'gemini', apiKey: 'g', model: 'gemini-3.8-flash' },
    },
    store,
    whatsapp,
    callController: {
      isCallActive: () => false,
      async startCall() {
        return { done: Promise.resolve('rejected'), hangUp: async () => {} };
      },
    },
    startLiveSession: async () => ({ sendOwnerAudio() {}, close() {} }),
    runTextTurn: async ({ ownerMessage, turnId }) => {
      executionOrder.push(`start:${ownerMessage}`);
      if (ownerMessage === 'Birinci soru') {
        await firstGate;
      }
      executionOrder.push(`end:${ownerMessage}`);
      assert.ok(turnId);
      if (ownerMessage === 'Uzun rapor ver') {
        return { ok: true, text: `${'A'.repeat(3490)}\n${'B'.repeat(400)}` };
      }
      return { ok: true, text: `Yanıt: ${ownerMessage}` };
    },
    nowFn: () => 1_700_000_200_000,
  });

  // Customer notify_only event (e.g. silenced) should bridge [Sistem Bildirimi] into ownerChatHistory
  store.setSilencedUntil(1_700_001_000_000);
  await orch.handleIncomingMessage({
    id: 'cust-notice-1',
    from: CUSTOMER_CHAT_ID,
    phone: '905551112233',
    senderName: 'Müşteri Ali',
    fromMe: false,
    type: 'chat',
    body: 'Stok var mı?',
    timestamp: 1_700_000_200,
  });

  const histAfterNotice = store.getOwnerChatHistory();
  assert.equal(histAfterNotice.length, 1);
  assert.match(histAfterNotice[0].content, /^\[Sistem Bildirimi\]/);
  assert.match(histAfterNotice[0].content, /Stok var mı\?/);

  // Send 2 concurrent owner text messages: turn 2 MUST wait for turn 1 to finish
  const p1 = orch.handleIncomingMessage({
    id: 'own-msg-1',
    from: OWNER_CHAT_ID,
    phone: '905550000100',
    fromMe: false,
    type: 'chat',
    body: 'Birinci soru',
    timestamp: 1_700_000_201,
  });
  await new Promise((r) => setTimeout(r, 15));

  const p2 = orch.handleIncomingMessage({
    id: 'own-msg-2',
    from: OWNER_CHAT_ID,
    phone: '905550000100',
    fromMe: false,
    type: 'chat',
    body: 'Uzun rapor ver',
    timestamp: 1_700_000_202,
  });
  await new Promise((r) => setTimeout(r, 15));

  // First turn has started, second turn must NOT have started yet!
  assert.deepEqual(executionOrder, ['start:Birinci soru']);
  releaseFirst();

  await Promise.all([p1, p2]);
  assert.deepEqual(executionOrder, [
    'start:Birinci soru',
    'end:Birinci soru',
    'start:Uzun rapor ver',
    'end:Uzun rapor ver',
  ]);

  // Replies: index 0 = customer notice, index 1 = "Yanıt: Birinci soru", index 2+3 = chunked long reply
  const ownerReplies = whatsapp.sent.slice(1);
  assert.equal(ownerReplies.length, 3);
  assert.equal(ownerReplies[0].text, 'Yanıt: Birinci soru');
  assert.ok(ownerReplies[1].text.length <= 3500);
  assert.ok(ownerReplies[2].text.length <= 3500);
  assert.equal(store.consumeBotMessageId(ownerReplies[1].id), true);
  assert.equal(store.consumeBotMessageId(ownerReplies[2].id), true);
});

test('aiVoiceProvider=none suppresses calls on customer messages and ara command, and aiTextProvider=none skips owner_chat', async (t) => {
  const store = await createTempStore(t);
  const whatsapp = createFakeWhatsApp();
  let startCallCount = 0;
  let textTurnCount = 0;

  const orch = createOrchestrator({
    config: {
      ...createBaseConfig(),
      aiVoice: { provider: 'none', apiKey: '', model: '', voiceName: '' },
      aiText: { provider: 'none', protocol: 'none', apiKey: '', model: '' },
    },
    store,
    whatsapp,
    callController: {
      isCallActive: () => false,
      async startCall() {
        startCallCount += 1;
        return { done: Promise.resolve('answered'), hangUp: async () => {} };
      },
    },
    runTextTurn: async () => {
      textTurnCount += 1;
      return { ok: true, text: 'hi' };
    },
    nowFn: () => 1_700_000_300_000,
  });

  // 1. Customer message when voice disabled -> notify_only, no call, notice in history
  const custRes = await orch.handleIncomingMessage({
    id: 'nv-msg-1',
    from: CUSTOMER_CHAT_ID,
    phone: '905551112233',
    senderName: 'Ayşe',
    fromMe: false,
    type: 'chat',
    body: 'Merhaba',
    timestamp: 1_700_000_300,
  });
  assert.equal(custRes.action, 'notify_only');
  assert.equal(custRes.reason, 'voice_disabled');
  assert.equal(startCallCount, 0);
  assert.equal(whatsapp.sent.length, 1);
  assert.match(whatsapp.sent[0].text, /Sesli arama kapalı|AI_VOICE_PROVIDER=none/i);

  // 2. Owner `ara` command when voice disabled -> informative reply, no call
  await orch.handleIncomingMessage({
    id: 'nv-cmd-1',
    from: OWNER_CHAT_ID,
    phone: '905550000100',
    fromMe: false,
    type: 'chat',
    body: 'ara',
    timestamp: 1_700_000_301,
  });
  assert.equal(startCallCount, 0);
  assert.equal(whatsapp.sent.length, 2);
  assert.match(whatsapp.sent[1].text, /Sesli.*kapalı|AI_VOICE_PROVIDER=none/i);

  // 3. Free-form owner chat when aiText=none -> silently ignored
  const textRes = await orch.handleIncomingMessage({
    id: 'nt-msg-1',
    from: OWNER_CHAT_ID,
    phone: '905550000100',
    fromMe: false,
    type: 'chat',
    body: 'Bugün kaç müşteri?',
    timestamp: 1_700_000_302,
  });
  assert.equal(textRes.reason, 'text_disabled');
  assert.equal(textTurnCount, 0);
});

test('orchestrator handles first-install notice, 15m restart anti-spam, and update checks on restart', async (t) => {
  const store = await createTempStore(t);
  let now = 1_700_000_000_000;
  let remoteVer = '0.2.0';
  let fetchCount = 0;

  const fetchImpl = async () => {
    fetchCount += 1;
    return {
      ok: true,
      status: 200,
      async json() {
        return { version: remoteVer };
      },
    };
  };

  const makeOrch = (wa) =>
    createOrchestrator({
      config: {
        ...createBaseConfig(),
        appVersion: '0.2.0',
        githubRepoUrl: 'https://github.com/holy2k/veko',
        updateCheckUrl: 'https://raw.githubusercontent.com/holy2k/veko/main/package.json',
      },
      store,
      whatsapp: wa,
      callController: { isCallActive: () => false },
      fetchImpl,
      nowFn: () => now,
    });

  // 1. First install sends welcome notice once & duplicate ready in same process is ignored
  const wa1 = createFakeWhatsApp();
  const orch1 = makeOrch(wa1);
  const res1 = await orch1.handleStartupReady();
  assert.equal(res1.mode, 'install');
  assert.equal(res1.notified, true);
  assert.equal(wa1.sent.length, 1);
  assert.match(wa1.sent[0].text, /Veko kuruldu!.*https:\/\/github\.com\/holy2k\/veko.*Güncelleme bildirimi kapat/);
  assert.equal(fetchCount, 0);
  assert.equal(store.getUpdateState().installNotifiedAt, now);
  assert.equal(store.getUpdateState().lastStartupNoticeAt, now);

  const dupSameProcess = await orch1.handleStartupReady();
  assert.equal(dupSameProcess.skipped, true);
  assert.equal(dupSameProcess.reason, 'already_handled_in_process');
  assert.equal(wa1.sent.length, 1);

  // 2. Restart within 15 min -> suppressed (anti-spam)
  now += 10 * 60_000;
  const wa2 = createFakeWhatsApp();
  const resCooldown = await makeOrch(wa2).handleStartupReady();
  assert.equal(resCooldown.skipped, true);
  assert.equal(resCooldown.reason, 'startup_cooldown');
  assert.equal(wa2.sent.length, 0);
  assert.equal(fetchCount, 0);

  // 3. Restart after >= 15 min with NO update -> check runs & sends "güncelleme yok"
  now += 6 * 60_000;
  const wa3 = createFakeWhatsApp();
  const resNoUpd = await makeOrch(wa3).handleStartupReady();
  assert.equal(resNoUpd.mode, 'restart');
  assert.equal(resNoUpd.hasUpdate, false);
  assert.equal(fetchCount, 1);
  assert.equal(wa3.sent.length, 1);
  assert.match(wa3.sent[0].text, /yeniden başlatıldı, güncelleme yok \(v0\.2\.0\)/);

  // 4. Restart after >= 15 min WITH update -> sends new version & saves lastNotifiedVersion
  now += 16 * 60_000;
  remoteVer = '0.3.0';
  const wa4 = createFakeWhatsApp();
  const resWithUpd = await makeOrch(wa4).handleStartupReady();
  assert.equal(resWithUpd.mode, 'restart');
  assert.equal(resWithUpd.hasUpdate, true);
  assert.equal(fetchCount, 2);
  assert.equal(wa4.sent.length, 1);
  assert.match(wa4.sent[0].text, /Yeni sürüm mevcut: v0\.3\.0.*holy2k\/veko/);
  assert.equal(store.getUpdateState().lastNotifiedVersion, '0.3.0');

  // 5. Restart when notifications disabled -> skips fetch, sends plain restart notice
  store.setUpdateState({ updateNotificationsEnabled: false });
  now += 16 * 60_000;
  const wa5 = createFakeWhatsApp();
  const resDisabled = await makeOrch(wa5).handleStartupReady();
  assert.equal(resDisabled.notificationsEnabled, false);
  assert.equal(fetchCount, 2); // No GitHub request made!
  assert.equal(wa5.sent.length, 1);
  assert.equal(wa5.sent[0].text, '✅ Veko başarıyla yeniden başlatıldı.');
});

test('orchestrator notifies pending update only after answered call or owner_chat (never during night / missed / rejected)', async (t) => {
  const store = await createTempStore(t);
  let now = 1_700_100_000_000;
  store.setUpdateState({
    installNotifiedAt: now - 86_400_000,
    lastStartupNoticeAt: now - 86_400_000,
    updateNotificationsEnabled: true,
  });

  let remoteVer = '0.3.0';
  let fetchCalls = 0;
  let nextOutcome = 'missed';
  const whatsapp = createFakeWhatsApp();

  const orch = createOrchestrator({
    config: {
      ...createBaseConfig(),
      appVersion: '0.2.0',
      githubRepoUrl: 'https://github.com/holy2k/veko',
      updateCheckUrl: 'https://raw.githubusercontent.com/holy2k/veko/main/package.json',
    },
    store,
    whatsapp,
    fetchImpl: async () => {
      fetchCalls += 1;
      return { ok: true, status: 200, async json() { return { version: remoteVer }; } };
    },
    callController: {
      isCallActive: () => false,
      startCallWithOwner: async (callbacks) => {
        const outcome = nextOutcome;
        const session = {
          done: Promise.resolve(outcome),
          pushAudioToOwner() {},
          flushAudioToOwner() {},
          hangUp: async () => outcome,
        };
        if (outcome === 'answered') {
          await callbacks.onConnected?.(session);
        }
        callbacks.onEnded?.(outcome, { reason: 'normal' });
        return session;
      },
      answerIncomingCall: async (callbacks) => {
        const outcome = nextOutcome;
        const session = {
          done: Promise.resolve(outcome),
          pushAudioToOwner() {},
          flushAudioToOwner() {},
          hangUp: async () => outcome,
        };
        if (outcome === 'answered') {
          await callbacks.onConnected?.(session);
        }
        callbacks.onEnded?.(outcome, { reason: 'normal' });
        return session;
      },
    },
    startLiveSession: async () => ({ sendOwnerAudio() {}, close() {} }),
    runTextTurn: async ({ ownerMessage }) => ({ ok: true, text: `Yanıt: ${ownerMessage}` }),
    nowFn: () => now,
  });

  // 1. Background 24h silent check caches v0.3.0 WITHOUT sending WhatsApp message at night!
  const bgRes = await orch.checkForUpdateInBackground();
  assert.equal(bgRes.hasUpdate, true);
  assert.equal(fetchCalls, 1);
  assert.equal(whatsapp.sent.length, 0);
  assert.equal(store.getUpdateState().lastNotifiedVersion, null);

  // 2. Missed call -> does NOT send update notice
  nextOutcome = 'missed';
  await orch.handleIncomingMessage({
    id: 'upd-c-1',
    from: CUSTOMER_CHAT_ID,
    phone: '905551112233',
    senderName: 'Müşteri 1',
    fromMe: false,
    type: 'chat',
    body: 'Bilgi lütfen',
    timestamp: 1_700_100,
  });
  const countAfterMissed = whatsapp.sent.length;
  assert.equal(whatsapp.sent.some((m) => /Yeni Veko güncellemesi/i.test(m.text)), false);
  assert.equal(store.getUpdateState().lastNotifiedVersion, null);

  // 3. Answered customer call -> sends update notice ONCE right after call & marks lastNotifiedVersion
  nextOutcome = 'answered';
  await orch.handleIncomingMessage({
    id: 'upd-c-2',
    from: '905551119988@c.us',
    phone: '905551119988',
    senderName: 'Müşteri 2',
    fromMe: false,
    type: 'chat',
    body: 'Fiyat?',
    timestamp: 1_700_101,
  });
  const afterAnswered = whatsapp.sent.slice(countAfterMissed);
  assert.equal(afterAnswered.some((m) => /v0\.3\.0[\s\S]*holy2k\/veko/.test(m.text)), true);
  assert.equal(store.getUpdateState().lastNotifiedVersion, '0.3.0');

  // 4. Subsequent owner_chat for SAME version v0.3.0 -> does NOT duplicate notification
  const beforeChat1 = whatsapp.sent.length;
  await orch.handleIncomingMessage({
    id: 'upd-o-1',
    from: OWNER_CHAT_ID,
    phone: '905550000100',
    fromMe: false,
    type: 'chat',
    body: 'Bugün ne oldu?',
    timestamp: 1_700_102,
  });
  assert.equal(whatsapp.sent.slice(beforeChat1).length, 1);
  assert.equal(whatsapp.sent[beforeChat1].text, 'Yanıt: Bugün ne oldu?');

  // 5. Next version v0.3.1 arrives after 24h -> owner_chat delivers AI reply + single update notice
  now += 25 * 3600_000;
  remoteVer = '0.3.1';
  const beforeChat2 = whatsapp.sent.length;
  await orch.handleIncomingMessage({
    id: 'upd-o-2',
    from: OWNER_CHAT_ID,
    phone: '905550000100',
    fromMe: false,
    type: 'chat',
    body: 'Haftalık durum nedir?',
    timestamp: 1_700_103,
  });
  const sentOnChat2 = whatsapp.sent.slice(beforeChat2);
  assert.equal(sentOnChat2.length, 2);
  assert.equal(sentOnChat2[0].text, 'Yanıt: Haftalık durum nedir?');
  assert.match(sentOnChat2[1].text, /Yeni Veko güncellemesi mevcut: v0\.3\.1/);
  assert.equal(store.getUpdateState().lastNotifiedVersion, '0.3.1');

  // 6. When v0.3.2 arrives silently, answered incoming owner call (even with NO pending customer) also delivers once
  now += 25 * 3600_000;
  remoteVer = '0.3.2';
  const beforeIncoming = whatsapp.sent.length;
  await orch.handleIncomingCall({
    id: 'upd-call-in-1',
    from: OWNER_CHAT_ID,
    phone: '905550000100',
    outgoing: false,
    isGroup: false,
    isVideo: false,
    fromMe: false,
  });
  const sentAfterIncoming = whatsapp.sent.slice(beforeIncoming);
  assert.equal(sentAfterIncoming.some((m) => /v0\.3\.2/.test(m.text)), true);
  assert.equal(store.getUpdateState().lastNotifiedVersion, '0.3.2');
});

test('orchestrator durum includes version/update status and supports AI_TEXT_PROVIDER=none fallback toggle', async (t) => {
  const store = await createTempStore(t);
  const whatsapp = createFakeWhatsApp();
  const orch = createOrchestrator({
    config: {
      ...createBaseConfig(),
      appVersion: '0.2.0',
      aiTextProvider: 'none',
    },
    store,
    whatsapp,
    callController: { isCallActive: () => false },
    nowFn: () => 1_700_200_000_000,
  });

  // Close update notifications via text fallback (case & Turkish char tolerant)
  await orch.handleIncomingMessage({
    id: 'tog-1',
    from: OWNER_CHAT_ID,
    phone: '905550000100',
    fromMe: false,
    type: 'chat',
    body: 'GUNCELLEME BILDIRIMI KAPAT',
    timestamp: 1_700_200,
  });
  assert.equal(store.getUpdateState().updateNotificationsEnabled, false);
  assert.match(whatsapp.sent[0].text, /kapatıldı/i);

  // durum shows version & update notification status
  await orch.handleIncomingMessage({
    id: 'durum-1',
    from: OWNER_CHAT_ID,
    phone: '905550000100',
    fromMe: false,
    type: 'chat',
    body: 'durum',
    timestamp: 1_700_201,
  });
  assert.match(whatsapp.sent[1].text, /Sürüm: v0\.2\.0/);
  assert.match(whatsapp.sent[1].text, /Güncelleme Bildirimi: Kapalı/);

  // Re-open via fallback
  await orch.handleIncomingMessage({
    id: 'tog-2',
    from: OWNER_CHAT_ID,
    phone: '905550000100',
    fromMe: false,
    type: 'chat',
    body: 'Güncelleme bildirimi aç',
    timestamp: 1_700_202,
  });
  assert.equal(store.getUpdateState().updateNotificationsEnabled, true);
  assert.match(whatsapp.sent[2].text, /açıldı/i);

  // Unrelated message when AI text is none remains ignored
  const ignored = await orch.handleIncomingMessage({
    id: 'tog-3',
    from: OWNER_CHAT_ID,
    phone: '905550000100',
    fromMe: false,
    type: 'chat',
    body: 'Bugün hava nasıl?',
    timestamp: 1_700_203,
  });
  assert.equal(ignored.reason, 'text_disabled');
});

test('smart mode ignores trivial noise, debounces normal messages 10m with sliding reset, cancels on owner reply, and breaks on urgent/ptt', async (t) => {
  const store = await createTempStore(t);
  const whatsapp = createFakeWhatsApp();
  let nowMs = Date.parse('2026-11-13T10:00:00+03:00');
  const startedCalls = [];
  const scheduledTimers = [];
  const clearedTimers = [];

  const orch = createOrchestrator({
    config: {
      ...createBaseConfig(),
      callPolicy: 'smart',
      callDelayMinutes: 10,
      quietHoursEnabled: false,
      aiTextProvider: 'none',
    },
    store,
    whatsapp,
    callController: {
      isCallActive: () => false,
      startCallWithOwner: async (args) => {
        startedCalls.push(args);
        return 'answered';
      },
    },
    triageMessage: async ({ event }) => {
      const body = String(event?.body || '');
      if (/teşekkür|tamam|👍|doğrulama/i.test(body)) {
        return { priority: 'ignore', reason: 'trivial', summary: 'Önemsiz', source: 'rule' };
      }
      if (/acil|çöktü/i.test(body)) {
        return { priority: 'urgent', reason: 'urgent_keyword', summary: body, source: 'rule' };
      }
      return { priority: 'normal', reason: 'customer_inquiry', summary: body, source: 'rule' };
    },
    nowFn: () => nowMs,
    setTimeoutFn: (fn, delay) => {
      const handle = { id: scheduledTimers.length + 1, delay, fn };
      scheduledTimers.push(handle);
      return handle;
    },
    clearTimeoutFn: (handle) => {
      if (handle) clearedTimers.push(handle.id);
    },
  });

  // 1. Trivial noise ("Teşekkürler") is ignored silently (no owner buzz, no call, no delayed timer)
  const trivialRes = await orch.handleIncomingMessage({
    id: 'sm-1',
    from: CUSTOMER_CHAT_ID,
    phone: '905550000200',
    fromMe: false,
    type: 'chat',
    body: 'Teşekkürler',
    timestamp: Math.floor(nowMs / 1000),
  });
  assert.equal(trivialRes.action, 'notify_only');
  assert.equal(trivialRes.reason, 'trivial_ignored');
  assert.equal(startedCalls.length, 0);
  assert.equal(whatsapp.sent.length, 0);
  assert.equal(Object.keys(store.getPendingDelayedCalls()).length, 0);

  // 2. Normal message buffers a 10-minute delayed call and notifies owner lightly
  const norm1 = await orch.handleIncomingMessage({
    id: 'sm-2',
    from: CUSTOMER_CHAT_ID,
    phone: '905550000200',
    fromMe: false,
    type: 'chat',
    body: 'Merhaba fiyat alabilir miyim?',
    timestamp: Math.floor(nowMs / 1000),
  });
  assert.equal(norm1.reason, 'smart_delayed');
  assert.equal(startedCalls.length, 0);
  assert.equal(scheduledTimers[0].delay, 10 * 60_000);
  assert.equal(store.getPendingDelayedCall(CUSTOMER_CHAT_ID).dueAtMs, nowMs + 10 * 60_000);
  assert.match(whatsapp.sent[0].text, /10 dk/i);

  // 3. Second normal message at +6 min slides the timer forward to +16 min without calling yet
  nowMs += 6 * 60_000;
  await orch.handleIncomingMessage({
    id: 'sm-3',
    from: CUSTOMER_CHAT_ID,
    phone: '905550000200',
    fromMe: false,
    type: 'chat',
    body: 'Bir de teslimat süresini soracaktım',
    timestamp: Math.floor(nowMs / 1000),
  });
  assert.equal(store.getPendingDelayedCall(CUSTOMER_CHAT_ID).dueAtMs, nowMs + 10 * 60_000);
  assert.equal(store.getPendingDelayedCall(CUSTOMER_CHAT_ID).messages.length, 2);

  // Still not due at +9 min after 2nd message
  nowMs += 9 * 60_000;
  await orch.processScheduledEvents(nowMs);
  assert.equal(startedCalls.length, 0);

  // Due at +10 min after 2nd message -> triggers single consolidated call and clears pending entry
  nowMs += 1 * 60_000;
  await orch.processScheduledEvents(nowMs);
  assert.equal(startedCalls.length, 1);
  assert.equal(store.getPendingDelayedCall(CUSTOMER_CHAT_ID), null);

  // 4. Manual owner reply cancels an active delayed timer
  const cust2 = '905550000201@c.us';
  nowMs += 5 * 60_000;
  await orch.handleIncomingMessage({
    id: 'sm-4',
    from: cust2,
    phone: '905550000201',
    fromMe: false,
    type: 'chat',
    body: 'Stok var mı?',
    timestamp: Math.floor(nowMs / 1000),
  });
  assert.ok(store.getPendingDelayedCall(cust2));

  nowMs += 2 * 60_000;
  await orch.handleIncomingMessage({
    id: 'sm-4-owner',
    from: cust2,
    to: cust2,
    fromMe: true,
    type: 'chat',
    body: 'Evet elimizde mevcut.',
    timestamp: Math.floor(nowMs / 1000),
  });
  assert.equal(store.getPendingDelayedCall(cust2), null);
  nowMs += 15 * 60_000;
  await orch.processScheduledEvents(nowMs);
  assert.equal(startedCalls.length, 1);

  // 5. Urgent message breaks active timer immediately
  const cust3 = '905550000202@c.us';
  await orch.handleIncomingMessage({
    id: 'sm-5',
    from: cust3,
    phone: '905550000202',
    fromMe: false,
    type: 'chat',
    body: 'Merhaba bir bakabilir misiniz',
    timestamp: Math.floor(nowMs / 1000),
  });
  assert.ok(store.getPendingDelayedCall(cust3));
  nowMs += 60_000;
  await orch.handleIncomingMessage({
    id: 'sm-6',
    from: cust3,
    phone: '905550000202',
    fromMe: false,
    type: 'chat',
    body: 'ACİL sunucu çöktü hemen arayın!',
    timestamp: Math.floor(nowMs / 1000),
  });
  assert.equal(store.getPendingDelayedCall(cust3), null);
  assert.equal(startedCalls.length, 2);

  // 6. Voice note (ptt) calls immediately in smart mode without delay
  const cust4 = '905550000203@c.us';
  nowMs += 60_000;
  await orch.handleIncomingMessage({
    id: 'sm-7',
    from: cust4,
    phone: '905550000203',
    fromMe: false,
    type: 'ptt',
    body: '',
    hasMedia: true,
    timestamp: Math.floor(nowMs / 1000),
  });
  assert.equal(startedCalls.length, 3);
  assert.equal(clearedTimers.length > 0, true);
});

test('quiet hours buffers silently at night, wakes only on critical if allowed, transfers crossing timers, and supports auto vs ask morning resume', async (t) => {
  // Part A: Auto mode + crossing 22:00 timer + allowUrgent toggle
  const storeA = await createTempStore(t);
  const waA = createFakeWhatsApp();
  let nowA = Date.parse('2026-11-13T21:55:00+03:00');
  const callsA = [];

  const orchA = createOrchestrator({
    config: {
      ...createBaseConfig(),
      callPolicy: 'smart',
      callDelayMinutes: 10,
      quietHoursEnabled: true,
      quietHoursStart: '22:00',
      quietHoursEnd: '09:00',
      quietHoursResumeMode: 'auto',
      quietHoursAllowUrgent: false,
      aiTextProvider: 'none',
    },
    store: storeA,
    whatsapp: waA,
    callController: {
      isCallActive: () => false,
      startCallWithOwner: async (args) => {
        callsA.push(args);
        return 'answered';
      },
    },
    triageMessage: async ({ event }) => {
      const b = String(event?.body || '');
      if (/sistem.*çöktü|çok acil|üretim durdu/i.test(b)) {
        return { priority: 'critical', reason: 'critical_outage', summary: b, source: 'rule' };
      }
      if (/acil/i.test(b)) {
        return { priority: 'urgent', reason: 'urgent', summary: b, source: 'rule' };
      }
      return { priority: 'normal', reason: 'inquiry', summary: b, source: 'rule' };
    },
    nowFn: () => nowA,
    setTimeoutFn: () => ({ id: 1 }),
    clearTimeoutFn: () => {},
  });

  // 21:55 normal message schedules dueAt = 22:05 (crosses 22:00 quiet start!)
  await orchA.handleIncomingMessage({
    id: 'qa-m1',
    from: CUSTOMER_CHAT_ID,
    phone: '905550000200',
    fromMe: false,
    type: 'chat',
    body: 'Fiyat bilgisi rica edebilir miyim',
    timestamp: Math.floor(nowA / 1000),
  });
  const sentBeforeNight = waA.sent.length;

  // At 22:06, timer would fire during quiet hours -> transfers to quietQueue silently without calling or pinging owner!
  nowA = Date.parse('2026-11-13T22:06:00+03:00');
  await orchA.processScheduledEvents(nowA);
  assert.equal(callsA.length, 0);
  assert.equal(waA.sent.length, sentBeforeNight);
  assert.equal(storeA.getPendingDelayedCall(CUSTOMER_CHAT_ID), null);
  assert.equal(storeA.getQuietQueue().length, 1);

  // Critical message at 23:30 stays in quietQueue when quietHoursAllowUrgent is false
  nowA = Date.parse('2026-11-13T23:30:00+03:00');
  await orchA.handleIncomingMessage({
    id: 'qa-m2',
    from: '905550000205@c.us',
    phone: '905550000205',
    fromMe: false,
    type: 'chat',
    body: 'Üretim durdu sistem çöktü acil!',
    timestamp: Math.floor(nowA / 1000),
  });
  assert.equal(callsA.length, 0);
  assert.equal(waA.sent.length, sentBeforeNight);
  assert.equal(storeA.getQuietQueue().length, 2);

  // Enable quietHoursAllowUrgent -> normal & urgent stay silent, critical wakes immediately
  storeA.setCallSettingsOverrides({ quietHoursAllowUrgent: true });
  nowA = Date.parse('2026-11-14T01:10:00+03:00');
  await orchA.handleIncomingMessage({
    id: 'qa-m3',
    from: '905550000206@c.us',
    phone: '905550000206',
    fromMe: false,
    type: 'chat',
    body: 'Acil bilgi lazım',
    timestamp: Math.floor(nowA / 1000),
  });
  assert.equal(callsA.length, 0);
  assert.equal(storeA.getQuietQueue().length, 3);

  nowA = Date.parse('2026-11-14T01:20:00+03:00');
  await orchA.handleIncomingMessage({
    id: 'qa-m4',
    from: '905550000207@c.us',
    phone: '905550000207',
    fromMe: false,
    type: 'chat',
    body: 'Çok acil sistem tamamen çöktü!',
    timestamp: Math.floor(nowA / 1000),
  });
  assert.equal(callsA.length, 1);

  // 09:00 auto mode delivers single morning digest and clears queue
  nowA = Date.parse('2026-11-14T09:00:00+03:00');
  await orchA.processScheduledEvents(nowA);
  assert.equal(storeA.getQuietQueue().length, 0);
  const digestMsgs = waA.sent.slice(sentBeforeNight).filter((m) => /bekleyen mesajlar/i.test(m.text));
  assert.equal(digestMsgs.length, 1);
  assert.match(digestMsgs[0].text, /905550000205|Müşteri/i);

  // Running processScheduledEvents again does not duplicate digest
  await orchA.processScheduledEvents(nowA + 60_000);
  assert.equal(waA.sent.slice(sentBeforeNight).filter((m) => /bekleyen mesajlar/i.test(m.text)).length, 1);

  // Part B: Ask mode (no false daytime prompt, asks at 09:00 after night activity, holds until 'evet')
  const storeB = await createTempStore(t);
  const waB = createFakeWhatsApp();
  let nowB = Date.parse('2026-11-13T14:00:00+03:00');
  const callsB = [];
  const orchB = createOrchestrator({
    config: {
      ...createBaseConfig(),
      callPolicy: 'smart',
      callDelayMinutes: 10,
      quietHoursEnabled: true,
      quietHoursStart: '22:00',
      quietHoursEnd: '09:00',
      quietHoursResumeMode: 'ask',
      quietHoursAllowUrgent: false,
      aiTextProvider: 'none',
    },
    store: storeB,
    whatsapp: waB,
    callController: {
      isCallActive: () => false,
      startCallWithOwner: async (args) => {
        callsB.push(args);
        return 'answered';
      },
    },
    triageMessage: async ({ event }) => ({
      priority: 'normal',
      reason: 'inquiry',
      summary: String(event?.body || ''),
      source: 'rule',
    }),
    nowFn: () => nowB,
    setTimeoutFn: () => ({ id: 1 }),
    clearTimeoutFn: () => {},
  });

  // 14:00 daytime fresh startup must NOT spuriously ask to start work
  await orchB.processScheduledEvents(nowB);
  assert.equal(waB.sent.length, 0);

  // Night message arrives at 23:00
  nowB = Date.parse('2026-11-13T23:00:00+03:00');
  await orchB.handleIncomingMessage({
    id: 'qb-m1',
    from: CUSTOMER_CHAT_ID,
    phone: '905550000200',
    fromMe: false,
    type: 'chat',
    body: 'Yarın için randevu almak istiyorum',
    timestamp: Math.floor(nowB / 1000),
  });
  assert.equal(waB.sent.length, 0);
  assert.equal(storeB.getQuietScheduleState().wasQuietPendingResume, true);

  // At 09:00, asks owner for confirmation before resuming
  nowB = Date.parse('2026-11-14T09:00:00+03:00');
  await orchB.processScheduledEvents(nowB);
  assert.equal(storeB.getQuietScheduleState().awaitingOwnerConfirm, true);
  assert.equal(waB.sent.length, 1);
  assert.match(waB.sent[0].text, /mesai başlasın mı/i);

  // Customer message at 09:10 while awaiting confirmation is still buffered silently
  nowB = Date.parse('2026-11-14T09:10:00+03:00');
  await orchB.handleIncomingMessage({
    id: 'qb-m2',
    from: '905550000208@c.us',
    phone: '905550000208',
    fromMe: false,
    type: 'chat',
    body: 'Sabah fiyat sormak istedim',
    timestamp: Math.floor(nowB / 1000),
  });
  assert.equal(callsB.length, 0);
  assert.equal(storeB.getQuietQueue().length, 2);

  // Owner replies "evet" (AI_TEXT_PROVIDER=none fallback) -> confirms resume and delivers digest
  nowB = Date.parse('2026-11-14T09:12:00+03:00');
  await orchB.handleIncomingMessage({
    id: 'qb-owner-yes',
    from: OWNER_CHAT_ID,
    phone: '905550000100',
    fromMe: false,
    type: 'chat',
    body: 'evet',
    timestamp: Math.floor(nowB / 1000),
  });
  assert.equal(storeB.getQuietScheduleState().awaitingOwnerConfirm, false);
  assert.equal(storeB.getQuietScheduleState().resumeConfirmedYmd, '2026-11-14');
  assert.equal(storeB.getQuietQueue().length, 0);
  const afterConfirmText = waB.sent.slice(1).map((m) => m.text).join('\n');
  assert.match(afterConfirmText, /bekleyen mesajlar/i);

  // durum command reports Arama Modu, Gecikme, Mesai Dışı
  const beforeDurum = waB.sent.length;
  await orchB.handleIncomingMessage({
    id: 'qb-durum',
    from: OWNER_CHAT_ID,
    phone: '905550000100',
    fromMe: false,
    type: 'chat',
    body: 'durum',
    timestamp: Math.floor(nowB / 1000) + 5,
  });
  const durumText = waB.sent[beforeDurum].text;
  assert.match(durumText, /Arama Modu:/i);
  assert.match(durumText, /Mesai Dışı:/i);
});

test('urgent break and quiet transfer preserve prior buffered delayed messages, and ara/cooldown suppress duplicate scheduled calls', async (t) => {
  // 1. Urgent message breaking 10-min debounce preserves earlier buffered messages
  const store1 = await createTempStore(t);
  const wa1 = createFakeWhatsApp({
    contactsList: [{ name: 'Ahmet Test', phone: '905550000200', chatId: CUSTOMER_CHAT_ID }],
  });
  let now1 = Date.parse('2026-11-13T10:00:00+03:00');
  const liveContexts = [];

  const orch1 = createOrchestrator({
    config: {
      ...createBaseConfig(),
      callPolicy: 'smart',
      callDelayMinutes: 10,
      quietHoursEnabled: true,
      quietHoursStart: '22:00',
      quietHoursEnd: '09:00',
      quietHoursResumeMode: 'auto',
      quietHoursAllowUrgent: false,
      aiTextProvider: 'none',
    },
    store: store1,
    whatsapp: wa1,
    callController: {
      isCallActive: () => false,
      startCallWithOwner: async (callbacks) => {
        const sess = {
          hangUp: async () => 'normal',
          waitForEnd: () => new Promise((r) => setTimeout(() => r('answered'), 15)),
          getOutcome: () => 'answered',
        };
        await callbacks.onConnected?.(sess);
        return sess;
      },
    },
    startLiveSession: async ({ customerContext }) => {
      liveContexts.push(customerContext);
      return { sendOwnerAudio() {}, close() {} };
    },
    triageMessage: async ({ event }) => {
      const b = String(event?.body || '');
      if (/acil|ACİL/i.test(b)) {
        return { priority: 'urgent', reason: 'urgent', summary: b, source: 'rule' };
      }
      return { priority: 'normal', reason: 'normal', summary: b, source: 'rule' };
    },
    nowFn: () => now1,
    setTimeoutFn: () => ({ id: 1 }),
    clearTimeoutFn: () => {},
  });

  await orch1.handleIncomingMessage({
    id: 'urg-1',
    from: CUSTOMER_CHAT_ID,
    phone: '905550000200',
    fromMe: false,
    type: 'chat',
    body: 'Merhaba bir siparişim vardı',
    timestamp: Math.floor(now1 / 1000),
  });
  now1 += 2 * 60_000;
  await orch1.handleIncomingMessage({
    id: 'urg-2',
    from: CUSTOMER_CHAT_ID,
    phone: '905550000200',
    fromMe: false,
    type: 'chat',
    body: 'Kargo adresi de değişecekti',
    timestamp: Math.floor(now1 / 1000),
  });
  now1 += 60_000;
  const sentBeforeUrgent = wa1.sent.length;
  await orch1.handleIncomingMessage({
    id: 'urg-3',
    from: CUSTOMER_CHAT_ID,
    phone: '905550000200',
    fromMe: false,
    type: 'chat',
    body: 'ACİL hemen dönüş yapar mısınız!',
    timestamp: Math.floor(now1 / 1000),
  });

  assert.equal(store1.getPendingDelayedCall(CUSTOMER_CHAT_ID), null);
  assert.equal(liveContexts.length, 1);
  assert.match(liveContexts[0].triggerMessage, /siparişim vardı/i);
  assert.match(liveContexts[0].triggerMessage, /Kargo adresi/i);
  assert.match(liveContexts[0].triggerMessage, /ACİL/i);
  const urgentNotice = wa1.sent.slice(sentBeforeUrgent).map((m) => m.text).join('\n');
  assert.match(urgentNotice, /siparişim vardı/i);
  assert.match(urgentNotice, /Kargo adresi/i);

  // Night transition preserves earlier buffered messages into quietQueue too
  const custNight = '905550000215@c.us';
  now1 = Date.parse('2026-11-13T21:55:00+03:00');
  await orch1.handleIncomingMessage({
    id: 'qn-1',
    from: custNight,
    phone: '905550000215',
    fromMe: false,
    type: 'chat',
    body: 'Fatura kopyasını alabilir miyim',
    timestamp: Math.floor(now1 / 1000),
  });
  now1 = Date.parse('2026-11-13T22:01:00+03:00');
  await orch1.handleIncomingMessage({
    id: 'qn-2',
    from: custNight,
    phone: '905550000215',
    fromMe: false,
    type: 'chat',
    body: 'Vergi numaramızı ekleyin lütfen',
    timestamp: Math.floor(now1 / 1000),
  });
  assert.equal(store1.getPendingDelayedCall(custNight), null);
  const qItem = store1.getQuietQueue().find((q) => q.chatId === custNight);
  assert.ok(qItem);
  assert.match(qItem.summary, /Fatura kopyasını/i);
  assert.match(qItem.summary, /Vergi numaramızı/i);

  // 2. Owner command `ara <isim>` clears pendingDelayedCalls & quietQueue immediately, and runScheduledTick respects full 120m cooldowns
  const store2 = await createTempStore(t);
  const custAra = '905550000222@c.us';
  const wa2 = createFakeWhatsApp({
    contactsList: [{ name: 'Zeynep Erken', phone: '905550000222', chatId: custAra }],
  });
  let now2 = Date.parse('2026-11-13T11:00:00+03:00');
  let callCount2 = 0;

  const orch2 = createOrchestrator({
    config: {
      ...createBaseConfig(),
      callPolicy: 'smart',
      callDelayMinutes: 10,
      cooldownMinutes: 120,
      quietHoursEnabled: false,
      aiTextProvider: 'none',
    },
    store: store2,
    whatsapp: wa2,
    callController: {
      isCallActive: () => false,
      startCallWithOwner: async () => {
        callCount2 += 1;
        return 'answered';
      },
    },
    triageMessage: async ({ event }) => ({
      priority: 'normal',
      reason: 'normal',
      summary: String(event?.body || ''),
      source: 'rule',
    }),
    nowFn: () => now2,
    setTimeoutFn: () => ({ id: 1 }),
    clearTimeoutFn: () => {},
  });

  await orch2.handleIncomingMessage({
    id: 'ara-q1',
    from: custAra,
    phone: '905550000222',
    fromMe: false,
    type: 'chat',
    body: 'Ürün fiyatı nedir?',
    timestamp: Math.floor(now2 / 1000),
  });
  store2.enqueueQuietMessage({
    chatId: custAra,
    customerName: 'Zeynep Erken',
    phone: '905550000222',
    priority: 'normal',
    summary: 'Önceki gece sordu',
    latestMessage: 'Ürün?',
    atMs: now2 - 3600_000,
  });
  assert.ok(store2.getPendingDelayedCall(custAra));

  now2 += 60_000;
  await orch2.handleIncomingMessage({
    id: 'ara-cmd',
    from: OWNER_CHAT_ID,
    phone: '905550000100',
    fromMe: false,
    type: 'chat',
    body: 'ara Zeynep',
    timestamp: Math.floor(now2 / 1000),
  });
  assert.equal(callCount2, 1);
  assert.equal(store2.getPendingDelayedCall(custAra), null);
  assert.equal(store2.getQuietQueue().some((q) => q.chatId === custAra), false);

  // Even if a pendingDelayedCall were left stale after answered call or 45-min-old lastTextReplyAt (<120m), runScheduledTick skips calling
  const custCd = '905550000223@c.us';
  store2.updateChatState(custCd, { lastTextReplyAt: now2 - 45 * 60_000 });
  store2.upsertPendingDelayedCall({
    chatId: custCd,
    customerName: 'Cooldown Müşteri',
    dueAtMs: now2 + 1000,
    messages: ['Selam'],
  });
  const custAns = '905550000224@c.us';
  store2.updateChatState(custAns, { lastCallAt: now2 - 60 * 60_000, lastCallStatus: 'answered' });
  store2.upsertPendingDelayedCall({
    chatId: custAns,
    customerName: 'Answered Müşteri',
    dueAtMs: now2 + 1000,
    messages: ['Selam 2'],
  });

  now2 += 5000;
  await orch2.processScheduledEvents(now2);
  assert.equal(callCount2, 1);
  assert.equal(store2.getPendingDelayedCall(custCd), null);
  assert.equal(store2.getPendingDelayedCall(custAns), null);
});

test('preserves pendingCallChatId across other customers ignored, delayed, or quiet-hours messages and clears equivalent identities', async (t) => {
  const store = await createTempStore(t);
  const wa = createFakeWhatsApp();
  let now = Date.parse('2026-11-13T14:00:00+03:00');
  const custA = '905551110001@c.us';
  const custB = '905552220002@c.us';

  const orch = createOrchestrator({
    config: {
      ...createBaseConfig(),
      callPolicy: 'smart',
      callDelayMinutes: 10,
      quietHoursEnabled: true,
      quietHoursStart: '22:00',
      quietHoursEnd: '09:00',
      quietHoursResumeMode: 'auto',
      aiTextProvider: 'none',
    },
    store,
    whatsapp: wa,
    callController: {
      isCallActive: () => false,
      startCallWithOwner: async () => 'answered',
    },
    triageMessage: async ({ event }) => {
      const b = String(event?.body || '');
      if (b === 'Teşekkürler') {
        return { priority: 'ignore', reason: 'trivial', summary: b, source: 'rule' };
      }
      return { priority: 'normal', reason: 'normal', summary: b, source: 'rule' };
    },
    nowFn: () => now,
    setTimeoutFn: () => ({ id: 1 }),
    clearTimeoutFn: () => {},
  });

  // Customer A has a pending call (e.g., from a missed call)
  store.setPendingCallChatId(custA);

  // 1. Customer B sends a trivial ignored message -> Customer A's pendingCallChatId must be preserved!
  await orch.handleIncomingMessage({
    id: 'pend-1',
    from: custB,
    phone: '905552220002',
    fromMe: false,
    type: 'chat',
    body: 'Teşekkürler',
    timestamp: Math.floor(now / 1000),
  });
  assert.equal(store.getPendingCallChatId(), custA);

  // 2. Customer B sends a normal message that gets smart_delayed -> Customer A's pendingCallChatId must be preserved!
  await orch.handleIncomingMessage({
    id: 'pend-2',
    from: custB,
    phone: '905552220002',
    fromMe: false,
    type: 'chat',
    body: 'Merhaba fiyat nedir?',
    timestamp: Math.floor(now / 1000),
  });
  assert.equal(store.getPendingCallChatId(), custA);

  // 3. During quiet hours, Customer B sends a message -> Customer A's pendingCallChatId must still be preserved!
  now = Date.parse('2026-11-13T23:00:00+03:00');
  await orch.handleIncomingMessage({
    id: 'pend-3',
    from: custB,
    phone: '905552220002',
    fromMe: false,
    type: 'chat',
    body: 'Gece mesajı',
    timestamp: Math.floor(now / 1000),
  });
  assert.equal(store.getPendingCallChatId(), custA);
});

test('triage race conditions: clears timer during triage, re-arms on ignore, aborts if owner replied during triage, and schedules smart delay during active call', async (t) => {
  const store = await createTempStore(t);
  const wa = createFakeWhatsApp();
  let now = Date.parse('2026-11-13T15:00:00+03:00');
  const clearedHandles = [];
  const armedHandles = [];
  let activeCallFlag = false;
  let callsStarted = 0;

  let onTriageStart = null;
  let releaseTriage = null;

  const orch = createOrchestrator({
    config: {
      ...createBaseConfig(),
      callPolicy: 'smart',
      callDelayMinutes: 10,
      quietHoursEnabled: false,
      aiTextProvider: 'none',
    },
    store,
    whatsapp: wa,
    callController: {
      isCallActive: () => activeCallFlag,
      startCallWithOwner: async () => {
        callsStarted += 1;
        return 'answered';
      },
    },
    triageMessage: async ({ event }) => {
      if (onTriageStart) {
        onTriageStart();
      }
      if (releaseTriage) {
        await releaseTriage;
      }
      const b = String(event?.body || '');
      if (b === '👍') return { priority: 'ignore', reason: 'trivial', summary: b, source: 'rule' };
      if (/acil/i.test(b)) return { priority: 'urgent', reason: 'urgent', summary: b, source: 'rule' };
      return { priority: 'normal', reason: 'normal', summary: b, source: 'rule' };
    },
    nowFn: () => now,
    setTimeoutFn: (fn, delay) => {
      const h = { id: armedHandles.length + 1, delay, fn };
      armedHandles.push(h);
      return h;
    },
    clearTimeoutFn: (h) => {
      if (h) clearedHandles.push(h.id);
    },
  });

  // 1. Seed a delayed call via normal message, then send '👍' -> timer cleared before triage and re-armed on ignore
  await orch.handleIncomingMessage({
    id: 'tr-race-1',
    from: CUSTOMER_CHAT_ID,
    phone: '905551112233',
    fromMe: false,
    type: 'chat',
    body: 'İlk mesaj',
    timestamp: Math.floor(now / 1000),
  });
  assert.equal(armedHandles.length, 1);
  let clearedDuringTriage = false;
  onTriageStart = () => {
    clearedDuringTriage = clearedHandles.includes(1);
  };
  await orch.handleIncomingMessage({
    id: 'tr-race-2',
    from: CUSTOMER_CHAT_ID,
    phone: '905551112233',
    fromMe: false,
    type: 'chat',
    body: '👍',
    timestamp: Math.floor(now / 1000),
  });
  onTriageStart = null;
  assert.equal(clearedDuringTriage, true);
  assert.equal(armedHandles.length, 2); // Re-armed!

  // 2. Equivalent identity ('05551112233@c.us') updates the same canonical delayed entry instead of creating a duplicate
  now += 60_000;
  await orch.handleIncomingMessage({
    id: 'tr-race-eq',
    from: '05551112233@c.us',
    phone: '05551112233',
    fromMe: false,
    type: 'chat',
    body: 'Ek bilgi',
    timestamp: Math.floor(now / 1000),
  });
  assert.deepEqual(Object.keys(store.getPendingDelayedCalls()), [CUSTOMER_CHAT_ID]);
  assert.equal(store.getPendingDelayedCall(CUSTOMER_CHAT_ID).messages.length, 2);

  // 3. Urgent message arrives, but while triageMessage is awaiting LLM, owner replies fromMe -> aborts call!
  const custUrg = '905553334444@c.us';
  let unlockTriage;
  releaseTriage = new Promise((r) => {
    unlockTriage = r;
  });
  const urgPromise = orch.handleIncomingMessage({
    id: 'tr-race-3',
    from: custUrg,
    phone: '905553334444',
    fromMe: false,
    type: 'chat',
    body: 'Acil bakar mısınız',
    timestamp: Math.floor(now / 1000),
  });
  await new Promise((r) => setTimeout(r, 10));
  // Owner replies while triage is still in flight
  await orch.handleIncomingMessage({
    id: 'tr-race-3-owner',
    from: custUrg,
    to: custUrg,
    fromMe: true,
    type: 'chat',
    body: 'Bakıyorum hemen',
    timestamp: Math.floor(now / 1000),
  });
  unlockTriage();
  const urgRes = await urgPromise;
  releaseTriage = null;
  assert.equal(urgRes.action, 'ignore');
  assert.equal(urgRes.reason, 'owner_active_window');
  assert.equal(callsStarted, 0);

  // 4. Normal message arrives while another call is in progress -> schedules 10-min delayed call instead of dropping it
  const custDuringCall = '905554445555@c.us';
  activeCallFlag = true;
  const duringCallRes = await orch.handleIncomingMessage({
    id: 'tr-race-4',
    from: custDuringCall,
    phone: '905554445555',
    fromMe: false,
    type: 'chat',
    body: 'Fiyat listesi alabilir miyim?',
    timestamp: Math.floor(now / 1000),
  });
  activeCallFlag = false;
  assert.equal(duringCallRes.reason, 'smart_delayed');
  assert.ok(store.getPendingDelayedCall(custDuringCall));
});

test('runScheduledTick retries failed morning/snooze notices, resets awaitingOwnerConfirm on night entry, avoids @lid phone leak, and notifies multi-message silenced entries', async (t) => {
  const store = await createTempStore(t);
  let sendShouldFail = true;
  const wa = createFakeWhatsApp();
  const origSend = wa.sendMessage.bind(wa);
  wa.sendMessage = async (chatId, text, options) => {
    if (sendShouldFail) return null;
    return origSend(chatId, text, options);
  };

  let now = Date.parse('2026-11-13T23:00:00+03:00');
  const lidCustomer = '9988776655@lid';

  const orch = createOrchestrator({
    config: {
      ...createBaseConfig(),
      callPolicy: 'smart',
      callDelayMinutes: 10,
      quietHoursEnabled: true,
      quietHoursStart: '22:00',
      quietHoursEnd: '09:00',
      quietHoursResumeMode: 'auto',
      aiTextProvider: 'none',
    },
    store,
    whatsapp: wa,
    callController: { isCallActive: () => false, startCallWithOwner: async () => 'answered' },
    triageMessage: async ({ event }) => ({
      priority: 'normal',
      reason: 'normal',
      summary: String(event?.body || ''),
      source: 'rule',
    }),
    nowFn: () => now,
    setTimeoutFn: () => ({ id: 1 }),
    clearTimeoutFn: () => {},
  });

  // 1. @lid message during quiet hours without phone should record phone: '' (not LID digits)
  await orch.handleIncomingMessage({
    id: 'lid-q-1',
    from: lidCustomer,
    fromMe: false,
    type: 'chat',
    body: 'Gece mesajı lid',
    timestamp: Math.floor(now / 1000),
  });
  const qItems = store.getQuietQueue();
  assert.equal(qItems.length, 1);
  assert.equal(qItems[0].phone, '');

  // 2. At 09:00 when sendMessage fails (returns null), quietQueue is NOT cleared and lastMorningPromptYmd is NOT set
  now = Date.parse('2026-11-14T09:00:00+03:00');
  await orch.processScheduledEvents(now);
  assert.equal(store.getQuietQueue().length, 1);
  assert.notEqual(store.getQuietScheduleState().lastMorningPromptYmd, '2026-11-14');

  // When sendMessage succeeds on next tick, digest is sent and quietQueue is cleared
  sendShouldFail = false;
  await orch.processScheduledEvents(now + 60_000);
  assert.equal(store.getQuietQueue().length, 0);
  assert.equal(store.getQuietScheduleState().lastMorningPromptYmd, '2026-11-14');

  // 3. If awaitingOwnerConfirm was left true during day, entering scheduledQuiet at 22:00 resets awaitingOwnerConfirm: false and lastMorningPromptYmd: null
  store.setQuietScheduleState({
    awaitingOwnerConfirm: true,
    wasQuietPendingResume: false,
    lastMorningPromptYmd: '2026-11-14',
  });
  now = Date.parse('2026-11-14T22:05:00+03:00');
  await orch.processScheduledEvents(now);
  assert.equal(store.getQuietScheduleState().awaitingOwnerConfirm, false);
  assert.equal(store.getQuietScheduleState().lastMorningPromptYmd, null);
  assert.equal(store.getQuietScheduleState().wasQuietPendingResume, true);

  // 4. Multi-message delayed entry maturing while silenced still sends 🔕 summary notice so follow-up messages aren't lost
  now = Date.parse('2026-11-15T12:00:00+03:00');
  store.setQuietScheduleState({
    awaitingOwnerConfirm: false,
    wasQuietPendingResume: false,
    resumeConfirmedYmd: '2026-11-15',
  });
  const custSil = '905556667777@c.us';
  store.upsertPendingDelayedCall({
    chatId: custSil,
    customerName: 'Çoklu Mesaj Müşteri',
    dueAtMs: now - 1000,
    messages: ['Mesaj 1', 'Mesaj 2 eklendi'],
  });
  store.setSilencedUntil(now + 600_000);
  const sentBeforeSilTick = wa.sent.length;
  await orch.processScheduledEvents(now);
  const sentAfterSilTick = wa.sent.slice(sentBeforeSilTick);
  assert.equal(sentAfterSilTick.length, 1);
  assert.match(sentAfterSilTick[0].text, /Mesaj 1.*Mesaj 2 eklendi/);
});

test('devam resumes awaitingOwnerConfirm/snooze, ara uses customer history/pending summary and chat name instead of "ara", deterministic morning confirm works with AI text enabled, and startLiveForCall guards duplicate connect & hangs up before notice', async (t) => {
  const store = await createTempStore(t);
  let now = Date.parse('2026-11-14T09:05:00+03:00');
  const wa = createFakeWhatsApp({
    contactsList: [{ name: 'Kemal Kaya', phone: '905551112233', chatId: CUSTOMER_CHAT_ID }],
    historyByChat: {
      [CUSTOMER_CHAT_ID]: [
        { id: 'h1', fromMe: false, body: 'Gerçek müşteri sorusu nedir?', type: 'chat', timestamp: 1700001 },
      ],
    },
  });
  wa.getChatById = async (id) => (id === CUSTOMER_CHAT_ID ? { name: 'Kemal Kaya (Chat)' } : null);

  const liveContexts = [];
  let startLiveCount = 0;
  let shouldFailLive = false;
  const actionOrder = [];

  const origSend = wa.sendMessage.bind(wa);
  wa.sendMessage = async (chatId, text, options) => {
    actionOrder.push(`sendMessage:${text.slice(0, 15)}`);
    return origSend(chatId, text, options);
  };

  let textTurns = 0;
  const orch = createOrchestrator({
    config: {
      ...createBaseConfig(),
      quietHoursEnabled: true,
      quietHoursStart: '22:00',
      quietHoursEnd: '09:00',
      quietHoursResumeMode: 'ask',
      aiText: { provider: 'gemini', apiKey: 'test', model: 'gemini-3.8-flash' },
    },
    store,
    whatsapp: wa,
    callController: {
      isCallActive: () => false,
      startCallWithOwner: async (callbacks) => {
        let resolveDone;
        const done = new Promise((r) => {
          resolveDone = r;
        });
        const session = {
          done,
          pushAudioToOwner() {},
          flushAudioToOwner() {},
          hangUp: async (reason) => {
            actionOrder.push(`hangUp:${reason}`);
            callbacks.onEnded?.('answered', { reason });
            resolveDone('answered');
          },
        };
        // Trigger onConnected twice to verify duplicate guard
        await callbacks.onConnected(session);
        await callbacks.onConnected(session);
        if (!shouldFailLive) {
          resolveDone('answered');
        }
        return session;
      },
    },
    startLiveSession: async ({ customerContext }) => {
      startLiveCount += 1;
      if (shouldFailLive) {
        throw new Error('Live connection boom');
      }
      liveContexts.push(customerContext);
      return { sendOwnerAudio() {}, close() {} };
    },
    runTextTurn: async () => {
      textTurns += 1;
      return { ok: true, text: 'LLM yanıtı' };
    },
    nowFn: () => now,
  });

  // 1. Default version fallback in durum is v0.2.2 when appVersion is not set
  await orch.handleIncomingMessage({
    id: 'ver-1',
    from: OWNER_CHAT_ID,
    phone: '905550000100',
    fromMe: false,
    type: 'chat',
    body: 'durum',
    timestamp: Math.floor(now / 1000),
  });
  assert.match(wa.sent.at(-1).text, /v0\.2\.2/);

  // 2. Deterministic morning confirm ("evet") works without calling runTextTurn even when AI text is enabled
  store.setQuietScheduleState({
    awaitingOwnerConfirm: true,
    wasQuietPendingResume: false,
    lastMorningPromptYmd: '2026-11-14',
  });
  store.enqueueQuietMessage({
    chatId: CUSTOMER_CHAT_ID,
    customerName: 'Kemal Kaya',
    phone: '905551112233',
    priority: 'normal',
    summary: 'Gece sorusu',
    latestMessage: 'Gece sorusu',
    atMs: now - 3600_000,
  });
  await orch.handleIncomingMessage({
    id: 'det-yes',
    from: OWNER_CHAT_ID,
    phone: '905550000100',
    fromMe: false,
    type: 'chat',
    body: 'evet',
    timestamp: Math.floor(now / 1000),
  });
  assert.equal(textTurns, 0);
  assert.equal(store.getQuietScheduleState().awaitingOwnerConfirm, false);
  assert.equal(store.getQuietQueue().length, 0);

  // 3. "devam" command also clears awaitingOwnerConfirm/snoozeActive and flushes quietQueue
  store.setQuietScheduleState({
    awaitingOwnerConfirm: true,
    snoozedUntilMs: now + 1800_000,
    pendingSnoozeDigest: true,
  });
  store.enqueueQuietMessage({
    chatId: CUSTOMER_CHAT_ID,
    customerName: 'Kemal Kaya',
    phone: '905551112233',
    priority: 'normal',
    summary: 'Erteleme sorusu',
    latestMessage: 'Erteleme sorusu',
    atMs: now - 1000,
  });
  await orch.handleIncomingMessage({
    id: 'cmd-devam-quiet',
    from: OWNER_CHAT_ID,
    phone: '905550000100',
    fromMe: false,
    type: 'chat',
    body: 'devam',
    timestamp: Math.floor(now / 1000),
  });
  assert.equal(store.getQuietScheduleState().awaitingOwnerConfirm, false);
  assert.equal(store.getQuietScheduleState().snoozedUntilMs, null);
  assert.equal(store.getQuietQueue().length, 0);
  assert.match(wa.sent.at(-1).text, /Erteleme sorusu/);

  // 4. "ara" (call_latest) resolves customerName via getChatById and uses customer's last message instead of "ara", while duplicate onConnected only starts 1 live session
  store.setPendingCallChatId(CUSTOMER_CHAT_ID);
  await orch.handleIncomingMessage({
    id: 'cmd-ara-latest',
    from: OWNER_CHAT_ID,
    phone: '905550000100',
    fromMe: false,
    type: 'chat',
    body: 'ara',
    timestamp: Math.floor(now / 1000),
  });
  assert.equal(startLiveCount, 1);
  assert.equal(liveContexts[0].customerName, 'Kemal Kaya (Chat)');
  assert.equal(liveContexts[0].triggerMessage, 'Gerçek müşteri sorusu nedir?');

  // 5. When startLiveSession fails, requestCallHangup runs BEFORE sendOwnerNotice
  actionOrder.length = 0;
  shouldFailLive = true;
  await orch.handleIncomingMessage({
    id: 'cmd-ara-query',
    from: OWNER_CHAT_ID,
    phone: '905550000100',
    fromMe: false,
    type: 'chat',
    body: 'ara Kemal',
    timestamp: Math.floor(now / 1000),
  });
  const hangupIdx = actionOrder.findIndex((x) => x.startsWith('hangUp:live_session_start_failed'));
  const noticeIdx = actionOrder.findIndex((x) => x.startsWith('sendMessage:⚠️'));
  assert.ok(hangupIdx !== -1 && noticeIdx !== -1 && hangupIdx < noticeIdx);
});

