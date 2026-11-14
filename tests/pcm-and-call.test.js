import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  resamplePcm16,
  base64ToInt16Safely,
  int16ToBase64,
} from '../src/whatsapp/pcm.js';
import {
  createCallController,
  classifyCallOutcome,
} from '../src/whatsapp/call-controller.js';
import {
  AUDIO_CALL_SELECTORS,
  HANGUP_SELECTORS,
  INCOMING_ACCEPT_SELECTORS,
  analyzeCallDomFromDocument,
  selectClickableCandidate,
} from '../scripts/spike-webrtc-call.js';
import { getBrowserHookScript } from '../src/whatsapp/injected-hook.js';

function makeDomElement({
  id = '',
  tagName = 'DIV',
  attrs = {},
  innerText = '',
  rect = { width: 40, height: 40 },
  parent = null,
  matchFn = null,
} = {}) {
  const el = {
    id,
    tagName,
    attrs: { ...attrs },
    innerText,
    rect,
    parentElement: parent,
    children: [],
    clicked: false,
    onClick: null,
    getAttribute(k) {
      return this.attrs[k] ?? null;
    },
    getBoundingClientRect() {
      return this.rect;
    },
    click() {
      this.clicked = true;
      this.onClick?.(this);
    },
    matches(sel) {
      if (matchFn) return matchFn(sel, this);
      if (sel.startsWith('#')) return `#${this.id}` === sel;
      if (sel === 'header') return this.tagName === 'HEADER';
      return false;
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
        if (node !== this && parts.some((p) => node.matches(p))) {
          out.push(node);
        }
        for (const ch of node.children || []) walk(ch);
      };
      walk(this);
      return out;
    },
  };
  if (parent) parent.children.push(el);
  return el;
}

function makeFakeCallPage({ withCallButton = true, useGotoFallback = false } = {}) {
  const exposed = new Map();
  let exposeCalls = 0;
  const gotoCalls = [];
  const evalHistory = [];

  const root = makeDomElement({
    id: 'app',
    matchFn: (s, e) => s === `#${e.id}`,
  });
  const mainPane = makeDomElement({
    id: 'main',
    parent: root,
    innerText: 'Ahmet\n14:22\nMüşteri: Meşgul misiniz? Cevap yok.\n00:15 buluşalım',
    matchFn: (s, e) => s === '#main' || s === `#${e.id}`,
  });
  const header = makeDomElement({
    tagName: 'HEADER',
    parent: mainPane,
    matchFn: (s) => s === 'header' || s === '#main header',
  });

  let callBtn = null;
  if (withCallButton) {
    // Distractor sidebar call button outside header (header must still be preferred)
    makeDomElement({
      tagName: 'BUTTON',
      attrs: { 'data-icon': 'audio-call', 'aria-label': 'Sidebar call' },
      parent: root,
      matchFn: (s) => s === '[data-icon="audio-call"]',
    });
    callBtn = makeDomElement({
      tagName: 'BUTTON',
      attrs: { 'data-icon': 'audio-call', 'aria-label': 'Sesli arama' },
      parent: header,
      matchFn: (s) => s === '[data-icon="audio-call"]' || s === 'button',
    });
  } else {
    // Hidden zero-size element must NOT be clicked
    makeDomElement({
      tagName: 'BUTTON',
      attrs: { 'data-icon': 'audio-call', 'aria-label': 'Hidden call' },
      rect: { width: 0, height: 0 },
      parent: header,
      matchFn: (s) => s === '[data-icon="audio-call"]' || s === 'button',
    });
  }

  let callDialog = null;
  let hangupBtn = null;

  const createdSources = [];
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
      this.stopped = false;
      this.disconnected = false;
      this.onended = null;
      createdSources.push(this);
    }
    connect() {}
    disconnect() {
      this.disconnected = true;
    }
    start() {}
    stop() {
      this.stopped = true;
    }
  }
  class MockAudioContext {
    constructor() {
      this.sampleRate = 48000;
      this.currentTime = 1.0;
    }
    resume() {
      return Promise.resolve();
    }
    createGain() {
      return { gain: { value: 1 }, connect() {}, disconnect() {} };
    }
    createMediaStreamDestination() {
      const track = { kind: 'audio', enabled: true, readyState: 'live', stop() {} };
      return { stream: { getAudioTracks: () => [track], getTracks: () => [track] } };
    }
    createBuffer(c, l, r) {
      return new MockAudioBuffer(c, l, r);
    }
    createBufferSource() {
      return new MockSourceNode();
    }
    createMediaStreamSource() {
      return { connect() {} };
    }
    createScriptProcessor() {
      const node = { onaudioprocess: null, connect() {}, disconnect() {} };
      this._lastScriptProcessor = node;
      return node;
    }
  }

  const peerInstances = [];
  class MockRTCPeerConnection {
    constructor() {
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
      for (const fn of this._listeners.get(type) || []) fn(evt);
    }
  }

  class MockMediaStream {
    constructor(tracks = []) {
      this._tracks = tracks;
    }
    getTracks() {
      return this._tracks;
    }
  }

  const document = {
    body: { innerText: mainPane.innerText, matches: () => false },
    querySelector: (s) => root.querySelector(s),
    querySelectorAll: (s) => root.querySelectorAll(s),
  };

  const vmContext = {
    window: null,
    document,
    navigator: {
      mediaDevices: {
        getUserMedia: async () => ({ orig: true }),
      },
    },
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
    Number,
    String,
    Boolean,
    setTimeout,
    clearTimeout,
    atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
    btoa: (str) => Buffer.from(str, 'binary').toString('base64'),
    WWebJS: useGotoFallback
      ? undefined
      : {
          getChat: async (chatId) => ({ id: { _serialized: chatId } }),
        },
    require: useGotoFallback
      ? undefined
      : (name) =>
          name === 'WAWebCmd'
            ? { Cmd: { openChatBottom: async () => true } }
            : null,
  };
  vmContext.window = vmContext;
  vm.createContext(vmContext);
  vm.runInContext(getBrowserHookScript(), vmContext);

  const listeners = new Map();
  const page = {
    on(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, []);
      listeners.get(evt).push(fn);
    },
    off(evt, fn) {
      const list = listeners.get(evt) || [];
      listeners.set(
        evt,
        list.filter((f) => f !== fn)
      );
    },
    emit(evt, arg) {
      for (const fn of listeners.get(evt) || []) fn(arg);
    },
    async exposeFunction(name, fn) {
      exposeCalls += 1;
      if (exposed.has(name)) {
        throw new Error(
          `Failed to add page binding with name ${name}: window['${name}'] already exists!`
        );
      }
      exposed.set(name, fn);
      vmContext[name] = fn;
    },
    async removeExposedFunction(name) {
      exposed.delete(name);
      delete vmContext[name];
    },
    async evaluateOnNewDocument(src) {
      vm.runInContext(src, vmContext);
    },
    async evaluate(fn, ...args) {
      evalHistory.push(typeof fn === 'function' ? fn.name || 'anon' : 'string');
      if (typeof fn === 'string') {
        return vm.runInContext(fn, vmContext);
      }
      vmContext.__wpJarvisEvalArgs = args;
      const serialized = fn.toString();
      const fnExpr = /^\s*(async\s+)?function\b|^\s*(async\s+)?\(|^\s*[a-zA-Z_$][\w$]*\s*=>/.test(serialized)
        ? `(${serialized})`
        : `(function ${serialized})`;
      return vm.runInContext(`${fnExpr}.apply(null, __wpJarvisEvalArgs)`, vmContext);
    },
    async goto(url) {
      gotoCalls.push(url);
      // Simulate page reload clearing window JS globals and re-running hook
      delete vmContext.__wpJarvisAudio;
      delete vmContext.__wpJarvisOnIncomingAudio;
      delete vmContext.__wpJarvisOnCallState;
      exposed.clear();
      vm.runInContext(getBrowserHookScript(), vmContext);
    },
    async waitForSelector() {
      return true;
    },
  };

  function showCallOverlay(text = 'Ahmet\nAranıyor...') {
    if (!callDialog) {
      callDialog = makeDomElement({
        attrs: { role: 'dialog' },
        parent: root,
        innerText: text,
        matchFn: (s) => s === '[role="dialog"]',
      });
      hangupBtn = makeDomElement({
        tagName: 'BUTTON',
        attrs: { 'data-icon': 'call-end', 'aria-label': 'Aramayı sonlandır' },
        parent: callDialog,
        matchFn: (s) => s === '[data-icon="call-end"]' || s === 'button',
      });
    } else {
      callDialog.innerText = text;
    }
    return { callDialog, hangupBtn };
  }

  function closeCallOverlay() {
    if (callDialog) {
      root.children = root.children.filter((c) => c !== callDialog);
      callDialog = null;
      hangupBtn = null;
    }
  }

  return {
    page,
    vmContext,
    callBtn,
    createdSources,
    peerInstances,
    gotoCalls,
    getExposeCalls: () => exposeCalls,
    showCallOverlay,
    closeCallOverlay,
    getHangupBtn: () => hangupBtn,
  };
}

