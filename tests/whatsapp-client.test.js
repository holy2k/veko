import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { getBrowserHookScript } from '../src/whatsapp/injected-hook.js';
import {
  createWhatsAppClient,
  resolveChromeExecutablePath,
  buildPuppeteerOptions,
} from '../src/whatsapp/client.js';
import {
  AUDIO_CALL_SELECTORS,
  HANGUP_SELECTORS,
  analyzeCallDomFromDocument,
  selectClickableCandidate,
  createSpikeLifecycle,
} from '../scripts/spike-webrtc-call.js';

function makeMockBrowserEnv() {
  const createdSources = [];
  const destinations = [];
  const peerInstances = [];

  class MockAudioBuffer {
    constructor(channels, length, sampleRate) {
      this.numberOfChannels = channels;
      this.length = length;
      this.sampleRate = sampleRate;
      this._data = new Float32Array(length);
    }
    getChannelData() {
      return this._data;
    }
  }

  class MockSourceNode {
    constructor() {
      this.buffer = null;
      this.startedAt = null;
      this.stopped = false;
      this.disconnected = false;
      this.onended = null;
      createdSources.push(this);
    }
    connect() {}
    disconnect() {
      this.disconnected = true;
    }
    start(when) {
      this.startedAt = when;
    }
    stop() {
      this.stopped = true;
    }
  }

  class MockGainNode {
    constructor() {
      this.gain = { value: 1 };
    }
    connect() {}
    disconnect() {}
  }

  class MockDestination {
    constructor() {
      const track = { kind: 'audio', enabled: true, readyState: 'live', stop() { this.readyState = 'ended'; } };
      this.stream = {
        getAudioTracks: () => [track],
        getTracks: () => [track],
      };
      destinations.push(this);
    }
  }

  class MockScriptProcessor {
    constructor() {
      this.onaudioprocess = null;
    }
    connect() {}
    disconnect() {}
  }

  class MockAudioContext {
    constructor() {
      this.sampleRate = 48000;
      this.currentTime = 1.0;
      this.state = 'running';
    }
    resume() {
      return Promise.resolve();
    }
    createGain() {
      return new MockGainNode();
    }
    createMediaStreamDestination() {
      return new MockDestination();
    }
    createBuffer(channels, length, sampleRate) {
      return new MockAudioBuffer(channels, length, sampleRate);
    }
    createBufferSource() {
      return new MockSourceNode();
    }
    createMediaStreamSource() {
      return { connect() {} };
    }
    createScriptProcessor() {
      const node = new MockScriptProcessor();
      this._lastScriptProcessor = node;
      return node;
    }
  }

  class MockRTCPeerConnection {
    constructor(cfg) {
      this.config = cfg;
      this.connectionState = 'new';
      this.iceConnectionState = 'new';
      this.signalingState = 'stable';
      this._listeners = new Map();
      peerInstances.push(this);
    }
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    }
    emit(type, evt = {}) {
      for (const fn of this._listeners.get(type) || []) {
        fn(evt);
      }
    }
  }

  const origGetUserMedia = async (constraints) => ({ orig: true, constraints });
  const navigator = {
    mediaDevices: {
      getUserMedia: origGetUserMedia,
    },
  };
  class MockMediaStream {
    constructor(tracks = []) {
      this._tracks = tracks;
    }
    getTracks() {
      return this._tracks;
    }
  }

  const context = {
    window: null,
    navigator,
    AudioContext: MockAudioContext,
    RTCPeerConnection: MockRTCPeerConnection,
    MediaStream: MockMediaStream,
    Int16Array,
    Float32Array,
    Uint8Array,
    Math,
    Promise,
    Set,
    Array,
    Date,
    Error,
    atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
    btoa: (str) => Buffer.from(str, 'binary').toString('base64'),
  };
  context.window = context;
  vm.createContext(context);

  return { context, createdSources, destinations, peerInstances };
}

test('getBrowserHookScript wraps getUserMedia, RTCPeerConnection, outgoing PCM queue, and incoming capture', async () => {
  const script = getBrowserHookScript();
  assert.equal(typeof script, 'string');
  assert.ok(script.includes('__wpJarvisAudio'));

  const env = makeMockBrowserEnv();
  vm.runInContext(script, env.context);

  const api = env.context.window.__wpJarvisAudio;
  assert.ok(api, 'window.__wpJarvisAudio should be exposed');

  // Video-only delegates to original getUserMedia
  const vidStream = await env.context.navigator.mediaDevices.getUserMedia({ video: true });
  assert.equal(vidStream.orig, true);

  // Audio request returns spoofed MediaStreamDestination stream
  const audStream = await env.context.navigator.mediaDevices.getUserMedia({ audio: true });
  assert.equal(audStream.getAudioTracks()[0].kind, 'audio');
  assert.equal(audStream.getAudioTracks()[0].readyState, 'live');

  // Outgoing PCM enqueue, base64 odd-byte handling, and barge-in flush (index 0 is silent WebRTC keepalive)
  api.pushOutgoingPcm(new Int16Array([1000, -1000, 500, -500]), 24000);
  const oddB64 = Buffer.from([0x01, 0x02, 0x03]).toString('base64');
  assert.equal(api.pushOutgoingBase64Pcm(oddB64, 24000), 1);
  assert.equal(env.createdSources.length, 3);
  assert.equal(env.createdSources[0].loop, true);
  assert.equal(env.createdSources[1].buffer.sampleRate, 24000);
  api.flushOutgoingPcm();
  assert.equal(env.createdSources[0].stopped, false);
  assert.equal(env.createdSources[1].stopped, true);
  assert.equal(env.createdSources[2].stopped, true);

  // RTCPeerConnection wrapping + telemetry + incoming audio capture
  const pc = new env.context.window.RTCPeerConnection({});
  pc.iceConnectionState = 'connected';
  pc.emit('iceconnectionstatechange');
  pc.connectionState = 'connected';
  pc.emit('connectionstatechange');

  const receivedChunks = [];
  api.setIncomingPcmHandler((samples) => receivedChunks.push(samples));
  api.startIncomingCapture();

  pc.emit('track', { track: { kind: 'audio' }, streams: [{}] });
  const proc = api._debugGetIncomingContexts()[0]._lastScriptProcessor;
  assert.ok(proc && typeof proc.onaudioprocess === 'function');

  // Simulate 480 samples at 48kHz (should downsample to 160 samples at 16kHz)
  const in48k = new Float32Array(480);
  in48k.fill(0.5);
  proc.onaudioprocess({ inputBuffer: { getChannelData: () => in48k } });

  assert.equal(receivedChunks.length, 1);
  assert.equal(receivedChunks[0].length, 160);
  const drained = api.drainIncomingPcm();
  assert.equal(drained.byteLength, 320);

  const telemetry = api.getTelemetry();
  assert.equal(telemetry.hookedGetUserMediaCount, 1);
  assert.equal(telemetry.hookedPeerConnectionCount, 1);
  assert.equal(telemetry.latestIceConnectionState, 'connected');
  assert.equal(telemetry.latestConnectionState, 'connected');
});

test('resolveChromeExecutablePath honors explicit path and auto-detects Edge, Chrome, or Puppeteer cache', () => {
  assert.equal(
    resolveChromeExecutablePath(
      { chromeExecutablePath: 'D:\\Custom\\chrome.exe' },
      { existsSync: () => false, puppeteerExecutablePath: () => 'C:\\puppet\\chrome.exe' }
    ),
    'D:\\Custom\\chrome.exe'
  );

  // Edge fallback when Chrome missing and Puppeteer download skipped
  assert.equal(
    resolveChromeExecutablePath(
      {},
      {
        existsSync: (p) => p === 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        puppeteerExecutablePath: () => 'C:\\missing\\chrome.exe',
      }
    ),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  );

  // Chrome detection
  assert.equal(
    resolveChromeExecutablePath(
      {},
      {
        existsSync: (p) => p === 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        puppeteerExecutablePath: () => 'C:\\missing\\chrome.exe',
      }
    ),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  );

  // Puppeteer cache detection
  assert.equal(
    resolveChromeExecutablePath(
      {},
      {
        existsSync: (p) => p === 'C:\\Users\\test\\.cache\\puppeteer\\chrome\\chrome.exe',
        puppeteerExecutablePath: () => 'C:\\Users\\test\\.cache\\puppeteer\\chrome\\chrome.exe',
      }
    ),
    'C:\\Users\\test\\.cache\\puppeteer\\chrome\\chrome.exe'
  );

  assert.equal(
    resolveChromeExecutablePath({}, { existsSync: () => false, puppeteerExecutablePath: () => '' }),
    undefined
  );
});

test('buildPuppeteerOptions configures required WebRTC/VDS Chromium flags and headless mode', () => {
  const opts = buildPuppeteerOptions(
    { chromeHeadless: 'new', chromeExecutablePath: 'C:\\Edge\\msedge.exe' },
    { existsSync: () => true }
  );
  assert.equal(opts.headless, 'new');
  assert.equal(opts.executablePath, 'C:\\Edge\\msedge.exe');
  assert.deepEqual(opts.ignoreDefaultArgs, ['--mute-audio']);
  for (const flag of [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-features=CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--no-sandbox',
  ]) {
    assert.ok(opts.args.includes(flag), `Missing arg: ${flag}`);
  }

  const headedOpts = buildPuppeteerOptions({ chromeHeadless: false }, { existsSync: () => false, puppeteerExecutablePath: () => '' });
  assert.equal(headedOpts.headless, false);
  assert.equal('executablePath' in headedOpts, false);
});

