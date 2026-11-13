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