test('base64ToInt16Safely trims trailing odd byte instead of throwing RangeError', () => {
  const buf = Buffer.from([0x01, 0x02, 0x03]); // 3 bytes (odd)
  const samples = base64ToInt16Safely(buf.toString('base64'));
  assert.equal(samples.length, 1);
  assert.equal(samples[0], 0x0201);

  assert.equal(base64ToInt16Safely('').length, 0);
  assert.equal(base64ToInt16Safely(null).length, 0);
  assert.equal(base64ToInt16Safely(Buffer.from([0x7f]).toString('base64')).length, 0);

  const neg = Buffer.from([0x00, 0x80, 0xff, 0x7f]);
  const negSamples = base64ToInt16Safely(neg.toString('base64'));
  assert.deepEqual(Array.from(negSamples), [-32768, 32767]);
});

test('resamplePcm16 downsamples 48kHz to 16kHz and upsamples 24kHz to 48kHz cleanly', () => {
  const input48k = new Int16Array(480); // 10 ms at 48kHz
  input48k.fill(1000);
  const out16k = resamplePcm16(input48k, 48000, 16000);
  assert.equal(out16k.length, 160);
  assert.equal(out16k[0], 1000);
  assert.equal(out16k[159], 1000);

  const input24k = new Int16Array(240); // 10 ms at 24kHz
  input24k.fill(-500);
  const out48k = resamplePcm16(input24k, 24000, 48000);
  assert.equal(out48k.length, 480);
  assert.equal(out48k[0], -500);

  // Linear interpolation midpoint + clamping
  const ramp = new Int16Array([0, 1000]);
  const up = resamplePcm16(ramp, 1000, 2000);
  assert.equal(up.length, 4);
  assert.equal(up[0], 0);
  assert.equal(up[1], 500);
  assert.equal(up[2], 1000);

  const same = resamplePcm16(new Int16Array([32767, -32768]), 16000, 16000);
  assert.deepEqual(Array.from(same), [32767, -32768]);

  assert.equal(resamplePcm16(new Int16Array(0), 48000, 16000).length, 0);
});

test('classifyCallOutcome distinguishes answered, rejected, missed timeout, and error accurately', () => {
  assert.equal(
    classifyCallOutcome({ wasConnected: true, timedOut: false, endedEarlyWhileRinging: false }),
    'answered'
  );
  assert.equal(
    classifyCallOutcome({ wasConnected: true, timedOut: true, endedEarlyWhileRinging: false }),
    'answered'
  );
  assert.equal(
    classifyCallOutcome({ wasConnected: false, timedOut: false, endedEarlyWhileRinging: true }),
    'rejected'
  );
  assert.equal(
    classifyCallOutcome({ wasConnected: false, timedOut: true, endedEarlyWhileRinging: false }),
    'missed'
  );
  assert.equal(
    classifyCallOutcome({ wasConnected: false, timedOut: false, endedEarlyWhileRinging: false, hasError: true }),
    'error'
  );
});

test('injected-hook batches 16kHz PCM frames for bridge and resets WebRTC state in resetTelemetry', async () => {
  const env = makeFakeCallPage();
  const receivedB64 = [];
  await env.page.exposeFunction('__wpJarvisOnIncomingAudio', (b64, meta) => {
    receivedB64.push({ b64, meta });
  });

  const api = env.vmContext.window.__wpJarvisAudio;
  api.configureBridge({ enabled: true, batchSamples: 320 });

  const pc = new env.vmContext.window.RTCPeerConnection({});
  pc.iceConnectionState = 'connected';
  pc.emit('iceconnectionstatechange');
  pc.connectionState = 'connected';
  pc.emit('connectionstatechange');
  assert.equal(api.getTelemetry().latestIceConnectionState, 'connected');

  pc.emit('track', { track: { kind: 'audio', addEventListener() {} }, streams: [{}] });
  const proc = api._debugGetIncomingContexts()[0]._lastScriptProcessor;
  assert.ok(proc);

  // Send two small 480-sample 48kHz chunks (= 160 + 160 = 320 @ 16kHz -> 1 batched bridge emission)
  const chunk = new Float32Array(480);
  chunk.fill(0.25);
  proc.onaudioprocess({ inputBuffer: { getChannelData: () => chunk } });
  assert.equal(receivedB64.length, 0, 'first 160-sample chunk waits for 320-sample (20ms) batch');

  proc.onaudioprocess({ inputBuffer: { getChannelData: () => chunk } });
  assert.equal(receivedB64.length, 1, 'second chunk completes 320-sample batch');
  const decoded = base64ToInt16Safely(receivedB64[0].b64);
  assert.equal(decoded.length, 320);

  // Partial remainder flushes explicitly
  proc.onaudioprocess({ inputBuffer: { getChannelData: () => chunk } });
  assert.equal(receivedB64.length, 1);
  api.flushIncomingBridge();
  assert.equal(receivedB64.length, 2);
  assert.equal(base64ToInt16Safely(receivedB64[1].b64).length, 160);

  // resetTelemetry clears connection states so next call cannot falsely inherit 'connected'
  api.resetTelemetry();
  const afterReset = api.getTelemetry();
  assert.equal(afterReset.latestConnectionState, 'new');
  assert.equal(afterReset.latestIceConnectionState, 'new');
  assert.equal(afterReset.latestSignalingState, 'stable');
});