test('createWhatsAppClient exposes required interfaces and NEVER calls sendSeen on customer chats', async () => {
  let seenCalled = false;
  let capturedClientOptions = null;
  let fakeClientInstance = null;

  class FakeLocalAuth {
    constructor(opts) {
      this.opts = opts;
    }
  }

  class FakeClient extends EventEmitter {
    constructor(options) {
      super();
      capturedClientOptions = options;
      this.pupPage = {
        evaluateOnNewDocument: async () => {},
        evaluate: async () => true,
      };
      fakeClientInstance = this;
    }
    async initialize() {}
    async destroy() {}
    async sendMessage(chatId, text, options) {
      if (options?.sendSeen !== false) {
        seenCalled = true;
      }
      return { id: { _serialized: `true_${chatId}_MSG1` } };
    }
    async getChatById(chatId) {
      return {
        id: { _serialized: chatId },
        async sendSeen() {
          seenCalled = true;
        },
        async fetchMessages({ limit }) {
          assert.equal(limit, 15);
          return [
            { fromMe: false, timestamp: 1700000000, type: 'chat', body: 'Merhaba' },
            { fromMe: true, timestamp: 1700000010, type: 'ptt', duration: '14', body: '' },
            {
              fromMe: false,
              timestamp: 1700000020,
              type: 'document',
              _data: { filename: 'teklif.pdf' },
              body: 'Ektedir',
            },
          ];
        },
      };
    }
    async getContacts() {
      return [
        { id: { _serialized: '905551110001@c.us', user: '905551110001' }, number: '905551110001', name: 'Eren Sağlayıcı', isGroup: false, isMe: false },
        { id: { _serialized: '120363000000000000@g.us' }, name: 'Eren Grubu', isGroup: true, isMe: false },
      ];
    }
    async getChats() {
      return [
        { id: { _serialized: '905551110001@c.us', user: '905551110001' }, name: 'Eren Sağlayıcı', isGroup: false },
        { id: { _serialized: '905551110002@c.us', user: '905551110002' }, name: 'Eren Kargo', isGroup: false },
      ];
    }
  }

  const received = [];
  let readyFired = false;
  let qrValue = null;
  let disconnectedReason = null;

  const adapter = createWhatsAppClient(
    { chromeHeadless: 'new', chromeExecutablePath: 'C:\\Edge\\msedge.exe' },
    {
      onMessage: (evt) => received.push(evt),
      onQr: (qr) => { qrValue = qr; },
      onReady: () => { readyFired = true; },
      onDisconnected: (r) => { disconnectedReason = r; },
    },
    { Client: FakeClient, LocalAuth: FakeLocalAuth }
  );

  assert.ok(capturedClientOptions.authStrategy instanceof FakeLocalAuth);
  assert.equal(typeof capturedClientOptions.evalOnNewDoc, 'string');
  assert.ok(capturedClientOptions.evalOnNewDoc.includes('__wpJarvisAudio'));

  // Test events including fromMe via message_create
  fakeClientInstance.emit('qr', 'qr-payload');
  fakeClientInstance.emit('ready');
  fakeClientInstance.emit('message_create', {
    id: { _serialized: 'false_905550001122@c.us_ABC' },
    from: '905550001122@c.us',
    to: '908500000000@c.us',
    fromMe: false,
    type: 'chat',
    body: 'Selam',
    _data: { notifyName: 'Ahmet' },
  });
  fakeClientInstance.emit('message_create', {
    id: { _serialized: 'true_905550001122@c.us_DEF' },
    from: '908500000000@c.us',
    to: '905550001122@c.us',
    fromMe: true,
    type: 'chat',
    body: 'Buyurun',
  });
  fakeClientInstance.emit('disconnected', 'LOGOUT');

  // Allow microtasks from async getContact fallback if any
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(qrValue, 'qr-payload');
  assert.equal(readyFired, true);
  assert.equal(disconnectedReason, 'LOGOUT');
  assert.equal(received.length, 2);
  assert.equal(received[0].id, 'false_905550001122@c.us_ABC');
  assert.equal(received[0].fromMe, false);
  assert.equal(received[0].senderName, 'Ahmet');
  assert.equal(received[1].id, 'true_905550001122@c.us_DEF');
  assert.equal(received[1].fromMe, true);

  // sendMessage returns { id } without calling sendSeen
  const sendRes = await adapter.sendMessage('905550001122@c.us', 'Merhaba');
  assert.deepEqual(sendRes, { id: 'true_905550001122@c.us_MSG1' });

  // fetchChatHistory returns normalized messages without calling sendSeen
  const history = await adapter.fetchChatHistory('905550001122@c.us', 15);
  assert.deepEqual(history, [
    { fromMe: false, timestamp: 1700000000, type: 'chat', body: 'Merhaba' },
    { fromMe: true, timestamp: 1700000010, type: 'ptt', duration: 14, body: '' },
    { fromMe: false, timestamp: 1700000020, type: 'document', filename: 'teklif.pdf', body: 'Ektedir' },
  ]);

  // searchContacts searches contacts + chats, ignores groups, dedupes by chatId
  const contacts = await adapter.searchContacts('Eren');
  assert.deepEqual(contacts, [
    { name: 'Eren Sağlayıcı', phone: '905551110001', chatId: '905551110001@c.us' },
    { name: 'Eren Kargo', phone: '905551110002', chatId: '905551110002@c.us' },
  ]);

  // searchContacts also matches normalized Turkish phone numbers
  const byPhone = await adapter.searchContacts('0555 111 0002');
  assert.deepEqual(byPhone, [
    { name: 'Eren Kargo', phone: '905551110002', chatId: '905551110002@c.us' },
  ]);

  // getPage and getChatById expose expected handles without sendSeen
  assert.ok(adapter.getPage());
  assert.equal((await adapter.getChatById('05550001122')).id._serialized, '905550001122@c.us');

  assert.equal(seenCalled, false, 'sendSeen must NEVER be called');
});

test('createWhatsAppClient handles missing chats, @lid resolution, and real host browser detection', async () => {
  class FakeLocalAuth {}
  class FakeClient extends EventEmitter {
    constructor() {
      super();
      this.pupPage = null;
    }
    async initialize() {}
    async destroy() {}
    async getChatById() {
      return null;
    }
    async sendMessage(chatId) {
      return { id: { _serialized: `true_${chatId}_X` } };
    }
    async getContacts() {
      return [];
    }
    async getChats() {
      return [];
    }
  }

  let clientRef = null;
  class CapturingClient extends FakeClient {
    constructor(opts) {
      super(opts);
      clientRef = this;
    }
  }

  const events = [];
  const adapter = createWhatsAppClient(
    {},
    { onMessage: (m) => events.push(m) },
    { Client: CapturingClient, LocalAuth: FakeLocalAuth }
  );

  assert.deepEqual(await adapter.fetchChatHistory('905551234567@c.us', 10), []);
  assert.deepEqual(await adapter.searchContacts('   '), []);
  assert.deepEqual(await adapter.sendMessage('05551234567', 'Test'), {
    id: 'true_905551234567@c.us_X',
  });

  clientRef.emit('message_create', {
    id: { _serialized: 'false_lid_1' },
    from: '12345678901234@lid',
    to: '908500000000@c.us',
    fromMe: false,
    type: 'chat',
    body: 'Merhaba',
    async getContact() {
      return { id: { _serialized: '905559876543@c.us' }, name: 'Ayşe' };
    },
  });

  await new Promise((r) => setTimeout(r, 10));
  assert.equal(events.length, 1);
  assert.equal(events[0].from, '905559876543@c.us');
  assert.equal(events[0].chatId, '905559876543@c.us');
  assert.equal(events[0].senderName, 'Ayşe');

  // Verify auto-detection on this Windows host resolves an existing executable
  const detected = resolveChromeExecutablePath({});
  assert.ok(typeof detected === 'string' && detected.length > 0);
});

test('AudioWorklet registers once per singleton inCtx across calls and uses continuous fractional-phase resampling', async () => {
  const script = getBrowserHookScript();
  const baseEnv = makeMockBrowserEnv();

  const workletNodes = [];
  let addModuleCount = 0;
  let scriptProcCount = 0;
  const blobSources = [];
  const registeredNames = new Set();

  class MockAudioWorkletNode {
    constructor(ctx, name, opts) {
      this.ctx = ctx;
      this.name = name;
      this.options = opts;
      this.port = { onmessage: null };
      this.disconnected = false;
      workletNodes.push(this);
    }
    connect() {}
    disconnect() {
      this.disconnected = true;
    }
  }

  class MockBlob {
    constructor(parts, opts) {
      this.parts = parts;
      this.type = opts?.type || '';
      blobSources.push(parts.join(''));
    }
  }

  const OrigCtx = baseEnv.context.AudioContext;
  let urlCounter = 0;
  const blobUrlToSrc = new Map();
  class WorkletMockAudioContext extends OrigCtx {
    constructor() {
      super();
      this.audioWorklet = {
        addModule: async (url) => {
          addModuleCount += 1;
          const src = blobUrlToSrc.get(url) || '';
          const m = src.match(/registerProcessor\("([^"]+)"/);
          const procName = m ? m[1] : 'wp-jarvis-capture';
          if (registeredNames.has(procName)) {
            throw new Error(`NotSupportedError: processor ${procName} already registered`);
          }
          registeredNames.add(procName);
        },
      };
    }
    createScriptProcessor() {
      scriptProcCount += 1;
      return super.createScriptProcessor();
    }
  }

  baseEnv.context.AudioContext = WorkletMockAudioContext;
  baseEnv.context.AudioWorkletNode = MockAudioWorkletNode;
  baseEnv.context.Blob = MockBlob;
  baseEnv.context.URL = {
    createObjectURL: (blob) => {
      urlCounter += 1;
      const u = `blob:mock-${urlCounter}`;
      blobUrlToSrc.set(u, blob.parts.join(''));
      return u;
    },
    revokeObjectURL: () => {},
  };

  vm.runInContext(script, baseEnv.context);
  const api = baseEnv.context.window.__wpJarvisAudio;
  const pc = new baseEnv.context.window.RTCPeerConnection({});

  // Call #1 track attach
  pc.emit('track', { track: { kind: 'audio', addEventListener() {} }, streams: [{}] });
  await new Promise((r) => setTimeout(r, 10));

  // Call #2 track attach on same singleton inCtx — must NOT re-call addModule or fall back to ScriptProcessor
  pc.emit('track', { track: { kind: 'audio', addEventListener() {} }, streams: [{}] });
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(addModuleCount, 1);
  assert.equal(scriptProcCount, 0);
  assert.equal(workletNodes.length, 2);
  assert.equal(workletNodes[0].options.channelCount, 1);
  assert.equal(workletNodes[0].options.channelCountMode, 'explicit');
  assert.equal(workletNodes[1].options.channelCount, 1);
  assert.equal(workletNodes[1].options.channelCountMode, 'explicit');
  assert.ok(blobSources[0].includes('sum / chCount'), 'worklet processor should average multi-channel inputs');

  // Stream 375 frames of 128 samples at 48kHz (48,000 samples = 1.0s) with monotonic ramp
  api.startIncomingCapture();
  const total48k = 48000;
  let idx = 0;
  for (let f = 0; f < 375; f++) {
    const frame = new Float32Array(128);
    for (let j = 0; j < 128; j++) {
      frame[j] = (idx / total48k) * 0.8;
      idx += 1;
    }
    workletNodes[1].port.onmessage({ data: frame });
  }
  const drained48k = api.drainIncomingPcm();
  assert.equal(drained48k.length, 16000, '375x128 @ 48kHz must produce exact 16,000 samples');
  for (let i = 1; i < drained48k.length; i++) {
    assert.ok(drained48k[i] >= drained48k[i - 1], `non-monotonic jump at ${i}`);
  }

  // Test 44.1kHz -> 16kHz across non-integer chunk seams (300 x 147 = 44,100 samples = 1.0s)
  api.stopIncomingCapture();
  api.resetTelemetry();
  const inCtx = api._debugGetIncomingContexts()[0];
  inCtx.sampleRate = 44100;
  const pc44 = new baseEnv.context.window.RTCPeerConnection({});
  pc44.emit('track', { track: { kind: 'audio', addEventListener() {} }, streams: [{}] });
  await new Promise((r) => setTimeout(r, 10));
  const node44 = workletNodes[2];
  assert.ok(node44, '3rd AudioWorkletNode should attach cleanly at 44.1kHz');

  api.startIncomingCapture();
  const total44k = 44100;
  let k = 0;
  for (let f = 0; f < 300; f++) {
    const frame = new Float32Array(147);
    for (let j = 0; j < 147; j++) {
      frame[j] = (k / total44k) * 0.8;
      k += 1;
    }
    node44.port.onmessage({ data: frame });
  }
  const drained44k = api.drainIncomingPcm();
  assert.equal(drained44k.length, 16000, '300x147 @ 44.1kHz must produce exact 16,000 samples');
  for (let i = 1; i < drained44k.length; i++) {
    assert.ok(drained44k[i] >= drained44k[i - 1], `non-monotonic 44.1kHz jump at ${i}`);
  }
});

test('createWhatsAppClient handles @lid contacts, !fromMe/@lid fallback, fromMe senderName, @newsletter/@broadcast, and auth_failure', async () => {
  class FakeLocalAuth {}
  let clientRef = null;
  let msgContactCalls = 0;

  class MockClient extends EventEmitter {
    constructor() {
      super();
      clientRef = this;
      this.pupPage = null;
    }
    async initialize() {}
    async destroy() {}
    async getContactLidAndPhone(ids) {
      return ids
        .filter((id) => id === '98765432109876@lid' || id === '55500011122233@lid')
        .map((id) =>
          id === '98765432109876@lid'
            ? { lid: id, pn: '905559998877@c.us' }
            : { lid: id, pn: '905554443322@c.us' }
        );
    }
    async getContactById(id) {
      if (id === '905554443322@c.us') {
        return { id: { _serialized: id }, name: 'Müşteri Hedef' };
      }
      return null;
    }
    async getContacts() {
      return [
        {
          id: { _serialized: '12345678901234@lid', user: '12345678901234' },
          number: '12345678901234',
          name: 'Gizli Müşteri',
          isGroup: false,
          isMe: false,
        },
        {
          id: { _serialized: '98765432109876@lid', user: '98765432109876' },
          number: '98765432109876',
          name: 'Çözülen Kişi',
          isGroup: false,
          isMe: false,
        },
      ];
    }
    async getChats() {
      return [
        {
          id: { _serialized: '12345678901234@lid', user: '12345678901234' },
          name: 'Gizli Müşteri',
          isGroup: false,
        },
        {
          id: { _serialized: '98765432109876@lid', user: '98765432109876' },
          name: 'Çözülen Kişi',
          isGroup: false,
        },
      ];
    }
  }

  const messages = [];
  let authFailureMsg = null;
  const adapter = createWhatsAppClient(
    {},
    {
      onMessage: (m) => messages.push(m),
      onAuthFailure: (msg) => { authFailureMsg = msg; },
    },
    { Client: MockClient, LocalAuth: FakeLocalAuth }
  );

  // Unresolved @lid must stay @lid with empty phone, deduped with chats, and NOT match LID digits
  const unresolvedMatches = await adapter.searchContacts('Gizli');
  assert.deepEqual(unresolvedMatches, [
    { name: 'Gizli Müşteri', phone: '', chatId: '12345678901234@lid' },
  ]);
  assert.deepEqual(await adapter.searchContacts('1234567890'), []);

  // Resolved @lid via getContactLidAndPhone maps cleanly to @c.us + normalized phone
  const resolvedMatches = await adapter.searchContacts('Çözülen');
  assert.deepEqual(resolvedMatches, [
    { name: 'Çözülen Kişi', phone: '905559998877', chatId: '905559998877@c.us' },
  ]);

  // auth_failure forwarded
  clientRef.emit('auth_failure', 'BAD_SESSION');
  assert.equal(authFailureMsg, 'BAD_SESSION');

  // !fromMe @lid falls back to getContactLidAndPhone when msg.getContact() returns @lid
  clientRef.emit('message_create', {
    id: { _serialized: 'false_lid_fallback' },
    from: '55500011122233@lid',
    to: '908500000000@c.us',
    fromMe: false,
    type: 'chat',
    body: 'Bilgi alabilir miyim?',
    async getContact() {
      return { id: { _serialized: '55500011122233@lid', server: 'lid' }, number: '55500011122233', pushname: 'Can' };
    },
  });

  // fromMe: true must NOT overwrite senderName with business account's msg.getContact()
  clientRef.emit('message_create', {
    id: { _serialized: 'true_fromme_1' },
    from: '908500000000@c.us',
    to: '905554443322@c.us',
    fromMe: true,
    type: 'chat',
    body: 'Tabii',
    _data: { notifyName: '0850 İşletme' },
    async getContact() {
      return { id: { _serialized: '908500000000@c.us' }, name: '0850 İşletme Profili' };
    },
  });

  // @newsletter and @broadcast flagged without calling msg.getContact()
  clientRef.emit('message_create', {
    id: { _serialized: 'nl_1' },
    from: '120363000111@newsletter',
    to: '908500000000@c.us',
    fromMe: false,
    type: 'chat',
    body: 'Kanal duyurusu',
    async getContact() {
      msgContactCalls += 1;
      return { name: 'Newsletter' };
    },
  });
  clientRef.emit('message_create', {
    id: { _serialized: 'bc_1' },
    from: '905550000000@broadcast',
    to: '908500000000@c.us',
    fromMe: false,
    type: 'chat',
    body: 'Toplu mesaj',
    async getContact() {
      msgContactCalls += 1;
      return { name: 'Broadcast' };
    },
  });

  await new Promise((r) => setTimeout(r, 15));
  assert.equal(messages.length, 4);
  assert.equal(messages[0].from, '905554443322@c.us');
  assert.equal(messages[0].chatId, '905554443322@c.us');
  assert.equal(messages[0].senderName, 'Can');

  assert.equal(messages[1].fromMe, true);
  assert.notEqual(messages[1].senderName, '0850 İşletme Profili');
  assert.notEqual(messages[1].senderName, '0850 İşletme');
  assert.equal(messages[1].senderName, 'Müşteri Hedef');

  assert.equal(messages[2].isNewsletter, true);
  assert.equal(messages[3].isBroadcast, true);
  assert.equal(msgContactCalls, 0);
});