test('createCallController handles answered call, audio streaming, barge-in flush, and remote hangup', async () => {
  const env = makeFakeCallPage();
  env.callBtn.onClick = () => {
    env.showCallOverlay('Ahmet\nAranıyor...');
  };

  const client = { getPage: () => env.page };
  const config = {
    ownerPhone: '905321112233',
    ownerChatId: '905321112233@c.us',
    callRingTimeoutSec: 5,
    callMaxDurationSec: 30,
  };

  const controller = createCallController({
    client,
    config,
    pollIntervalMs: 15,
    earlyCloseGraceMs: 40,
    chatOpenSettleMs: 5,
  });

  const ownerAudioChunks = [];
  const endedCalls = [];
  let connectedSession = null;

  const session = await controller.startCallWithOwner({
    onConnected(s) {
      connectedSession = s;
    },
    onAudioFromOwner(b64) {
      ownerAudioChunks.push(b64);
    },
    onEnded(status) {
      endedCalls.push(status);
    },
  });

  assert.equal(env.callBtn.clicked, true);
  assert.equal(controller.isCallActive(), true);
  assert.equal(connectedSession, null, 'background #main timestamps must NOT trigger onConnected while ringing');

  // Create WebRTC PC and transition to connected + show 00:01 call timer
  const pc = new env.vmContext.window.RTCPeerConnection({});
  pc.iceConnectionState = 'connected';
  pc.emit('iceconnectionstatechange');
  env.showCallOverlay('Ahmet\n00:01\nAramayı sonlandır');

  await new Promise((r) => setTimeout(r, 40));
  assert.ok(connectedSession, 'onConnected must fire once call connects');

  // Stream incoming 16kHz PCM from owner track -> onAudioFromOwner
  pc.emit('track', { track: { kind: 'audio', addEventListener() {} }, streams: [{}] });
  const proc = env.vmContext.window.__wpJarvisAudio._debugGetIncomingContexts()[0]._lastScriptProcessor;
  const inFrame = new Float32Array(960); // 20ms @ 48kHz -> 320 samples @ 16kHz
  inFrame.fill(0.4);
  proc.onaudioprocess({ inputBuffer: { getChannelData: () => inFrame } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ownerAudioChunks.length, 1);
  assert.equal(base64ToInt16Safely(ownerAudioChunks[0]).length, 320);

  // Push outgoing 24kHz PCM to owner and flush on barge-in
  const aiSamples = new Int16Array(240);
  aiSamples.fill(2000);
  const pushedCount = await session.pushAudioToOwner(int16ToBase64(aiSamples));
  assert.equal(pushedCount, 240);
  await session.flushAudioToOwner();
  assert.equal(env.createdSources[1].stopped, true, 'queued AI audio stops immediately on barge-in flush');

  // Simulate remote hangup by owner (dialog closes + WebRTC closes)
  env.closeCallOverlay();
  pc.connectionState = 'closed';
  pc.emit('connectionstatechange');

  const outcome = await session.done;
  assert.equal(outcome, 'answered');
  assert.deepEqual(endedCalls, ['answered']);
  assert.equal(controller.isCallActive(), false);
});

test('createCallController classifies early decline while ringing as rejected without calling onConnected', async () => {
  const env = makeFakeCallPage();
  env.callBtn.onClick = () => {
    env.showCallOverlay('Ahmet\nAranıyor...');
  };

  const controller = createCallController({
    client: { getPage: () => env.page },
    config: {
      ownerPhone: '905321112233',
      ownerChatId: '905321112233@c.us',
      callRingTimeoutSec: 5,
      callMaxDurationSec: 30,
    },
    pollIntervalMs: 15,
    earlyCloseGraceMs: 25,
    chatOpenSettleMs: 5,
  });

  let connectedCount = 0;
  const ended = [];
  const session = await controller.startCallWithOwner({
    onConnected() {
      connectedCount += 1;
    },
    onEnded(status) {
      ended.push(status);
    },
  });

  await new Promise((r) => setTimeout(r, 40));
  env.showCallOverlay('Ahmet\nReddedildi');

  const outcome = await session.done;
  assert.equal(outcome, 'rejected');
  assert.deepEqual(ended, ['rejected']);
  assert.equal(connectedCount, 0);
  assert.equal(controller.isCallActive(), false);
});

test('createCallController classifies ring timeout as missed and clicks hangup button', async () => {
  const env = makeFakeCallPage();
  let hangupClicks = 0;
  let activePc = null;

  env.callBtn.onClick = () => {
    const { hangupBtn } = env.showCallOverlay('Ahmet\nAranıyor...');
    activePc = new env.vmContext.window.RTCPeerConnection({});
    hangupBtn.onClick = () => {
      hangupClicks += 1;
      activePc.connectionState = 'closed';
      activePc.emit('connectionstatechange');
      env.closeCallOverlay();
    };
  };

  const controller = createCallController({
    client: { getPage: () => env.page },
    config: {
      ownerPhone: '905321112233',
      ownerChatId: '905321112233@c.us',
      callRingTimeoutSec: 0.08,
      callMaxDurationSec: 30,
    },
    pollIntervalMs: 15,
    earlyCloseGraceMs: 40,
    chatOpenSettleMs: 5,
  });

  let connectedCount = 0;
  const session = await controller.startCallWithOwner({
    onConnected() {
      connectedCount += 1;
    },
  });

  const outcome = await session.done;
  assert.equal(outcome, 'missed', 'WebRTC closed triggered by hangup click must not override missed with rejected');
  assert.equal(connectedCount, 0);
  assert.equal(hangupClicks, 1);
  assert.equal(controller.isCallActive(), false);
});

test('createCallController enforces CALL_MAX_DURATION_SEC on answered call and safely reuses bridge across calls & reload', async () => {
  const env = makeFakeCallPage({ useGotoFallback: true });
  env.callBtn.onClick = () => {
    env.showCallOverlay('Ahmet\n00:01\nAramayı sonlandır');
  };

  const controller = createCallController({
    client: { getPage: () => env.page },
    config: {
      ownerPhone: '905321112233',
      ownerChatId: '905321112233@c.us',
      callRingTimeoutSec: 2,
      callMaxDurationSec: 0.08,
    },
    pollIntervalMs: 15,
    earlyCloseGraceMs: 30,
    chatOpenSettleMs: 5,
  });

  // Call #1 via page.goto fallback -> hits max duration -> 'answered'
  const s1 = await controller.startCallWithOwner({});
  const out1 = await s1.done;
  assert.equal(out1, 'answered');
  assert.equal(env.gotoCalls.length, 1);

  // Call #2 on same page after goto cleared window bindings -> must re-expose cleanly and not inherit stale state
  env.closeCallOverlay();
  env.callBtn.clicked = false;
  env.callBtn.onClick = () => {
    env.showCallOverlay('Ahmet\nAranıyor...');
  };

  let connected2 = false;
  const s2 = await controller.startCallWithOwner({
    onConnected() {
      connected2 = true;
    },
  });
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(connected2, false, 'Call #2 must NOT inherit Call #1 connected telemetry');

  // Early overlay close on Call #2 -> rejected
  env.closeCallOverlay();
  const out2 = await s2.done;
  assert.equal(out2, 'rejected');
  assert.equal(controller.isCallActive(), false);
});

test('createCallController returns error outcome on missing call button / missing page and guards concurrent calls', async () => {
  const noPageController = createCallController({
    client: { getPage: () => null },
    config: { ownerPhone: '905321112233', ownerChatId: '905321112233@c.us' },
  });
  const endedNoPage = [];
  const sErr = await noPageController.startCallWithOwner({
    onEnded: (st) => endedNoPage.push(st),
  });
  assert.equal(await sErr.done, 'error');
  assert.deepEqual(endedNoPage, ['error']);

  const envNoBtn = makeFakeCallPage({ withCallButton: false });
  const noBtnController = createCallController({
    client: { getPage: () => envNoBtn.page },
    config: { ownerPhone: '905321112233', ownerChatId: '905321112233@c.us' },
    chatOpenSettleMs: 5,
    callButtonRetryCount: 1,
    callButtonRetryDelayMs: 5,
  });
  const sNoBtn = await noBtnController.startCallWithOwner({});
  assert.equal(await sNoBtn.done, 'error');
  assert.equal(noBtnController.isCallActive(), false);

  // Concurrent call guard
  const envActive = makeFakeCallPage();
  envActive.callBtn.onClick = () => envActive.showCallOverlay('Ahmet\nAranıyor...');
  const activeCtrl = createCallController({
    client: { getPage: () => envActive.page },
    config: { ownerPhone: '905321112233', ownerChatId: '905321112233@c.us', callRingTimeoutSec: 5 },
    pollIntervalMs: 15,
    chatOpenSettleMs: 5,
  });
  const firstSession = await activeCtrl.startCallWithOwner({});
  await assert.rejects(() => activeCtrl.startCallWithOwner({}), /already in progress/i);
  await firstSession.hangUp('abort');
  assert.equal(await firstSession.done, 'error');
  assert.equal(activeCtrl.isCallActive(), false);
});

test('createCallController isolates stale pcId events, cancels queued audio on barge-in flush, and cleans up on page close', async () => {
  const env = makeFakeCallPage();
  env.callBtn.onClick = () => env.showCallOverlay('Ahmet\nAranıyor...');

  const ctrl = createCallController({
    client: { getPage: () => env.page },
    config: { ownerPhone: '905321112233', ownerChatId: '905321112233@c.us', callRingTimeoutSec: 5 },
    pollIntervalMs: 15,
    earlyCloseGraceMs: 30,
    chatOpenSettleMs: 5,
  });

  // Call #1 creates PC #1 and ends as answered
  const s1 = await ctrl.startCallWithOwner({});
  const pc1 = new env.vmContext.window.RTCPeerConnection({});
  pc1.iceConnectionState = 'connected';
  pc1.emit('iceconnectionstatechange');
  env.showCallOverlay('Ahmet\n0:00\nAramayı bitir');
  await new Promise((r) => setTimeout(r, 25));
  await s1.hangUp('done');
  assert.equal(await s1.done, 'answered');

  // Call #2 starts; late 'closed' event from stale pc1 MUST NOT reject Call #2
  env.closeCallOverlay();
  env.callBtn.clicked = false;
  let s2Connected = null;
  const s2 = await ctrl.startCallWithOwner({
    onConnected(s) {
      s2Connected = s;
    },
  });
  pc1.connectionState = 'closed';
  pc1.emit('connectionstatechange');
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(ctrl.isCallActive(), true, 'stale pc1 close must NOT end Call #2');

  // Connect Call #2 with PC #2 and live timer (0:00), queue outgoing chunks and cancel them via barge-in flush
  const pc2 = new env.vmContext.window.RTCPeerConnection({});
  pc2.iceConnectionState = 'connected';
  pc2.emit('iceconnectionstatechange');
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(s2Connected, null, 'WebRTC pre-warm PC connect alone while ringing must NOT trigger onConnected');
  env.showCallOverlay('Ahmet\n0:00\nAramayı bitir');
  await new Promise((r) => setTimeout(r, 25));
  assert.ok(s2Connected);

  const b64 = int16ToBase64(new Int16Array([100, 200, 300, 400]));
  const p1 = s2Connected.pushAudioToOwner(b64);
  const p2 = s2Connected.pushAudioToOwner(b64);
  await s2Connected.flushAudioToOwner();
  await Promise.all([p1, p2]);
  assert.equal(await p2, 0, 'queued chunk invalidated by flushGeneration must not play after barge-in');

  // Mid-call page close while connected resolves cleanly as answered & releases active lock
  env.page.emit('close');
  assert.equal(await s2.done, 'answered');
  assert.equal(ctrl.isCallActive(), false);
});

test('injected-hook AudioWorklet streams 20ms batched 16kHz PCM over bridge and flushes on track end', async () => {
  const env = makeFakeCallPage();
  const workletNodes = [];
  let addModuleCount = 0;

  class MockWorkletNode {
    constructor(ctx, name, opts) {
      this.ctx = ctx;
      this.name = name;
      this.options = opts;
      this.port = { onmessage: null };
      workletNodes.push(this);
    }
    connect() {}
    disconnect() {}
  }

  class MockBlob {
    constructor(parts) {
      this.parts = parts;
    }
  }

  const BaseCtx = env.vmContext.AudioContext;
  class WorkletCtx extends BaseCtx {
    constructor() {
      super();
      this.audioWorklet = {
        addModule: async () => {
          addModuleCount += 1;
        },
      };
    }
  }

  // Re-create clean context with AudioWorklet support
  const wkCtx = {
    ...env.vmContext,
    window: null,
    AudioContext: WorkletCtx,
    AudioWorkletNode: MockWorkletNode,
    Blob: MockBlob,
    URL: {
      createObjectURL: () => 'blob:mock-1',
      revokeObjectURL: () => {},
    },
  };
  wkCtx.window = wkCtx;
  delete wkCtx.__wpJarvisAudio;
  vm.createContext(wkCtx);
  vm.runInContext(getBrowserHookScript(), wkCtx);

  const bridged = [];
  wkCtx.__wpJarvisOnIncomingAudio = (b64, meta) => bridged.push({ b64, meta });

  const pc = new wkCtx.RTCPeerConnection({});
  const trackListeners = new Map();
  const fakeTrack = {
    kind: 'audio',
    addEventListener: (ev, fn) => trackListeners.set(ev, fn),
  };
  pc.emit('track', { track: fakeTrack, streams: [{}] });
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(addModuleCount, 1);
  assert.equal(workletNodes.length, 1);

  // Send 16 frames of 128 samples @ 48kHz (8 frames = 341 @ 16kHz >= 320 -> 2 bridge batches)
  for (let f = 0; f < 16; f++) {
    const frame = new Float32Array(128);
    frame.fill(0.1);
    workletNodes[0].port.onmessage({ data: frame });
  }
  assert.equal(bridged.length, 2, '16x128 @ 48kHz yields two >=320-sample bridge batches');
  assert.ok(base64ToInt16Safely(bridged[0].b64).length >= 320);

  // Send 2 more frames (~85 samples @ 16kHz < 320) and trigger track 'ended' -> must flush remainder
  for (let f = 0; f < 2; f++) {
    const frame = new Float32Array(128);
    frame.fill(0.2);
    workletNodes[0].port.onmessage({ data: frame });
  }
  assert.equal(bridged.length, 2);
  trackListeners.get('ended')?.();
  assert.equal(bridged.length, 3);
  const totalSamples = bridged.reduce((sum, item) => sum + base64ToInt16Safely(item.b64).length, 0);
  assert.ok(totalSamples >= 767 && totalSamples <= 768);
});

test('createCallController tolerates auxiliary probe PC closing when active call PC connects', async () => {
  const env = makeFakeCallPage();
  env.callBtn.onClick = () => env.showCallOverlay('Ahmet\nAranıyor...');

  const ctrl = createCallController({
    client: { getPage: () => env.page },
    config: { ownerPhone: '905321112233', ownerChatId: '905321112233@c.us', callRingTimeoutSec: 5 },
    pollIntervalMs: 15,
    earlyCloseGraceMs: 40,
    chatOpenSettleMs: 5,
  });

  let connected = null;
  const session = await ctrl.startCallWithOwner({
    onConnected(s) {
      connected = s;
    },
  });

  const probePc = new env.vmContext.window.RTCPeerConnection({});
  const mainPc = new env.vmContext.window.RTCPeerConnection({});
  probePc.connectionState = 'closed';
  probePc.emit('connectionstatechange');
  await new Promise((r) => setTimeout(r, 25));

  assert.equal(ctrl.isCallActive(), true, 'closing probe PC while main PC exists must not terminate call');
  assert.equal(connected, null);

  mainPc.iceConnectionState = 'connected';
  mainPc.emit('iceconnectionstatechange');
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(connected, null, 'pre-answer WebRTC connect must wait for live call timer');

  env.showCallOverlay('Ahmet\n0:00\nAramayı bitir');
  await new Promise((r) => setTimeout(r, 25));
  assert.ok(connected, 'live call timer appearing should fire onConnected');

  await session.hangUp('done');
  assert.equal(await session.done, 'answered');
});

test('createCallController concurrent hangUp while ringing clicks hangup once and preserves error outcome', async () => {
  const env = makeFakeCallPage();
  let hangupClicks = 0;
  env.callBtn.onClick = () => {
    const { hangupBtn } = env.showCallOverlay('Ahmet\nAranıyor...');
    const pc = new env.vmContext.window.RTCPeerConnection({});
    hangupBtn.onClick = () => {
      hangupClicks += 1;
      pc.connectionState = 'closed';
      pc.emit('connectionstatechange');
      env.closeCallOverlay();
    };
  };

  const ctrl = createCallController({
    client: { getPage: () => env.page },
    config: { ownerPhone: '905321112233', ownerChatId: '905321112233@c.us', callRingTimeoutSec: 5 },
    pollIntervalMs: 15,
    earlyCloseGraceMs: 30,
    chatOpenSettleMs: 5,
  });

  const session = await ctrl.startCallWithOwner({});
  const [o1, o2] = await Promise.all([session.hangUp('abort'), session.hangUp('second_abort')]);
  assert.equal(o1, 'error');
  assert.equal(o2, 'error');
  assert.equal(hangupClicks, 1);
  assert.equal(ctrl.isCallActive(), false);
});

test('createCallController prevents timer leaks if page closes during async chat open setup', async () => {
  const env = makeFakeCallPage();
  let evalCount = 0;
  const origEval = env.page.evaluate.bind(env.page);
  env.page.evaluate = async (fn, ...args) => {
    evalCount += 1;
    return origEval(fn, ...args);
  };

  const ctrl = createCallController({
    client: { getPage: () => env.page },
    config: { ownerPhone: '905321112233', ownerChatId: '905321112233@c.us', callRingTimeoutSec: 5 },
    pollIntervalMs: 10,
    chatOpenSettleMs: 50,
  });

  const startPromise = ctrl.startCallWithOwner({});
  setTimeout(() => {
    env.page.emit('close');
  }, 10);

  const session = await startPromise;
  assert.equal(await session.done, 'error');
  assert.equal(ctrl.isCallActive(), false);

  const countAtEnd = evalCount;
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(evalCount, countAtEnd, 'no pollTimer or ringTimer may run after setup-time page close');
});

test('createCallController ignores transient domState null failures while ringing and connected', async () => {
  const env = makeFakeCallPage();
  env.callBtn.onClick = () => env.showCallOverlay('Ahmet\nAranıyor...');

  let failDomEvalCount = 0;
  const origEval = env.page.evaluate.bind(env.page);
  env.page.evaluate = async (fn, ...args) => {
    if (typeof fn === 'function' && fn.name === 'analyzeCallDomFromDocument' && failDomEvalCount > 0) {
      failDomEvalCount -= 1;
      throw new Error('Execution context was destroyed');
    }
    return origEval(fn, ...args);
  };

  const ctrl = createCallController({
    client: { getPage: () => env.page },
    config: { ownerPhone: '905321112233', ownerChatId: '905321112233@c.us', callRingTimeoutSec: 5 },
    pollIntervalMs: 15,
    earlyCloseGraceMs: 20,
    chatOpenSettleMs: 5,
  });

  let connectedSession = null;
  const session = await ctrl.startCallWithOwner({
    onConnected(s) {
      connectedSession = s;
    },
  });

  // Allow first poll to observe hangupPresent (sawHangupOnce = true), then inject 3 transient failures while ringing
  await new Promise((r) => setTimeout(r, 25));
  failDomEvalCount = 3;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(ctrl.isCallActive(), true, 'transient domState === null while ringing must not trigger earlyDomClose');

  // Connect, then inject 3 transient failures while connected
  const pc = new env.vmContext.window.RTCPeerConnection({});
  pc.iceConnectionState = 'connected';
  pc.emit('iceconnectionstatechange');
  env.showCallOverlay('Ahmet\n00:01\nAramayı sonlandır');
  await new Promise((r) => setTimeout(r, 25));
  assert.ok(connectedSession);

  failDomEvalCount = 3;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(ctrl.isCallActive(), true, 'transient domState === null while connected must not trigger domHangupClosed');

  await session.hangUp('done');
  assert.equal(await session.done, 'answered');
});

test('createCallController classifies Cevap yok and No answer DOM hints as missed instead of rejected', async () => {
  for (const hint of ['Cevap yok', 'No answer']) {
    const env = makeFakeCallPage();
    env.callBtn.onClick = () => env.showCallOverlay('Ahmet\nAranıyor...');

    const ctrl = createCallController({
      client: { getPage: () => env.page },
      config: { ownerPhone: '905321112233', ownerChatId: '905321112233@c.us', callRingTimeoutSec: 5 },
      pollIntervalMs: 15,
      earlyCloseGraceMs: 25,
      chatOpenSettleMs: 5,
    });

    let connectedCount = 0;
    const session = await ctrl.startCallWithOwner({
      onConnected() {
        connectedCount += 1;
      },
    });

    await new Promise((r) => setTimeout(r, 30));
    env.showCallOverlay(`Ahmet\n${hint}`);

    const outcome = await session.done;
    assert.equal(outcome, 'missed', `hint "${hint}" must classify as missed`);
    assert.equal(connectedCount, 0);
    assert.equal(ctrl.isCallActive(), false);
  }
});

test('createCallController answerIncomingCall accepts call without navigating, isolates prior PCs, bridges audio, and ends cleanly', async () => {
  const env = makeFakeCallPage({ withCallButton: false });
  const acceptBtn = makeDomElement({
    tagName: 'BUTTON',
    attrs: { 'aria-label': 'Kabul et' },
    innerText: 'Kabul et',
    parent: null,
    matchFn: (s) => s === 'button[aria-label="Kabul et" i]' || s === 'button',
  });
  // Attach acceptBtn to document alongside existing root nodes
  const origQueryAll = env.vmContext.document.querySelectorAll;
  env.vmContext.document.querySelectorAll = (sel) => {
    const base = origQueryAll(sel);
    const parts = sel.split(',').map((s) => s.trim());
    return parts.some((p) => acceptBtn.matches(p)) && acceptBtn._visible !== false
      ? [acceptBtn, ...base]
      : base;
  };
  // Track pre-existing closed PC (pc1 from earlier call) and active ringing PC (pc2 created on offer)
  const pc1 = new env.vmContext.window.RTCPeerConnection({});
  pc1.connectionState = 'closed';
  pc1.iceConnectionState = 'closed';
  pc1.emit('connectionstatechange');
  pc1.emit('iceconnectionstatechange');
  const pc2 = new env.vmContext.window.RTCPeerConnection({});
  pc2.connectionState = 'connecting';
  pc2.iceConnectionState = 'checking';
  pc2.emit('connectionstatechange');

  let acceptClickedCount = 0;
  acceptBtn.onClick = () => {
    acceptClickedCount += 1;
    acceptBtn._visible = false;
    env.showCallOverlay('İşletme Sahibi\n0:00\nAramayı sonlandır');
  };

  const ctrl = createCallController({
    client: { getPage: () => env.page },
    config: { ownerPhone: '905321112233', ownerChatId: '905321112233@c.us', callRingTimeoutSec: 5 },
    pollIntervalMs: 15,
    earlyCloseGraceMs: 25,
    chatOpenSettleMs: 5,
    callButtonRetryCount: 2,
    callButtonRetryDelayMs: 10,
    bridgeBatchSamples: 4,
  });

  let connectedSession = null;
  const receivedAudio = [];
  const endedEvents = [];

  assert.ok(Array.isArray(INCOMING_ACCEPT_SELECTORS) && INCOMING_ACCEPT_SELECTORS.length > 0);
  const session = await ctrl.answerIncomingCall({
    onConnected(s) {
      connectedSession = s;
    },
    onAudioFromOwner(b64) {
      receivedAudio.push(b64);
    },
    onEnded(outcome, details) {
      endedEvents.push({ outcome, details });
    },
  });

  try {
    assert.equal(acceptClickedCount, 1);
    assert.equal(env.gotoCalls.length, 0, 'incoming call must NEVER navigate away via goto');

    await new Promise((r) => setTimeout(r, 35));
    assert.ok(connectedSession, 'should fire onConnected when 0:00 timer appears');

    // Owner-to-Gemini incoming audio over pre-existing ringing PC (pc2)
    pc2.connectionState = 'connected';
    pc2.iceConnectionState = 'connected';
    pc2.emit('connectionstatechange');
    pc2.emit('track', { track: { kind: 'audio', addEventListener() {} }, streams: [{}] });
    const proc = env.vmContext.window.__wpJarvisAudio._debugGetIncomingContexts()[0]._lastScriptProcessor;
    const frame = new Float32Array(256).fill(0.2);
    proc.onaudioprocess({ inputBuffer: { getChannelData: () => frame } });
    await new Promise((r) => setTimeout(r, 15));
    assert.ok(receivedAudio.length >= 1, 'should bridge incoming audio from pre-existing ringing PC');

    // Gemini-to-Owner outgoing audio
    await connectedSession.pushAudioToOwner(int16ToBase64(new Int16Array([150, -150, 150, -150])));
    assert.ok(env.createdSources.length >= 1);

    // Remote hangs up (pc2 closes + overlay removed)
    pc2.connectionState = 'closed';
    pc2.emit('connectionstatechange');
    const outcome = await session.done;
    assert.equal(outcome, 'answered');
    assert.equal(endedEvents[0]?.outcome, 'answered');
    assert.equal(ctrl.isCallActive(), false);
  } finally {
    await session.hangUp('test_cleanup').catch(() => {});
  }
});

test('createCallController answerIncomingCall returns missed cleanly if accept button never appears', async () => {
  const env = makeFakeCallPage({ withCallButton: false });
  const ctrl = createCallController({
    client: { getPage: () => env.page },
    config: { ownerPhone: '905321112233', ownerChatId: '905321112233@c.us', callRingTimeoutSec: 5 },
    pollIntervalMs: 15,
    chatOpenSettleMs: 5,
    callButtonRetryCount: 2,
    callButtonRetryDelayMs: 10,
  });

  let connectedCount = 0;
  const session = await ctrl.answerIncomingCall({
    onConnected() {
      connectedCount += 1;
    },
  });

  const outcome = await session.done;
  assert.equal(outcome, 'missed');
  assert.equal(connectedCount, 0);
  assert.equal(ctrl.isCallActive(), false);
});

test('selectClickableCandidate ignores buttons inside #pane-side chat list', () => {
  const docRoot = makeDomElement({ id: 'app', matchFn: (s) => s === '#app' });
  const paneSide = makeDomElement({ id: 'pane-side', parent: docRoot, matchFn: (s) => s === '#pane-side' });
  const sidebarBtn = makeDomElement({
    tagName: 'BUTTON',
    attrs: { 'aria-label': 'Kabul et' },
    parent: paneSide,
    matchFn: (s) => s === 'button[aria-label="Kabul et" i]',
  });
  const doc = {
    querySelectorAll: (s) => docRoot.querySelectorAll(s),
    querySelector: (s) => docRoot.querySelector(s),
  };
  const chosen = selectClickableCandidate(['button[aria-label="Kabul et" i]'], doc, true);
  assert.equal(chosen, null);
  assert.equal(sidebarBtn.clicked, false);
});

test('injected-hook prevents dual-capture corruption, cleans up webaudio_dest/destinations, caps peerConnections, and guards outFlushGen & closed contexts', async () => {
  class FakeDestinationNode {}
  class FakeAudioNode {
    constructor(ctx) {
      this.context = ctx;
      this.connectedTo = [];
      this.disconnected = false;
      this._listeners = new Map();
    }
    connect(dest) {
      this.connectedTo.push(dest);
      return dest;
    }
    disconnect() {
      this.disconnected = true;
    }
    addEventListener(ev, fn) {
      this._listeners.set(ev, fn);
    }
    emit(ev) {
      this._listeners.get(ev)?.();
    }
  }

  const processors = [];
  const createdContexts = [];
  class FakeAudioContext {
    constructor() {
      this.sampleRate = 16000;
      this.currentTime = 1.0;
      this.state = 'running';
      this.destination = new FakeDestinationNode();
      this.audioWorklet = null;
      createdContexts.push(this);
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
    createBuffer(c, l, r) {
      return {
        numberOfChannels: c,
        length: l,
        sampleRate: r,
        duration: l / r,
        _data: new Float32Array(l),
        getChannelData() {
          return this._data;
        },
      };
    }
    createBufferSource() {
      const n = new FakeAudioNode(this);
      n.start = () => {};
      n.stop = () => {
        n.stopped = true;
      };
      return n;
    }
    createMediaStreamDestination() {
      const trackListeners = new Map();
      const track = {
        kind: 'audio',
        enabled: true,
        readyState: 'live',
        addEventListener: (ev, fn) => trackListeners.set(ev, fn),
        stop() {
          this.readyState = 'ended';
          trackListeners.get('ended')?.();
        },
      };
      return { stream: { getAudioTracks: () => [track], getTracks: () => [track] } };
    }
    createMediaStreamSource() {
      return new FakeAudioNode(this);
    }
    createScriptProcessor() {
      const n = new FakeAudioNode(this);
      n.onaudioprocess = null;
      processors.push(n);
      return n;
    }
    resume() {
      return Promise.resolve();
    }
  }

  class FakeRTCPeerConnection {
    constructor() {
      this.connectionState = 'new';
      this.iceConnectionState = 'new';
      this.signalingState = 'stable';
      this._listeners = new Map();
    }
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    }
    emit(type, evt = {}) {
      for (const fn of this._listeners.get(type) || []) fn(evt);
    }
  }

  class FakeMediaStream {
    constructor(tracks = []) {
      this._tracks = tracks;
    }
    getTracks() {
      return this._tracks;
    }
  }

  const vmCtx = {
    window: null,
    navigator: { mediaDevices: { getUserMedia: async () => ({}) } },
    AudioContext: FakeAudioContext,
    AudioNode: FakeAudioNode,
    AudioDestinationNode: FakeDestinationNode,
    RTCPeerConnection: FakeRTCPeerConnection,
    MediaStream: FakeMediaStream,
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
    setTimeout,
    clearTimeout,
    atob: (b64) => {
      if (b64 === '!!!invalid-base64!!!') throw new Error('InvalidCharacterError');
      return Buffer.from(b64, 'base64').toString('binary');
    },
    btoa: (str) => Buffer.from(str, 'binary').toString('base64'),
  };
  vmCtx.window = vmCtx;
  vm.createContext(vmCtx);
  vm.runInContext(getBrowserHookScript(), vmCtx);

  const api = vmCtx.__wpJarvisAudio;

  // 1. Dual-capture prevention: webaudio_dest captures when no WebRTC track is active,
  //    is suppressed while a WebRTC audio track is active, and resumes when PC closes.
  const waCtx = new FakeAudioContext();
  const waSource = new FakeAudioNode(waCtx);
  waSource.connect(waCtx.destination);
  const webAudioProc = processors[0];
  assert.ok(webAudioProc);

  api.startIncomingCapture();
  const frame = new Float32Array(160).fill(0.5);
  webAudioProc.onaudioprocess({ inputBuffer: { getChannelData: () => frame } });
  assert.equal(api.drainIncomingPcm().length, 160, 'webaudio_dest captures when no WebRTC track active');

  const pc = new vmCtx.RTCPeerConnection({});
  const trackListeners = new Map();
  pc.emit('track', {
    track: { kind: 'audio', addEventListener: (ev, fn) => trackListeners.set(ev, fn) },
    streams: [{}],
  });
  const webrtcProc = processors[1];
  assert.ok(webrtcProc);

  // While WebRTC track is active, webaudio_dest frames MUST be ignored!
  webAudioProc.onaudioprocess({ inputBuffer: { getChannelData: () => frame } });
  assert.equal(api.drainIncomingPcm().length, 0, 'webaudio_dest must be ignored while WebRTC track is active');

  webrtcProc.onaudioprocess({ inputBuffer: { getChannelData: () => frame } });
  assert.equal(api.drainIncomingPcm().length, 160, 'webrtc_track frame is captured normally');

  // Owning PC transitioning to 'closed' cleans up the WebRTC track capture and decrements activeWebrtcTrackCount
  pc.connectionState = 'closed';
  pc.emit('connectionstatechange');
  assert.equal(webrtcProc.disconnected, true);

  webAudioProc.onaudioprocess({ inputBuffer: { getChannelData: () => frame } });
  assert.equal(api.drainIncomingPcm().length, 160, 'webaudio_dest fallback resumes after PC closes');

  // 2. configureBridge({ enabled: false }) cleans up webAudioDestCleanups
  api.configureBridge({ enabled: false });
  assert.equal(webAudioProc.disconnected, true, 'webAudioDest processor disconnected when bridge disabled');

  // Re-tapping and sourceNode 'ended' cleanup
  const waSource2 = new FakeAudioNode(waCtx);
  waSource2.connect(waCtx.destination);
  const webAudioProc2 = processors[processors.length - 1];
  waSource2.emit('ended');
  assert.equal(webAudioProc2.disconnected, true, 'sourceNode ended event cleans up tap');

  // 3. Cap state.peerConnections to 50 entries
  for (let i = 0; i < 60; i++) {
    new vmCtx.RTCPeerConnection({});
  }
  assert.equal(api.getTelemetry().peerConnections.length, 50, 'peerConnections capped at 50');

  // 4. Browser-side outFlushGen & malformed base64 guard & closed outCtx/inCtx recreation
  assert.equal(api.pushOutgoingBase64Pcm('!!!invalid-base64!!!', 24000), 0, 'malformed base64 returns 0');
  const validB64 = int16ToBase64(new Int16Array([1000, -1000]));
  assert.equal(api.pushOutgoingBase64Pcm(validB64, 24000, 0), 2);
  const gen1 = api.flushOutgoingPcm();
  assert.equal(gen1, 1);
  assert.equal(api.pushOutgoingBase64Pcm(validB64, 24000, 0), 0, 'stale expectedGen < outFlushGen is dropped');
  assert.equal(api.pushOutgoingBase64Pcm(validB64, 24000, 1), 2, 'current expectedGen === outFlushGen is accepted');

  // Closed outCtx and inCtx are recreated cleanly
  for (const c of createdContexts) {
    c.state = 'closed';
  }
  const ctxCountBefore = createdContexts.length;
  assert.equal(api.pushOutgoingBase64Pcm(validB64, 24000), 2);
  const pcNew = new vmCtx.RTCPeerConnection({});
  pcNew.emit('track', { track: { kind: 'audio', addEventListener() {} }, streams: [{}] });
  assert.ok(createdContexts.length >= ctxCountBefore + 2, 'closed outCtx and inCtx are recreated');

  // Invalid sampleRate in incoming frame does not hang resampler
  const latestProc = processors[processors.length - 1];
  latestProc.context.sampleRate = -48000;
  latestProc.onaudioprocess({ inputBuffer: { getChannelData: () => frame } });
});

test('selectClickableCandidate skips disabled elements and only prefers header for AUDIO_CALL_SELECTORS', () => {
  const root = makeDomElement({ id: 'app', matchFn: (s) => s === '#app' });
  const main = makeDomElement({ id: 'main', parent: root, matchFn: (s) => s === '#main' });
  const header = makeDomElement({
    tagName: 'HEADER',
    parent: main,
    matchFn: (s) => s === 'header' || s === '#main header',
  });

  // Disabled header call button must be skipped in favor of enabled button
  const disabledCallBtn = makeDomElement({
    tagName: 'BUTTON',
    attrs: { 'data-icon': 'audio-call', 'aria-label': 'Disabled call', 'aria-disabled': 'true' },
    parent: header,
    matchFn: (s) => s === '[data-icon="audio-call"]' || s === 'button',
  });
  const enabledCallBtn = makeDomElement({
    tagName: 'BUTTON',
    attrs: { 'data-icon': 'audio-call', 'aria-label': 'Enabled call' },
    parent: header,
    matchFn: (s) => s === '[data-icon="audio-call"]' || s === 'button',
  });

  const doc = {
    querySelectorAll: (s) => root.querySelectorAll(s),
    querySelector: (s) => root.querySelector(s),
  };
  const pickedCall = selectClickableCandidate(AUDIO_CALL_SELECTORS, doc, true);
  assert.equal(pickedCall.ariaLabel, 'Enabled call');
  assert.equal(disabledCallBtn.clicked, false);
  assert.equal(enabledCallBtn.clicked, true);

  // For HANGUP_SELECTORS, a floating overlay button outside header (first in DOM) must NOT be overridden by a header button
  const overlayHangup = makeDomElement({
    tagName: 'BUTTON',
    attrs: { 'data-icon': 'call-end', 'aria-label': 'Overlay hangup' },
    parent: root,
    matchFn: (s) => s === '[data-icon="call-end"]' || s === 'button',
  });
  const headerHangup = makeDomElement({
    tagName: 'BUTTON',
    attrs: { 'data-icon': 'call-end', 'aria-label': 'Header hangup' },
    parent: header,
    matchFn: (s) => s === '[data-icon="call-end"]' || s === 'button',
  });
  // Place overlayHangup before main in root.children
  root.children = [overlayHangup, main];
  const pickedHangup = selectClickableCandidate(HANGUP_SELECTORS, doc, false);
  assert.equal(pickedHangup.ariaLabel, 'Overlay hangup');
  assert.equal(headerHangup.clicked, false);
});

test('analyzeCallDomFromDocument ignores generic dialog without call signals, suppresses lines.find timer while ringing, and supports hour timers', () => {
  const root = makeDomElement({ id: 'app', matchFn: (s) => s === '#app' });
  const genericModal = makeDomElement({
    attrs: { role: 'dialog' },
    parent: root,
    innerText: 'Mesajı silmek istiyor musunuz?\n00:12\nİptal\nSil',
    matchFn: (s) => s === '[role="dialog"]',
  });
  const doc = {
    body: { innerText: '', matches: () => false },
    querySelector: (s) => root.querySelector(s),
    querySelectorAll: (s) => root.querySelectorAll(s),
  };

  // Generic [role="dialog"] when !hangupPresent and no call status hints -> hasCallContainer: false, timerText: null
  const genericState = analyzeCallDomFromDocument(HANGUP_SELECTORS, doc);
  assert.deepEqual(genericState, {
    hangupPresent: false,
    timerText: null,
    statusHints: [],
    hasCallContainer: false,
  });

  // Dialog with call status hint when !hangupPresent -> hasCallContainer: true, statusHints preserved, ringing suppresses fallback timer
  genericModal.innerText = 'Ahmet\nAranıyor\n0:05';
  const ringingState = analyzeCallDomFromDocument(HANGUP_SELECTORS, doc);
  assert.equal(ringingState.hasCallContainer, true);
  assert.deepEqual(ringingState.statusHints, ['Aranıyor']);
  assert.equal(ringingState.timerText, null, 'fallback lines.find timer must be suppressed while ringing');

  // Explicit [role="timer"] with hours (1:02:03) inside voip-container is recognized
  genericModal.attrs['data-testid'] = 'voip-container';
  genericModal.matches = (s) => s === '[role="dialog"]' || s.includes('voip-container');
  genericModal.innerText = 'Ahmet\n1:02:03';
  makeDomElement({
    attrs: { role: 'timer', 'data-testid': 'voip-call-timer' },
    parent: genericModal,
    innerText: '1:02:03',
    matchFn: (s) => s.includes('voip-call-timer') || s.includes('[role="timer"]'),
  });
  const hourTimerState = analyzeCallDomFromDocument(HANGUP_SELECTORS, doc);
  assert.equal(hourTimerState.timerText, '1:02:03');
});

test('createCallController seeds preExistingActivePcIds states, clicks hangup on webrtc_closed_while_ringing, bounds openOwnerChat timeout, and marks live_session_start_failed as error', async () => {
  // 1. Seed callPcStates for all preExistingActivePcIds on incoming call
  const envIn = makeFakeCallPage({ withCallButton: false });
  const acceptBtn = makeDomElement({
    tagName: 'BUTTON',
    attrs: { 'aria-label': 'Kabul et' },
    innerText: 'Kabul et',
    matchFn: (s) => s === 'button[aria-label="Kabul et" i]' || s === 'button',
  });
  const origQueryAll = envIn.vmContext.document.querySelectorAll;
  envIn.vmContext.document.querySelectorAll = (sel) => {
    const base = origQueryAll(sel);
    const parts = sel.split(',').map((s) => s.trim());
    return parts.some((p) => acceptBtn.matches(p)) && acceptBtn._visible !== false
      ? [acceptBtn, ...base]
      : base;
  };

  // Two pre-existing active PCs created before answerIncomingCall
  const prePc1 = new envIn.vmContext.window.RTCPeerConnection({});
  const prePc2 = new envIn.vmContext.window.RTCPeerConnection({});
  prePc1.connectionState = 'connecting';
  prePc2.connectionState = 'connecting';
  prePc1.emit('connectionstatechange');
  prePc2.emit('connectionstatechange');

  let hangupClicks = 0;
  acceptBtn.onClick = () => {
    acceptBtn._visible = false;
    const { hangupBtn } = envIn.showCallOverlay('İşletme Sahibi\nBağlanıyor...');
    hangupBtn.onClick = () => {
      hangupClicks += 1;
    };
  };

  const ctrlIn = createCallController({
    client: { getPage: () => envIn.page },
    config: { ownerPhone: '905321112233', ownerChatId: '905321112233@c.us', callRingTimeoutSec: 5 },
    pollIntervalMs: 15,
    earlyCloseGraceMs: 40,
    chatOpenSettleMs: 5,
  });

  const sIn = await ctrlIn.answerIncomingCall({});
  // Closing only prePc1 while prePc2 is still 'connecting' must NOT finalize call!
  prePc1.connectionState = 'closed';
  prePc1.emit('connectionstatechange');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ctrlIn.isCallActive(), true, 'closing 1 of 2 seeded pre-existing PCs must not end call');

  // Closing prePc2 while still ringing/connecting finalizes webrtc_closed_while_ringing AND clicks hangup
  prePc2.connectionState = 'closed';
  prePc2.emit('connectionstatechange');
  assert.equal(await sIn.done, 'missed');
  assert.equal(hangupClicks, 1, 'webrtc_closed_while_ringing must click hangup');

  // 2. Bounded timeout in openOwnerChat falls back to page.goto when WWebJS.getChat hangs
  const envHang = makeFakeCallPage();
  envHang.vmContext.WWebJS = {
    getChat: () => new Promise(() => {}), // never resolves
  };
  envHang.callBtn.onClick = () => {
    envHang.showCallOverlay('Ahmet\n0:00\nAramayı sonlandır');
  };
  const ctrlHang = createCallController({
    client: { getPage: () => envHang.page },
    config: {
      ownerPhone: '905321112233',
      ownerChatId: '905321112233@c.us',
      callRingTimeoutSec: 0.05,
    },
    pollIntervalMs: 15,
    chatOpenSettleMs: 5,
  });

  let connectedHangSession = null;
  const sHang = await ctrlHang.startCallWithOwner({
    onConnected(s) {
      connectedHangSession = s;
    },
  });
  assert.equal(envHang.gotoCalls.length, 1, 'hanging WWebJS.getChat must time out and fall back to page.goto');
  await new Promise((r) => setTimeout(r, 25));
  assert.ok(connectedHangSession);

  // 3. hangUp('live_session_start_failed') even after wasConnected===true must return 'error' outcome
  const outErr = await connectedHangSession.hangUp('live_session_start_failed');
  assert.equal(outErr, 'error', 'live_session_start_failed after answer must classify as error, not answered');
  assert.equal(await sHang.done, 'error');
});