test('spike-webrtc-call DOM inspection scopes timer/status to call container, prefers visible header buttons, and guards lifecycle', async () => {
  function makeEl({ id = '', tag = 'DIV', attrs = {}, innerText = '', rect = { width: 40, height: 40 }, parent = null, matchFn = null } = {}) {
    const el = {
      id,
      tagName: tag,
      attrs,
      innerText,
      parentElement: parent,
      children: [],
      clicked: false,
      getAttribute(k) {
        return this.attrs[k] ?? null;
      },
      getBoundingClientRect() {
        return rect;
      },
      click() {
        this.clicked = true;
      },
      matches(sel) {
        return matchFn ? matchFn(sel, this) : false;
      },
      closest(selList) {
        const parts = selList.split(',').map((s) => s.trim());
        let cur = this;
        while (cur) {
          if (parts.some((p) => cur.matches(p))) return cur;
          cur = cur.parentElement;
        }
        return null;
      },
      querySelector(sel) {
        return this.querySelectorAll(sel)[0] || null;
      },
      querySelectorAll(sel) {
        const out = [];
        const parts = sel.split(',').map((s) => s.trim());
        const walk = (node) => {
          if (node !== this && parts.some((p) => node.matches(p))) out.push(node);
          for (const ch of node.children || []) walk(ch);
        };
        walk(this);
        return out;
      },
    };
    if (parent) parent.children.push(el);
    return el;
  }

  // Case 1: Only main chat pane visible with timestamps and words like "Meşgul", "Cevap yok"
  const rootNoCall = makeEl({ id: 'app', matchFn: (s, e) => s === `#${e.id}` });
  makeEl({
    id: 'main',
    parent: rootNoCall,
    innerText: 'Ahmet\n14:22\nMüşteri: Meşgul misiniz? Cevap yok.\n00:15 gece buluşalım',
    matchFn: (s, e) => s === '#main' || s === `#${e.id}`,
  });
  const fakeDocNoCall = {
    body: { innerText: rootNoCall.children[0].innerText, matches: () => false },
    querySelector: (s) => rootNoCall.querySelector(s),
    querySelectorAll: (s) => rootNoCall.querySelectorAll(s),
  };
  const noCallState = analyzeCallDomFromDocument(HANGUP_SELECTORS, fakeDocNoCall);
  assert.deepEqual(noCallState, {
    hangupPresent: false,
    timerText: null,
    statusHints: [],
    hasCallContainer: false,
  });

  // Case 2: Ringing call dialog overlaid over #main with 14:22 & "Meşgul" in background chat
  const rootRinging = makeEl({ id: 'app', matchFn: (s, e) => s === `#${e.id}` });
  makeEl({
    id: 'main',
    parent: rootRinging,
    innerText: '14:22\nMeşgul\nCevap yok',
    matchFn: (s, e) => s === '#main' || s === `#${e.id}`,
  });
  const callDialog = makeEl({
    attrs: { role: 'dialog' },
    parent: rootRinging,
    innerText: 'Ahmet\nAranıyor...\nBugün 00:05 konuşma\nAramayı sonlandır',
    matchFn: (s, e) => s === '[role="dialog"]' || (s === '[data-icon="call-end"]' && e.attrs['data-icon'] === 'call-end'),
  });
  makeEl({
    attrs: { 'data-icon': 'call-end' },
    parent: callDialog,
    matchFn: (s, e) => s === '[data-icon="call-end"]',
  });
  const fakeDocRinging = {
    body: { innerText: '14:22\nMeşgul', matches: () => false },
    querySelector: (s) => rootRinging.querySelector(s),
    querySelectorAll: (s) => rootRinging.querySelectorAll(s),
  };
  const ringingState = analyzeCallDomFromDocument(HANGUP_SELECTORS, fakeDocRinging);
  assert.equal(ringingState.hangupPresent, true);
  assert.equal(ringingState.timerText, null, 'non-00:XX and inline times must NOT count as connected timer');
  assert.deepEqual(ringingState.statusHints, ['Aranıyor']);

  // Case 3: Call dialog shows standalone ^00:\d{2}$ timer when answered
  callDialog.innerText = 'Ahmet\n00:01\nAramayı sonlandır';
  const connectedState = analyzeCallDomFromDocument(HANGUP_SELECTORS, fakeDocRinging);
  assert.equal(connectedState.hangupPresent, true);
  assert.equal(connectedState.timerText, '00:01');

  // Case 4: selectClickableCandidate prefers visible element inside header over non-header
  const rootBtns = makeEl({ id: 'app', matchFn: () => false });
  const sidebarBtn = makeEl({
    attrs: { 'data-icon': 'audio-call', 'aria-label': 'Sidebar icon' },
    parent: rootBtns,
    matchFn: (s) => s === '[data-icon="audio-call"]',
  });
  const header = makeEl({
    parent: rootBtns,
    matchFn: (s) => s === 'header',
  });
  const headerBtn = makeEl({
    attrs: { 'data-icon': 'audio-call', 'aria-label': 'Header voice call' },
    parent: header,
    matchFn: (s) => s === '[data-icon="audio-call"]',
  });
  const chosen = selectClickableCandidate(AUDIO_CALL_SELECTORS, {
    querySelectorAll: (s) => rootBtns.querySelectorAll(s),
  });
  assert.equal(chosen.ariaLabel, 'Header voice call');
  assert.equal(headerBtn.clicked, false);
  assert.equal(sidebarBtn.clicked, false);

  // Case 5: createSpikeLifecycle guards duplicate ready & exits on pre-ready auth_failure/disconnected
  let readyCalls = 0;
  const aborts = [];
  const lc1 = createSpikeLifecycle({
    onReadyOnce: async () => { readyCalls += 1; },
    onAbort: async (reason) => { aborts.push(reason); },
  });
  await lc1.onReady();
  await lc1.onReady(); // simulated reload ready
  await lc1.onDisconnected('NAVIGATION'); // post-ready disconnect should not trigger pre-ready abort
  assert.equal(readyCalls, 1);
  assert.equal(aborts.length, 0);

  const preAborts = [];
  const lc2 = createSpikeLifecycle({
    onReadyOnce: async () => {},
    onAbort: async (reason) => { preAborts.push(reason); },
  });
  await lc2.onAuthFailure('INVALID_QR');
  assert.equal(preAborts.length, 1);

  const discAborts = [];
  const lc3 = createSpikeLifecycle({
    onReadyOnce: async () => {},
    onAbort: async (reason) => { discAborts.push(reason); },
  });
  await lc3.onDisconnected('CONFLICT');
  assert.equal(discAborts.length, 1);

  // Case 6: analyzeCallDomFromDocument must step outside hangup button when button itself carries aria-label matching arama/call
  const realisticMatch = (sel, el) => {
    if (sel === 'button') return el.tagName === 'BUTTON';
    if (sel === '[role="button"]') return el.attrs.role === 'button';
    if (sel === '[role="dialog"]') return el.attrs.role === 'dialog';
    if (sel === '[data-icon="call-end"]') return el.attrs['data-icon'] === 'call-end';
    if (sel === '[data-testid*="call" i]') return String(el.attrs['data-testid'] || '').toLowerCase().includes('call');
    if (sel === '[aria-label*="arama" i]') return String(el.attrs['aria-label'] || '').toLowerCase().includes('arama');
    if (sel === '[aria-label*="call" i]') return String(el.attrs['aria-label'] || '').toLowerCase().includes('call');
    if (sel === '[aria-label*="Aramayı sonlandır" i]') return String(el.attrs['aria-label'] || '').toLowerCase().includes('aramayı sonlandır');
    if (sel === '[aria-label*="End call" i]') return String(el.attrs['aria-label'] || '').toLowerCase().includes('end call');
    if (sel === '#main' || sel === '#app') return `#${el.id}` === sel;
    return false;
  };

  // 6a: <button aria-label="Aramayı sonlandır"> inside <div role="dialog">
  const rootBtnHangup = makeEl({ id: 'app', matchFn: realisticMatch });
  const dialogBtnHangup = makeEl({
    attrs: { role: 'dialog' },
    parent: rootBtnHangup,
    innerText: 'Ahmet\nAranıyor...\n00:05\nAramayı sonlandır',
    matchFn: realisticMatch,
  });
  makeEl({
    tag: 'BUTTON',
    attrs: { 'aria-label': 'Aramayı sonlandır' },
    parent: dialogBtnHangup,
    innerText: 'Aramayı sonlandır',
    matchFn: realisticMatch,
  });
  const docBtnHangup = {
    body: { innerText: '14:22\nMeşgul', matches: () => false },
    querySelector: (s) => rootBtnHangup.querySelector(s),
    querySelectorAll: (s) => rootBtnHangup.querySelectorAll(s),
  };
  const btnHangupRingingState = analyzeCallDomFromDocument(HANGUP_SELECTORS, docBtnHangup);
  assert.equal(btnHangupRingingState.hangupPresent, true);
  assert.equal(btnHangupRingingState.timerText, null, 'fallback timer suppressed while ringing');
  assert.deepEqual(btnHangupRingingState.statusHints, ['Aranıyor']);
  dialogBtnHangup.innerText = 'Ahmet\n00:05\nAramayı sonlandır';
  const btnHangupState = analyzeCallDomFromDocument(HANGUP_SELECTORS, docBtnHangup);
  assert.equal(btnHangupState.hangupPresent, true);
  assert.equal(btnHangupState.timerText, '00:05');

  // 6b: Nested <span data-icon="call-end"> inside <button aria-label="End call"> inside intermediate controls wrapper inside [role="dialog"]
  const rootNested = makeEl({ id: 'app', matchFn: realisticMatch });
  const dialogNested = makeEl({
    attrs: { role: 'dialog' },
    parent: rootNested,
    innerText: 'Ahmet\nRinging\n00:05\nEnd call',
    matchFn: realisticMatch,
  });
  const controlsWrapper = makeEl({
    attrs: { 'aria-label': 'Call controls' },
    parent: dialogNested,
    innerText: 'End call',
    matchFn: realisticMatch,
  });
  const endCallBtn = makeEl({
    tag: 'BUTTON',
    attrs: { 'aria-label': 'End call' },
    parent: controlsWrapper,
    innerText: 'End call',
    matchFn: realisticMatch,
  });
  makeEl({
    tag: 'SPAN',
    attrs: { 'data-icon': 'call-end' },
    parent: endCallBtn,
    innerText: '',
    matchFn: realisticMatch,
  });
  const docNested = {
    body: { innerText: '14:22', matches: () => false },
    querySelector: (s) => rootNested.querySelector(s),
    querySelectorAll: (s) => rootNested.querySelectorAll(s),
  };
  const nestedRingingState = analyzeCallDomFromDocument(HANGUP_SELECTORS, docNested);
  assert.equal(nestedRingingState.hangupPresent, true);
  assert.equal(nestedRingingState.timerText, null);
  assert.deepEqual(nestedRingingState.statusHints, ['Ringing']);
  dialogNested.innerText = 'Ahmet\n00:05\nEnd call';
  const nestedState = analyzeCallDomFromDocument(HANGUP_SELECTORS, docNested);
  assert.equal(nestedState.hangupPresent, true);
  assert.equal(nestedState.timerText, '00:05');

  // 6c: <div role="button" aria-label="End call"> inside an unnamed call overlay card (no role="dialog")
  const rootRoleBtn = makeEl({ id: 'app', matchFn: realisticMatch });
  const cardOverlay = makeEl({
    parent: rootRoleBtn,
    innerText: 'Ahmet\nAranıyor\n00:05\nEnd call',
    matchFn: realisticMatch,
  });
  const roleBtn = makeEl({
    attrs: { role: 'button', 'aria-label': 'End call' },
    parent: cardOverlay,
    innerText: 'End call',
    matchFn: realisticMatch,
  });
  makeEl({
    tag: 'SPAN',
    attrs: { 'data-icon': 'call-end' },
    parent: roleBtn,
    innerText: '',
    matchFn: realisticMatch,
  });
  const docRoleBtn = {
    body: { innerText: '14:22', matches: () => false },
    querySelector: (s) => rootRoleBtn.querySelector(s),
    querySelectorAll: (s) => rootRoleBtn.querySelectorAll(s),
  };
  const roleBtnRingingState = analyzeCallDomFromDocument(HANGUP_SELECTORS, docRoleBtn);
  assert.equal(roleBtnRingingState.hangupPresent, true);
  assert.equal(roleBtnRingingState.timerText, null);
  assert.deepEqual(roleBtnRingingState.statusHints, ['Aranıyor']);
  cardOverlay.innerText = 'Ahmet\n00:05\nEnd call';
  const roleBtnState = analyzeCallDomFromDocument(HANGUP_SELECTORS, docRoleBtn);
  assert.equal(roleBtnState.hangupPresent, true);
  assert.equal(roleBtnState.timerText, '00:05');
});

test('createWhatsAppClient preserves native browser UA (userAgent: false) and retries mainFrame startup race', async () => {
  let capturedOptions = null;
  let initAttempts = 0;
  let destroyCount = 0;

  class FlakyClient extends EventEmitter {
    constructor(opts) {
      super();
      capturedOptions = opts;
      this.pupPage = {
        evaluateOnNewDocument: async () => {},
        evaluate: async () => true,
      };
    }
    async initialize() {
      initAttempts += 1;
      if (initAttempts === 1) {
        throw new Error('Requesting main frame too early!');
      }
    }
    async destroy() {
      destroyCount += 1;
    }
  }

  class DummyAuth {}

  const adapter = createWhatsAppClient(
    { ownerPhone: '905321112233' },
    {},
    { Client: FlakyClient, LocalAuth: DummyAuth, resolveChrome: () => 'C:\\Edge\\msedge.exe' }
  );

  assert.equal(capturedOptions.userAgent, false);
  await adapter.initialize();
  assert.equal(initAttempts, 2);
  assert.equal(destroyCount, 1);
});

test('analyzeCallDomFromDocument supports real WhatsApp Web voip-container-audio-call sibling toolbar and 0:XX timer', () => {
  const makeNode = ({ tag = 'DIV', attrs = {}, innerText = '', parent = null } = {}) => {
    const el = {
      tagName: tag,
      attrs,
      innerText,
      parentElement: parent,
      children: [],
      getAttribute(k) {
        return this.attrs[k] ?? null;
      },
      getBoundingClientRect() {
        return { width: 100, height: 32 };
      },
      matches(selList) {
        return selList.split(',').some((raw) => {
          const s = raw.trim();
          if (s === '[data-testid*="voip-container" i]') {
            return String(this.attrs['data-testid'] || '').toLowerCase().includes('voip-container');
          }
          if (s === '[data-testid="voip-call-timer"]') {
            return this.attrs['data-testid'] === 'voip-call-timer';
          }
          if (s === '[role="timer"]') {
            return this.attrs.role === 'timer';
          }
          if (s === '[data-testid*="call" i]') {
            return String(this.attrs['data-testid'] || '').toLowerCase().includes('call');
          }
          if (s === '[aria-label*="Aramayı bitir" i]') {
            return String(this.attrs['aria-label'] || '').toLowerCase().includes('aramayı bitir');
          }
          if (s === '[aria-label*="arama" i]') {
            return String(this.attrs['aria-label'] || '').toLowerCase().includes('arama');
          }
          return false;
        });
      },
      closest(selList) {
        const parts = selList.split(',').map((p) => p.trim());
        let cur = this;
        while (cur) {
          if (parts.some((p) => cur.matches(p))) return cur;
          cur = cur.parentElement;
        }
        return null;
      },
      querySelector(sel) {
        return this.querySelectorAll(sel)[0] || null;
      },
      querySelectorAll(sel) {
        const out = [];
        const walk = (n) => {
          if (n !== this && n.matches(sel)) out.push(n);
          for (const ch of n.children) walk(ch);
        };
        walk(this);
        return out;
      },
    };
    if (parent) parent.children.push(el);
    return el;
  };

  const root = makeNode({ attrs: { id: 'app' } });
  const pipCard = makeNode({ parent: root, innerText: '' });
  const voipCard = makeNode({
    parent: pipCard,
    attrs: { 'data-testid': 'voip-container-audio-call' },
    innerText: 'İşletme Sahibi\nÇalıyor...',
  });
  const toolbar = makeNode({
    parent: pipCard,
    attrs: { role: 'toolbar', 'aria-label': 'Arama kontrolleri' },
    innerText: '',
  });
  makeNode({
    tag: 'BUTTON',
    parent: toolbar,
    attrs: { 'aria-label': 'Aramayı bitir' },
    innerText: '',
  });

  const doc = {
    body: { innerText: '14:22', matches: () => false },
    querySelector: (s) => root.querySelector(s),
    querySelectorAll: (s) => root.querySelectorAll(s),
  };

  const ringing = analyzeCallDomFromDocument(HANGUP_SELECTORS, doc);
  assert.equal(ringing.hangupPresent, true);
  assert.equal(ringing.timerText, null);
  assert.deepEqual(ringing.statusHints, ['Çalıyor']);

  voipCard.innerText = 'İşletme Sahibi\n0:00';
  makeNode({
    parent: voipCard,
    attrs: { role: 'timer', 'data-testid': 'voip-call-timer' },
    innerText: '0:00',
  });
  const answeredAtZero = analyzeCallDomFromDocument(HANGUP_SELECTORS, doc);
  assert.equal(answeredAtZero.hangupPresent, true);
  assert.equal(answeredAtZero.timerText, '0:00');
});

test('injected-hook captures non-WebRTC AudioWorklet playback routed via AudioNode.connect -> destination', async () => {
  const vm = await import('node:vm');
  class FakeDestinationNode {}
  class FakeAudioNode {
    constructor(ctx) {
      this.context = ctx;
      this.connectedTo = [];
    }
    connect(dest) {
      this.connectedTo.push(dest);
      return dest;
    }
    disconnect() {}
  }
  class FakePlaybackWorkletNode extends FakeAudioNode {}

  let capturedProcessor = null;
  class FakeAudioContext {
    constructor(opts = {}) {
      this.sampleRate = opts.sampleRate || 16000;
      this.state = 'running';
      this.destination = new FakeDestinationNode();
      this.audioWorklet = null; // trigger ScriptProcessor fallback synchronously
    }
    createGain() {
      const n = new FakeAudioNode(this);
      n.gain = { value: 1 };
      return n;
    }
    createConstantSource() {
      const n = new FakeAudioNode(this);
      n.offset = { value: 0 };
      n.start = () => {};
      return n;
    }
    createBufferSource() {
      const n = new FakeAudioNode(this);
      n.start = () => {};
      return n;
    }
    createMediaStreamDestination() {
      return { stream: { id: 's', getAudioTracks: () => [] } };
    }
    createScriptProcessor() {
      const n = new FakeAudioNode(this);
      n.onaudioprocess = null;
      capturedProcessor = n;
      return n;
    }
    resume() {
      return Promise.resolve();
    }
  }

  const fakeWindow = {
    AudioContext: FakeAudioContext,
    AudioNode: FakeAudioNode,
    AudioDestinationNode: FakeDestinationNode,
    RTCPeerConnection: undefined,
  };
  const context = {
    window: fakeWindow,
    navigator: {},
    setTimeout,
    clearTimeout,
    Float32Array,
    Int16Array,
    Uint8Array,
    ArrayBuffer,
    Math,
    Date,
    Number,
    String,
    Boolean,
    Array,
    Promise,
    Set,
  };
  fakeWindow.window = fakeWindow;

  const script = getBrowserHookScript();
  vm.runInNewContext(script, context);

  const waCtx = new FakeAudioContext({ sampleRate: 16000 });
  const playbackNode = new FakePlaybackWorkletNode(waCtx);
  playbackNode.connect(waCtx.destination);

  assert.ok(capturedProcessor, 'ScriptProcessor capture should attach when playback node connects to destination');
  assert.equal(capturedProcessor.__wpJarvisInternal, true);
  assert.equal(playbackNode.connectedTo.filter((d) => d === capturedProcessor).length, 1);

  // Connecting a second time or connecting internal zeroGain must not duplicate or recurse
  playbackNode.connect(waCtx.destination);
  assert.equal(playbackNode.connectedTo.filter((d) => d === capturedProcessor).length, 1);

  fakeWindow.__wpJarvisAudio.startIncomingCapture();
  const frame = new Float32Array(512);
  frame[0] = 0.5;
  frame[1] = -0.5;
  capturedProcessor.onaudioprocess({
    inputBuffer: { getChannelData: () => frame },
  });

  const drained = fakeWindow.__wpJarvisAudio.drainIncomingPcm();
  assert.equal(drained.length, 512);
  assert.ok(drained[0] > 16000);
  assert.ok(drained[1] < -16000);
});

test('createWhatsAppClient observes WAWebCallCollection activeCall, resolves @lid caller, deduplicates, and ignores outgoing calls', async () => {
  class FakeLocalAuth {}
  const waCallListeners = new Map();
  const fakeWaCallCol = {
    activeCall: null,
    on(evt, fn) {
      if (!waCallListeners.has(evt)) waCallListeners.set(evt, []);
      waCallListeners.get(evt).push(fn);
    },
    emit(evt, ...args) {
      for (const fn of waCallListeners.get(evt) || []) fn(...args);
    },
  };

  const vmContext = {
    window: null,
    require: (name) => (name === 'WAWebCallCollection' ? fakeWaCallCol : null),
    String,
    Boolean,
    Object,
  };
  vmContext.window = vmContext;
  vm.createContext(vmContext);

  const mockPage = {
    async evaluateOnNewDocument() {},
    async exposeFunction(name, fn) {
      if (vmContext[name]) {
        throw new Error(`window['${name}'] already exists!`);
      }
      vmContext[name] = fn;
    },
    async evaluate(fn, ...args) {
      if (typeof fn === 'string') return vm.runInContext(fn, vmContext);
      vmContext.__args = args;
      const src = fn.toString();
      const expr = /^\s*(async\s+)?function\b|^\s*(async\s+)?\(/.test(src) ? `(${src})` : `(function ${src})`;
      return vm.runInContext(`${expr}.apply(null, __args)`, vmContext);
    },
  };

  let clientRef = null;
  class FakeClient extends EventEmitter {
    constructor() {
      super();
      this.pupPage = mockPage;
      clientRef = this;
    }
    async initialize() {}
    async destroy() {}
    async getContactLidAndPhone(ids) {
      return ids.map((lid) =>
        lid === '777888999@lid'
          ? { lid, pn: '905550000100@c.us' }
          : { lid, pn: '' }
      );
    }
    async getContactById(id) {
      return id === '777888999@lid' || id === '905550000100@c.us'
        ? { name: 'İşletme Sahibi', pushname: 'Sahip' }
        : null;
    }
    async getContacts() {
      return [];
    }
    async getChats() {
      return [];
    }
  }

  const incomingCalls = [];
  const endedCalls = [];
  const adapter = createWhatsAppClient(
    {},
    {
      onIncomingCall: (c) => incomingCalls.push(c),
      onIncomingCallEnded: (id) => endedCalls.push(id),
    },
    { Client: FakeClient, LocalAuth: FakeLocalAuth }
  );

  await adapter.initialize();
  clientRef.emit('ready');
  await new Promise((r) => setTimeout(r, 15));

  // Outgoing call must NOT emit onIncomingCall
  fakeWaCallCol.activeCall = {
    attributes: {
      id: 'out-call-1',
      peerJid: '777888999@lid',
      outgoing: true,
      isVideo: false,
      isGroup: false,
    },
  };
  fakeWaCallCol.emit('change:activeCall', fakeWaCallCol.activeCall);
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(incomingCalls.length, 0);

  // Incoming call from @lid must resolve to owner phone + dedupe against whatsapp-web.js 'call' event
  const activeIncoming = {
    attributes: {
      id: 'in-call-1',
      peerJid: '777888999:0@lid',
      outgoing: false,
      isVideo: false,
      isGroup: false,
    },
  };
  fakeWaCallCol.activeCall = activeIncoming;
  fakeWaCallCol.emit('change:activeCall', activeIncoming);
  clientRef.emit('call', {
    id: 'in-call-1',
    from: '777888999@lid',
    fromMe: false,
    isVideo: false,
    isGroup: false,
  });

  await new Promise((r) => setTimeout(r, 25));
  assert.equal(incomingCalls.length, 1, 'duplicate call event for same call id must fire once');
  assert.equal(incomingCalls[0].id, 'in-call-1');
  assert.equal(incomingCalls[0].from, '905550000100@c.us');
  assert.equal(incomingCalls[0].phone, '905550000100');
  assert.equal(incomingCalls[0].senderName, 'İşletme Sahibi');
  assert.equal(incomingCalls[0].outgoing, false);

  fakeWaCallCol.activeCall = null;
  fakeWaCallCol.emit('change:activeCall', null);
  await new Promise((r) => setTimeout(r, 15));
  assert.deepEqual(endedCalls, ['in-call-1']);
});

test('incoming @lid call resolves via reverse ownerChatId lookup and leaves stranger @lid unresolved', async () => {
  const receivedCalls = [];

  class FakeLocalAuth {}
  class CapturingClient extends EventEmitter {
    async initialize() {}
    async destroy() {}
    async getContactLidAndPhone(ids) {
      const target = ids[0];
      if (target === '905550000100@c.us') {
        return [{ lid: '999888777@lid', pn: '905550000100@c.us' }];
      }
      return [{ lid: target, pn: '' }];
    }
    async getContactById(id) {
      if (id === '999888777@lid') {
        return { id: { _serialized: '999888777@lid' }, name: 'İşletme Sahibi' };
      }
      return null;
    }
  }

  let fakeClientInstance;
  class WrappedClient extends CapturingClient {
    constructor(opts) {
      super(opts);
      fakeClientInstance = this;
    }
  }

  const wrapper = createWhatsAppClient(
    { ownerChatId: '905550000100@c.us', ownerPhone: '905550000100' },
    {
      onIncomingCall: (call) => receivedCalls.push(call),
    },
    {
      Client: WrappedClient,
      LocalAuth: FakeLocalAuth,
    }
  );

  await wrapper.initialize();

  fakeClientInstance.emit('call', {
    id: 'rev-owner-call',
    from: '999888777:0@lid',
    isVideo: false,
    isGroup: false,
    fromMe: false,
  });

  fakeClientInstance.emit('call', {
    id: 'rev-stranger-call',
    from: '111222333@lid',
    isVideo: false,
    isGroup: false,
    fromMe: false,
  });

  await new Promise((r) => setTimeout(r, 20));

  assert.equal(receivedCalls.length, 2);
  assert.equal(receivedCalls[0].id, 'rev-owner-call');
  assert.equal(receivedCalls[0].from, '905550000100@c.us');
  assert.equal(receivedCalls[0].phone, '905550000100');
  assert.equal(receivedCalls[0].senderName, 'İşletme Sahibi');

  assert.equal(receivedCalls[1].id, 'rev-stranger-call');
  assert.equal(receivedCalls[1].from, '111222333@lid');
  assert.equal(receivedCalls[1].phone, '');
});

test('createWhatsAppClient listRecentChats returns sorted 1:1 chats with resolved @lid JIDs without calling sendSeen', async () => {
  class FakeLocalAuth {}
  let sendSeenCalls = 0;

  class FakeClient extends EventEmitter {
    constructor() {
      super();
      this.pupPage = null;
    }
    async initialize() {}
    async destroy() {}
    async sendSeen() {
      sendSeenCalls += 1;
    }
    async getContactLidAndPhone(ids) {
      return ids.map((lid) =>
        lid === '111222333@lid' ? { lid, pn: '905559998877@c.us' } : { lid, pn: '' }
      );
    }
    async getChats() {
      return [
        {
          id: { _serialized: '1203630000@g.us' },
          isGroup: true,
          name: 'Aile Grubu',
          unreadCount: 5,
          timestamp: 9999,
          lastMessage: { body: 'Selam', type: 'chat', timestamp: 9999, fromMe: false },
          async sendSeen() {
            sendSeenCalls += 1;
          },
        },
        {
          id: { _serialized: '905551110001@c.us' },
          isGroup: false,
          name: 'Ahmet',
          unreadCount: 0,
          timestamp: 1000,
          lastMessage: { body: 'Tamamdır', type: 'chat', timestamp: 1000, fromMe: true },
        },
        {
          id: { _serialized: '111222333@lid' },
          isGroup: false,
          name: 'Zeynep @lid',
          unreadCount: 2,
          timestamp: 2000,
          lastMessage: { body: '', type: 'ptt', duration: 9, timestamp: 2000, fromMe: false },
        },
      ];
    }
  }

  const adapter = createWhatsAppClient({}, {}, { Client: FakeClient, LocalAuth: FakeLocalAuth });
  const recent = await adapter.listRecentChats(10);

  assert.equal(sendSeenCalls, 0);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].chatId, '905559998877@c.us');
  assert.equal(recent[0].phone, '905559998877');
  assert.equal(recent[0].unreadCount, 2);
  assert.equal(recent[0].lastMessage.type, 'ptt');
  assert.equal(recent[0].lastMessage.duration, 9);
  assert.equal(recent[1].chatId, '905551110001@c.us');
});

test('normalizeIncomingMessage resolves owner @lid via reverse ownerChatId lookup and populates phone', async () => {
  const receivedMessages = [];
  class FakeLocalAuth {}

  class FakeClient extends EventEmitter {
    async initialize() {}
    async destroy() {}
    async getContactLidAndPhone(ids) {
      const target = ids[0];
      if (target === '905550000100@c.us') {
        return [{ lid: '999888777@lid', pn: '905550000100@c.us' }];
      }
      return [{ lid: target, pn: '' }];
    }
    async getContactById(id) {
      if (id === '999888777@lid') {
        return { id: { _serialized: '999888777@lid' }, pushname: 'İşletme Sahibi' };
      }
      if (id === '905551234567@c.us') {
        return { id: { _serialized: '905551234567@c.us' }, name: 'Müşteri Ali' };
      }
      return null;
    }
  }

  let fakeClient;
  class WrappedClient extends FakeClient {
    constructor(opts) {
      super(opts);
      fakeClient = this;
    }
  }

  createWhatsAppClient(
    { ownerChatId: '905550000100@c.us', ownerPhone: '905550000100' },
    { onMessage: (m) => receivedMessages.push(m) },
    { Client: WrappedClient, LocalAuth: FakeLocalAuth }
  );

  // 1. Owner personal phone arriving as unresolved @lid -> resolved via reverse ownerChatId lookup
  fakeClient.emit('message_create', {
    id: { _serialized: 'msg-owner-lid' },
    from: '999888777:0@lid',
    to: '908500001122@c.us',
    fromMe: false,
    type: 'chat',
    body: 'Bu ay kaç müşteri geldi?',
    timestamp: 1700000100,
  });

  // 2. Normal customer @c.us message -> phone populated
  fakeClient.emit('message_create', {
    id: { _serialized: 'msg-cust-1' },
    from: '905551234567@c.us',
    to: '908500001122@c.us',
    fromMe: false,
    type: 'chat',
    body: 'Fiyat nedir?',
    timestamp: 1700000101,
  });

  // 3. Unknown unresolved stranger @lid -> stays @lid, phone is empty string
  fakeClient.emit('message_create', {
    id: { _serialized: 'msg-stranger-lid' },
    from: '111222333@lid',
    to: '908500001122@c.us',
    fromMe: false,
    type: 'chat',
    body: 'Merhaba',
    timestamp: 1700000102,
  });

  await new Promise((r) => setTimeout(r, 25));
  assert.equal(receivedMessages.length, 3);
  assert.equal(receivedMessages[0].from, '905550000100@c.us');
  assert.equal(receivedMessages[0].phone, '905550000100');
  assert.equal(receivedMessages[1].from, '905551234567@c.us');
  assert.equal(receivedMessages[1].phone, '905551234567');
  assert.equal(receivedMessages[2].from, '111222333@lid');
  assert.equal(receivedMessages[2].phone, '');
});

test('scanCustomerChats pre-filters stale chats, handles yesterday returning customer, excludes suppliers & outbound-only, never calls sendSeen', async () => {
  class FakeLocalAuth {}
  let sendSeenCalls = 0;
  const fetchCalls = [];

  const yStart = Date.UTC(2026, 10, 12, 0, 0, 0);
  const yEnd = Date.UTC(2026, 10, 13, 0, 0, 0);
  const todayTs = Date.UTC(2026, 10, 13, 10, 0, 0);
  const nowMs = Date.UTC(2026, 10, 13, 12, 0, 0);

  const mockChats = [
    // Owner chat -> excluded
    {
      id: { _serialized: '905321112233@c.us' },
      isGroup: false,
      name: 'Owner',
      timestamp: Math.floor(todayTs / 1000),
      async sendSeen() { sendSeenCalls += 1; },
      async fetchMessages() {
        fetchCalls.push('905321112233@c.us');
        return [{ fromMe: false, timestamp: Math.floor((yStart + 3600_000) / 1000), body: 'durum' }];
      },
    },
    // Old customer (last message 3 days before yesterday) -> MUST NOT call fetchMessages
    {
      id: { _serialized: '905550000001@c.us' },
      isGroup: false,
      name: 'Eski Müşteri',
      timestamp: Math.floor((yStart - 3 * 86400_000) / 1000),
      async sendSeen() { sendSeenCalls += 1; },
      async fetchMessages() {
        fetchCalls.push('905550000001@c.us');
        return [];
      },
    },
    // Returning customer who messaged BOTH yesterday AND today (lastActivity=today >= yStart) -> MUST count in yesterday!
    {
      id: { _serialized: '905550000002@c.us' },
      isGroup: false,
      name: 'Tekrar Eden Müşteri',
      timestamp: Math.floor(todayTs / 1000),
      async sendSeen() { sendSeenCalls += 1; },
      async fetchMessages() {
        fetchCalls.push('905550000002@c.us');
        return [
          { fromMe: false, timestamp: Math.floor((yStart - 86400_000) / 1000), body: 'Geçen hafta sormuştum' },
          { fromMe: false, timestamp: Math.floor((yStart + 5 * 3600_000) / 1000), body: 'Dünkü mesaj' },
          { fromMe: false, timestamp: Math.floor(todayTs / 1000), body: 'Bugünkü mesaj' },
        ];
      },
    },
    // New customer yesterday only
    {
      id: { _serialized: '905550000003@c.us' },
      isGroup: false,
      name: 'Yeni Müşteri',
      timestamp: Math.floor((yStart + 7 * 3600_000) / 1000),
      async sendSeen() { sendSeenCalls += 1; },
      async fetchMessages() {
        fetchCalls.push('905550000003@c.us');
        return [
          { fromMe: false, timestamp: Math.floor((yStart + 7 * 3600_000) / 1000), body: 'Merhaba fiyat?' },
        ];
      },
    },
    // Outbound-only chat yesterday (fromMe: true only) -> excluded
    {
      id: { _serialized: '905550000004@c.us' },
      isGroup: false,
      name: 'Sadece Giden',
      timestamp: Math.floor((yStart + 8 * 3600_000) / 1000),
      async sendSeen() { sendSeenCalls += 1; },
      async fetchMessages() {
        fetchCalls.push('905550000004@c.us');
        return [
          { fromMe: true, timestamp: Math.floor((yStart + 8 * 3600_000) / 1000), body: 'Biz yazdık' },
        ];
      },
    },
    // Active supplier (thirdPartyOutreachUntil > nowMs) -> excluded
    {
      id: { _serialized: '905550000005@c.us' },
      isGroup: false,
      name: 'Eren Sağlayıcı',
      timestamp: Math.floor((yStart + 9 * 3600_000) / 1000),
      async sendSeen() { sendSeenCalls += 1; },
      async fetchMessages() {
        fetchCalls.push('905550000005@c.us');
        return [
          { fromMe: false, timestamp: Math.floor((yStart + 9 * 3600_000) / 1000), body: 'Tamam usta' },
        ];
      },
    },
  ];

  class FakeClient extends EventEmitter {
    async initialize() {}
    async destroy() {}
    async getChats() {
      return mockChats;
    }
  }

  const fakeStore = {
    getChatState(chatId) {
      if (chatId === '905550000005@c.us') {
        return { thirdPartyOutreachUntil: nowMs + 10 * 3600_000 };
      }
      return {};
    },
  };

  const adapter = createWhatsAppClient(
    { ownerChatId: '905321112233@c.us', ownerPhone: '905321112233' },
    {},
    { Client: FakeClient, LocalAuth: FakeLocalAuth }
  );

  const scanRes = await adapter.scanCustomerChats({
    rangeStartMs: yStart,
    rangeEndMs: yEnd,
    nowMs,
    store: fakeStore,
  });

  assert.equal(sendSeenCalls, 0);
  // Pre-filter skipped owner, stale customer, and supplier without calling fetchMessages on them!
  assert.equal(fetchCalls.includes('905550000001@c.us'), false);
  assert.equal(fetchCalls.includes('905321112233@c.us'), false);
  assert.equal(fetchCalls.includes('905550000005@c.us'), false);

  assert.equal(scanRes.customers.length, 2);
  const returning = scanRes.customers.find((c) => c.chatId === '905550000002@c.us');
  const brandNew = scanRes.customers.find((c) => c.chatId === '905550000003@c.us');
  assert.ok(returning);
  assert.equal(returning.isNew, false);
  assert.equal(returning.messageCountInRange, 1);
  assert.ok(brandNew);
  assert.equal(brandNew.isNew, true);
  assert.equal(brandNew.messageCountInRange, 1);
});

test('review fixes: listRecentChats emits timestampIso (+03:00) and scanCustomerChats marks history-capped chats isNew=null & splits exclusion counts', async () => {
  const istMay15NoonSec = Math.floor(Date.UTC(2026, 4, 15, 9, 0, 0) / 1000);
  const rangeStartMs = Date.UTC(2026, 4, 1, 0, 0, 0) - 3 * 3600_000;
  const rangeEndMs = Date.UTC(2026, 5, 1, 0, 0, 0) - 3 * 3600_000;
  const nowMs = Date.UTC(2026, 4, 15, 12, 0, 0);

  const mockChats = [
    // 1:1 customer whose fetched messages hit historyLimit=3 (unknown if earlier messages exist)
    {
      id: { _serialized: '905551110010@c.us' },
      name: 'Kalabalik Musteri',
      isGroup: false,
      unreadCount: 0,
      timestamp: istMay15NoonSec,
      lastMessage: { body: 'Son mesaj', timestamp: istMay15NoonSec, fromMe: false },
      async fetchMessages() {
        return [
          { fromMe: false, timestamp: istMay15NoonSec, body: 'm1' },
          { fromMe: true, timestamp: istMay15NoonSec - 10, body: 'm2' },
          { fromMe: false, timestamp: istMay15NoonSec - 20, body: 'm3' },
        ];
      },
    },
    // Active third-party supplier excluded before fetchMessages
    {
      id: { _serialized: '905551110020@c.us' },
      name: 'Aktif Tedarikci',
      isGroup: false,
      unreadCount: 0,
      timestamp: istMay15NoonSec - 100,
      lastMessage: { body: 'Tamam', timestamp: istMay15NoonSec - 100, fromMe: false },
      async fetchMessages() {
        throw new Error('third-party should be excluded before fetchMessages');
      },
    },
    // Outbound-only customer in range
    {
      id: { _serialized: '905551110030@c.us' },
      name: 'Sadece Giden',
      isGroup: false,
      unreadCount: 0,
      timestamp: istMay15NoonSec - 200,
      lastMessage: { body: 'Biz yazdik', timestamp: istMay15NoonSec - 200, fromMe: true },
      async fetchMessages() {
        return [{ fromMe: true, timestamp: istMay15NoonSec - 200, body: 'Biz yazdik' }];
      },
    },
  ];

  class LocalFakeAuth {}
  class LocalFakeClient {
    on() {}
    async getChats() {
      return mockChats;
    }
    async getContactById(id) {
      return { id: { _serialized: id }, number: id.split('@')[0], pushname: '' };
    }
    async getChatById(id) {
      return mockChats.find((c) => c.id._serialized === id) || null;
    }
  }

  const fakeStore = {
    getChatState(chatId) {
      if (chatId === '905551110020@c.us') {
        return { thirdPartyOutreachUntil: nowMs + 3600_000 };
      }
      return {};
    },
  };

  const adapter = createWhatsAppClient(
    { ownerChatId: '905321112233@c.us', ownerPhone: '905321112233' },
    {},
    { Client: LocalFakeClient, LocalAuth: LocalFakeAuth }
  );

  const recent = await adapter.listRecentChats(10);
  assert.equal(recent.length, 3);
  assert.equal(recent[0].timestampIso, '2026-05-15T12:00:00.000+03:00');

  const scanRes = await adapter.scanCustomerChats({
    rangeStartMs,
    rangeEndMs,
    nowMs,
    store: fakeStore,
    historyLimit: 3,
  });

  assert.equal(scanRes.customers.length, 1);
  assert.equal(scanRes.customers[0].chatId, '905551110010@c.us');
  assert.equal(scanRes.customers[0].isNew, null);
  assert.equal(scanRes.customers[0].messageCountInRange, 2);
  assert.equal(scanRes.excludedThirdPartyCount, 1);
  assert.equal(scanRes.excludedOutboundOnlyCount, 1);
});

test('client deduplicates @lid + @c.us chats in listRecentChats and scanCustomerChats, resolves owner @lid once, falls back to getChatById, and deduplicates hookRegisteredPages', async () => {
  const nowSec = Math.floor(Date.UTC(2026, 4, 15, 9, 0, 0) / 1000);
  const nowMs = nowSec * 1000;
  const rangeStartMs = nowMs - 86400_000;
  const rangeEndMs = nowMs + 86400_000;

  let evalOnNewDocCalls = 0;
  let ownerLidLookups = 0;
  const waCallListeners = new Map();
  const fakeWaCallCol = {
    activeCall: null,
    on(evt, fn) {
      if (!waCallListeners.has(evt)) waCallListeners.set(evt, []);
      waCallListeners.get(evt).push(fn);
    },
    emit(evt, ...args) {
      for (const fn of waCallListeners.get(evt) || []) fn(...args);
    },
  };

  const vmContext = {
    window: null,
    require: (name) => (name === 'WAWebCallCollection' ? fakeWaCallCol : null),
    String,
    Boolean,
    Object,
  };
  vmContext.window = vmContext;
  vm.createContext(vmContext);

  const mockPage = {
    async evaluateOnNewDocument() {
      evalOnNewDocCalls += 1;
    },
    async exposeFunction(name, fn) {
      vmContext[name] = fn;
    },
    async evaluate(fn, ...args) {
      if (typeof fn === 'string') return vm.runInContext(fn, vmContext);
      vmContext.__args = args;
      const src = fn.toString();
      const expr = /^\s*(async\s+)?function\b|^\s*(async\s+)?\(/.test(src) ? `(${src})` : `(function ${src})`;
      return vm.runInContext(`${expr}.apply(null, __args)`, vmContext);
    },
  };

  const mockChats = [
    // Person 1: has BOTH @lid and @c.us chats -> should deduplicate into 1 entry, merge unreadCount (2+3=5), keep max timestamp
    {
      id: { _serialized: '111222333@lid' },
      name: 'Zeynep LID',
      isGroup: false,
      unreadCount: 2,
      timestamp: nowSec - 60,
      lastMessage: { body: 'Eski mesaj', timestamp: nowSec - 60, fromMe: false },
      async fetchMessages() {
        return [{ id: { _serialized: 'm-1' }, fromMe: false, timestamp: nowSec - 60, body: 'Eski mesaj' }];
      },
    },
    {
      id: { _serialized: '905559998877@c.us' },
      name: 'Zeynep',
      isGroup: false,
      unreadCount: 3,
      timestamp: nowSec,
      lastMessage: { body: 'Yeni mesaj', timestamp: nowSec, fromMe: false },
      async fetchMessages() {
        return [{ id: { _serialized: 'm-2' }, fromMe: false, timestamp: nowSec, body: 'Yeni mesaj' }];
      },
    },
    // Person 2: supplier whose thirdPartyOutreachUntil is stored under rawId ('444555666@lid') while resolved to '905558887766@c.us'
    {
      id: { _serialized: '444555666@lid' },
      name: 'Tedarikçi LID',
      isGroup: false,
      unreadCount: 1,
      timestamp: nowSec - 10,
      lastMessage: { body: 'Kargo çıktı', timestamp: nowSec - 10, fromMe: false },
      async fetchMessages() {
        throw new Error('supplier with thirdPartyOutreachUntil on rawId must not be fetched');
      },
    },
    // Unresolved @lid chats (to verify owner @lid reverse lookup is called only once before the loop)
    {
      id: { _serialized: '777000111@lid' },
      name: 'Bilinmeyen 1',
      isGroup: false,
      unreadCount: 0,
      timestamp: nowSec - 20,
      lastMessage: { body: 'Selam 1', timestamp: nowSec - 20, fromMe: false },
      async fetchMessages() {
        return [{ id: { _serialized: 'm-u1' }, fromMe: false, timestamp: nowSec - 20, body: 'Selam 1' }];
      },
    },
    {
      id: { _serialized: '777000222@lid' },
      name: 'Bilinmeyen 2',
      isGroup: false,
      unreadCount: 0,
      timestamp: nowSec - 30,
      lastMessage: { body: 'Selam 2', timestamp: nowSec - 30, fromMe: false },
      async fetchMessages() {
        return [{ id: { _serialized: 'm-u2' }, fromMe: false, timestamp: nowSec - 30, body: 'Selam 2' }];
      },
    },
  ];

  let clientRef = null;
  class FakeLocalAuth {}
  class FakeClient extends EventEmitter {
    constructor() {
      super();
      this.pupPage = mockPage;
      clientRef = this;
    }
    async initialize() {}
    async destroy() {}
    async getChats() {
      return mockChats;
    }
    async getContactLidAndPhone(ids) {
      if (ids.length === 1 && ids[0] === '905321112233@c.us') {
        ownerLidLookups += 1;
        return [{ lid: '999999999@lid', pn: '905321112233@c.us' }];
      }
      return ids.map((lid) => {
        if (lid === '111222333@lid') return { lid, pn: '905559998877@c.us' };
        if (lid === '444555666@lid') return { lid, pn: '905558887766@c.us' };
        return { lid, pn: '' };
      });
    }
    async getContactById() {
      // Return contact with no name so normalizeIncomingMessage must fall back to getChatById
      return { id: { _serialized: '905551112233@c.us' } };
    }
    async getChatById(id) {
      if (id === '905551112233@c.us') {
        return { id: { _serialized: id }, name: 'Sohbet Adı Fallback' };
      }
      return null;
    }
  }

  const messages = [];
  const endedCalls = [];
  const adapter = createWhatsAppClient(
    { ownerChatId: '905321112233@c.us', ownerPhone: '905321112233' },
    {
      onMessage: (m) => messages.push(m),
      onIncomingCallEnded: (id) => endedCalls.push(id),
    },
    { Client: FakeClient, LocalAuth: FakeLocalAuth }
  );

  // 1. ensureHookInjected deduplicates evaluateOnNewDocument per page
  await adapter.initialize();
  clientRef.emit('ready');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(evalOnNewDocCalls, 1, 'evaluateOnNewDocument must be called at most once per page');

  // 2. listRecentChats deduplicates @lid + @c.us for Zeynep
  const recent = await adapter.listRecentChats(10);
  const zeynepEntries = recent.filter((r) => r.chatId === '905559998877@c.us');
  assert.equal(zeynepEntries.length, 1, 'Zeynep @lid and @c.us must be deduplicated in listRecentChats');
  assert.equal(zeynepEntries[0].unreadCount, 5, 'unreadCount merged (2 + 3)');
  assert.equal(zeynepEntries[0].timestamp, nowSec);
  assert.equal(zeynepEntries[0].lastMessage.body, 'Yeni mesaj');

  // 3. scanCustomerChats deduplicates @lid + @c.us, checks rawId for thirdPartyOutreachUntil, and resolves owner @lid once
  const store = {
    getChatState(id) {
      if (id === '444555666@lid') {
        return { thirdPartyOutreachUntil: nowMs + 3600_000 };
      }
      return {};
    },
  };
  const scanRes = await adapter.scanCustomerChats({
    rangeStartMs,
    rangeEndMs,
    nowMs,
    store,
  });
  assert.equal(ownerLidLookups, 1, 'owner @lid reverse lookup must run once before the loop, not per @lid chat');
  assert.equal(scanRes.excludedThirdPartyCount, 1, 'thirdPartyOutreachUntil on rawId must exclude supplier');
  const zeynepScanned = scanRes.customers.filter((c) => c.chatId === '905559998877@c.us');
  assert.equal(zeynepScanned.length, 1, 'Zeynep @lid and @c.us must be deduplicated in scanCustomerChats');
  assert.equal(zeynepScanned[0].messageCountInRange, 2, 'messages from both @lid and @c.us threads are combined');

  // 4. normalizeIncomingMessage (fromMe: true) falls back to getChatById when getContactById has no name
  clientRef.emit('message_create', {
    id: { _serialized: 'true_905551112233@c.us_1' },
    from: '908500000000@c.us',
    to: '905551112233@c.us',
    fromMe: true,
    type: 'chat',
    body: 'Merhaba',
    timestamp: nowSec,
  });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].senderName, 'Sohbet Adı Fallback');

  // 5. ensureIncomingCallObserver emits __wpJarvisOnWaCallEnded when an incoming call transitions to outgoing call
  fakeWaCallCol.activeCall = {
    attributes: { id: 'inc-99', peerJid: '905321112233@c.us', outgoing: false },
  };
  fakeWaCallCol.emit('change:activeCall', fakeWaCallCol.activeCall);
  fakeWaCallCol.activeCall = {
    attributes: { id: 'out-100', peerJid: '905321112233@c.us', outgoing: true },
  };
  fakeWaCallCol.emit('change:activeCall', fakeWaCallCol.activeCall);
  await new Promise((r) => setTimeout(r, 15));
  assert.deepEqual(endedCalls, ['inc-99']);
});

