/**
 * Returns a self-contained browser IIFE string suitable for Puppeteer `evaluateOnNewDocument`.
 * Hooks `navigator.mediaDevices.getUserMedia` and `window.RTCPeerConnection` to expose
 * `window.__wpJarvisAudio` for bidirectional PCM injection, remote audio capture (16kHz Int16),
 * and WebRTC connection telemetry.
 *
 * @returns {string}
 */
export function getBrowserHookScript() {
  return `(function () {
  'use strict';
  if (typeof window === 'undefined' || window.__wpJarvisAudio) {
    return;
  }

  var TARGET_INCOMING_RATE = 16000;
  var DEFAULT_OUTGOING_RATE = 24000;
  var DEFAULT_BRIDGE_BATCH_SAMPLES = 320; // 20ms @ 16kHz mono PCM16
  var MAX_EVENTS = 200;
  var MAX_CAPTURE_CHUNKS = 2000;
  var MAX_PEER_CONNECTIONS = 50;

  var AudioCtx = window.AudioContext || window.webkitAudioContext;
  var outCtx = null;
  var outGain = null;
  var activeDestinations = [];
  var activeSources = new Set();
  var nextPlayTime = 0;
  var keepAliveStarted = false;
  var outFlushGen = 0;

  var inCtx = null;
  var incomingContexts = [];
  var capturedIncomingChunks = [];
  var capturingIncoming = false;
  var incomingPcmHandler = null;
  var stateChangeHandler = null;
  var bridgeBatchSamples = DEFAULT_BRIDGE_BATCH_SAMPLES;
  var bridgeStreamingEnabled = true;
  var bridgePcmQueue = [];
  var bridgePcmSamples = 0;
  var bridgeFlushTimer = null;
  var activeWebrtcTrackCount = 0;
  var webAudioDestCleanups = [];

  var state = {
    hookedGetUserMediaCount: 0,
    hookedPeerConnectionCount: 0,
    latestConnectionState: 'new',
    latestIceConnectionState: 'new',
    latestSignalingState: 'stable',
    outgoingQueueCount: 0,
    incomingChunksCaptured: 0,
    incomingBytesCaptured: 0,
    lastIncomingPeak: 0,
    lastIncomingRms: 0,
    outgoingSampleRate: DEFAULT_OUTGOING_RATE,
    incomingSampleRate: TARGET_INCOMING_RATE,
    peerConnections: [],
    events: []
  };

  function recordEvent(evt) {
    state.events.push(evt);
    if (state.events.length > MAX_EVENTS) {
      state.events.shift();
    }
    if (evt.connectionState) state.latestConnectionState = evt.connectionState;
    if (evt.iceConnectionState) state.latestIceConnectionState = evt.iceConnectionState;
    if (evt.signalingState) state.latestSignalingState = evt.signalingState;

    if (typeof stateChangeHandler === 'function') {
      try { stateChangeHandler(evt); } catch (_) {}
    }
    if (typeof window.__wpJarvisOnCallState === 'function') {
      try { window.__wpJarvisOnCallState(evt); } catch (_) {}
    }
  }

  function ensureOutAudioGraph() {
    if (!AudioCtx) {
      throw new Error('AudioContext is not available in this browser environment');
    }
    if (!outCtx || outCtx.state === 'closed') {
      outCtx = new AudioCtx();
      outGain = outCtx.createGain();
      outGain.__wpJarvisInternal = true;
      outGain.gain.value = 1;
      state.outgoingSampleRate = outCtx.sampleRate || DEFAULT_OUTGOING_RATE;
      keepAliveStarted = false;

      if (!keepAliveStarted) {
        keepAliveStarted = true;
        try {
          if (typeof outCtx.createConstantSource === 'function') {
            var keepAlive = outCtx.createConstantSource();
            keepAlive.__wpJarvisInternal = true;
            keepAlive.offset.value = 0;
            keepAlive.connect(outGain);
            keepAlive.start();
          } else {
            var silentBuf = outCtx.createBuffer(1, 128, outCtx.sampleRate || 48000);
            var silentSrc = outCtx.createBufferSource();
            silentSrc.__wpJarvisInternal = true;
            silentSrc.buffer = silentBuf;
            silentSrc.loop = true;
            silentSrc.connect(outGain);
            silentSrc.start(0);
          }
        } catch (_) {}
      }
    }
    if (typeof outCtx.resume === 'function') {
      try { outCtx.resume().catch(function () {}); } catch (_) {}
    }
    return { ctx: outCtx, gain: outGain };
  }

  function pruneActiveDestinations() {
    for (var i = activeDestinations.length - 1; i >= 0; i--) {
      var d = activeDestinations[i];
      var tracks = d && d.stream && typeof d.stream.getTracks === 'function'
        ? d.stream.getTracks()
        : (d && d.stream && typeof d.stream.getAudioTracks === 'function' ? d.stream.getAudioTracks() : []);
      var allEnded = tracks.length > 0 && tracks.every(function (t) { return t && t.readyState === 'ended'; });
      if (allEnded) {
        try { if (outGain) outGain.disconnect(d); } catch (_) {}
        activeDestinations.splice(i, 1);
      }
    }
  }

  function createSpoofedAudioStream() {
    pruneActiveDestinations();
    var graph = ensureOutAudioGraph();
    var dest = graph.ctx.createMediaStreamDestination();
    graph.gain.connect(dest);
    activeDestinations.push(dest);
    var tracks = dest && dest.stream && typeof dest.stream.getTracks === 'function'
      ? dest.stream.getTracks()
      : (dest && dest.stream && typeof dest.stream.getAudioTracks === 'function' ? dest.stream.getAudioTracks() : []);
    var removeDest = function () {
      var idx = activeDestinations.indexOf(dest);
      if (idx !== -1) {
        activeDestinations.splice(idx, 1);
        try { graph.gain.disconnect(dest); } catch (_) {}
      }
    };
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i];
      if (t && typeof t.addEventListener === 'function') {
        try { t.addEventListener('ended', removeDest); } catch (_) {}
      }
      if (t && typeof t.stop === 'function' && !t.__wpJarvisWrappedStop) {
        var origStop = t.stop.bind(t);
        t.__wpJarvisWrappedStop = true;
        t.stop = function () {
          var r = origStop();
          removeDest();
          return r;
        };
      }
    }
    return dest.stream;
  }

  function toInt16Array(input) {
    if (!input) return new Int16Array(0);
    if (input instanceof Int16Array) return input;
    if (input instanceof ArrayBuffer) {
      var evenLen = input.byteLength - (input.byteLength % 2);
      return new Int16Array(input.slice(0, evenLen));
    }
    if (ArrayBuffer.isView(input)) {
      var bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      var alignedLen = bytes.byteLength - (bytes.byteLength % 2);
      var copy = new Uint8Array(alignedLen);
      copy.set(bytes.subarray(0, alignedLen));
      return new Int16Array(copy.buffer);
    }
    if (Array.isArray(input)) {
      var out = new Int16Array(input.length);
      for (var i = 0; i < input.length; i++) {
        var v = Number(input[i]) || 0;
        out[i] = v < -32768 ? -32768 : (v > 32767 ? 32767 : v | 0);
      }
      return out;
    }
    return new Int16Array(0);
  }

  function resampleFloat32(input, fromRate, toRate) {
    if (!input || !input.length) return new Float32Array(0);
    if (!Number.isFinite(fromRate) || fromRate <= 0 || fromRate === toRate) return input;
    var outLen = Math.max(1, Math.round((input.length * toRate) / fromRate));
    var output = new Float32Array(outLen);
    var ratio = (input.length - 1) / Math.max(1, outLen - 1);
    for (var i = 0; i < outLen; i++) {
      var pos = outLen === 1 ? 0 : i * ratio;
      var idx = Math.floor(pos);
      var frac = pos - idx;
      var s0 = input[idx];
      var s1 = idx + 1 < input.length ? input[idx + 1] : s0;
      output[i] = s0 + (s1 - s0) * frac;
    }
    return output;
  }

  function float32ToInt16(samples) {
    var out = new Int16Array(samples.length);
    for (var i = 0; i < samples.length; i++) {
      var s = samples[i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      out[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
    }
    return out;
  }

  function createStreamingResampler(toRate) {
    var cursorNum = 0;
    var hasPrev = false;
    var prevSample = 0;
    var lastFromRate = 0;

    return {
      process: function (input, fromRate) {
        if (!input || !input.length) return new Float32Array(0);
        if (!Number.isFinite(fromRate) || fromRate <= 0) {
          fromRate = toRate;
        }
        if (!Number.isFinite(fromRate) || fromRate <= 0) {
          return new Float32Array(0);
        }
        var srcRate = fromRate;
        if (lastFromRate && lastFromRate !== srcRate) {
          cursorNum = 0;
          hasPrev = false;
          prevSample = 0;
        }
        lastFromRate = srcRate;

        if (srcRate === toRate) {
          prevSample = input[input.length - 1];
          hasPrev = true;
          return input;
        }

        var len = input.length;
        var limit = len * toRate;
        var out = [];

        while (cursorNum < limit) {
          if (cursorNum < 0) {
            if (!hasPrev) {
              cursorNum = 0;
              continue;
            }
            var fracNeg = (cursorNum + toRate) / toRate;
            out.push(prevSample + (input[0] - prevSample) * fracNeg);
            cursorNum += srcRate;
          } else {
            var idx = Math.floor(cursorNum / toRate);
            var rem = cursorNum % toRate;
            if (rem === 0) {
              out.push(input[idx]);
              cursorNum += srcRate;
            } else if (idx + 1 < len) {
              var s0 = input[idx];
              var s1 = input[idx + 1];
              out.push(s0 + (s1 - s0) * (rem / toRate));
              cursorNum += srcRate;
            } else {
              break;
            }
          }
        }

        cursorNum -= limit;
        prevSample = input[len - 1];
        hasPrev = true;

        var typed = new Float32Array(out.length);
        for (var i = 0; i < out.length; i++) {
          typed[i] = out[i];
        }
        return typed;
      }
    };
  }

  function downsampleToInt16(float32Input, fromRate, toRate) {
    var resampled = resampleFloat32(float32Input, fromRate, toRate);
    return float32ToInt16(resampled);
  }

  function int16ToBase64(int16Arr) {
    var bytes = new Uint8Array(int16Arr.buffer, int16Arr.byteOffset, int16Arr.byteLength);
    var binary = '';
    var chunkSize = 0x8000;
    for (var i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return window.btoa(binary);
  }

  function base64ToInt16(b64) {
    if (!b64 || typeof b64 !== 'string') return new Int16Array(0);
    var bin;
    try {
      bin = window.atob(b64);
    } catch (_) {
      return new Int16Array(0);
    }
    var evenBytes = bin.length - (bin.length % 2);
    var bytes = new Uint8Array(evenBytes);
    for (var i = 0; i < evenBytes; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return new Int16Array(bytes.buffer);
  }

  function pushOutgoingPcm(pcmInput, inputSampleRate) {
    var rate = Number(inputSampleRate) || DEFAULT_OUTGOING_RATE;
    var samples = toInt16Array(pcmInput);
    if (!samples.length) return 0;

    var graph = ensureOutAudioGraph();
    var ctx = graph.ctx;

    var floatData = new Float32Array(samples.length);
    for (var i = 0; i < samples.length; i++) {
      floatData[i] = samples[i] / 32768;
    }

    var bufferRate = rate;
    var buffer;
    try {
      buffer = ctx.createBuffer(1, floatData.length, bufferRate);
      buffer.getChannelData(0).set(floatData);
    } catch (_) {
      bufferRate = ctx.sampleRate || 48000;
      var resampled = resampleFloat32(floatData, rate, bufferRate);
      buffer = ctx.createBuffer(1, resampled.length, bufferRate);
      buffer.getChannelData(0).set(resampled);
    }

    var src = ctx.createBufferSource();
    src.__wpJarvisInternal = true;
    src.buffer = buffer;
    src.connect(graph.gain);

    var now = ctx.currentTime || 0;
    if (nextPlayTime < now) {
      nextPlayTime = now + 0.02;
    }

    activeSources.add(src);
    state.outgoingQueueCount = activeSources.size;

    src.onended = function () {
      activeSources.delete(src);
      state.outgoingQueueCount = activeSources.size;
      try { src.disconnect(); } catch (_) {}
    };

    src.start(nextPlayTime);
    nextPlayTime += buffer.duration || (buffer.length / bufferRate);
    return samples.length;
  }

  function flushOutgoingPcm(minGen) {
    outFlushGen = typeof minGen === 'number' && minGen > outFlushGen ? minGen : outFlushGen + 1;
    activeSources.forEach(function (src) {
      try { src.stop(0); } catch (_) {}
      try { src.disconnect(); } catch (_) {}
    });
    activeSources.clear();
    nextPlayTime = 0;
    state.outgoingQueueCount = 0;
    return outFlushGen;
  }

  function clearBridgeBuffer() {
    if (bridgeFlushTimer && typeof clearTimeout === 'function') {
      clearTimeout(bridgeFlushTimer);
      bridgeFlushTimer = null;
    }
    bridgePcmQueue = [];
    bridgePcmSamples = 0;
  }

  function runWebAudioDestCleanups() {
    var list = webAudioDestCleanups.slice();
    webAudioDestCleanups = [];
    for (var i = 0; i < list.length; i++) {
      try { list[i](); } catch (_) {}
    }
  }

  function flushIncomingBridge() {
    if (bridgeFlushTimer && typeof clearTimeout === 'function') {
      clearTimeout(bridgeFlushTimer);
      bridgeFlushTimer = null;
    }
    if (!bridgePcmQueue.length || bridgePcmSamples <= 0) {
      bridgePcmQueue = [];
      bridgePcmSamples = 0;
      return 0;
    }
    var merged = new Int16Array(bridgePcmSamples);
    var offset = 0;
    for (var i = 0; i < bridgePcmQueue.length; i++) {
      var chunk = bridgePcmQueue[i];
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    bridgePcmQueue = [];
    bridgePcmSamples = 0;

    if (typeof window.__wpJarvisOnIncomingAudio === 'function') {
      var peak = 0;
      var sumSq = 0;
      for (var j = 0; j < merged.length; j++) {
        var abs = Math.abs(merged[j]);
        if (abs > peak) peak = abs;
        sumSq += merged[j] * merged[j];
      }
      var rms = merged.length ? Math.round(Math.sqrt(sumSq / merged.length)) : 0;
      try {
        window.__wpJarvisOnIncomingAudio(int16ToBase64(merged), {
          sampleRate: TARGET_INCOMING_RATE,
          peak: peak,
          rms: rms,
          samples: merged.length
        });
      } catch (_) {}
    }
    return merged.length;
  }

  function enqueueBridgePcm(pcm16) {
    if (!bridgeStreamingEnabled || typeof window.__wpJarvisOnIncomingAudio !== 'function') {
      return;
    }
    if (!pcm16 || !pcm16.length) return;
    bridgePcmQueue.push(pcm16);
    bridgePcmSamples += pcm16.length;

    if (bridgeBatchSamples <= 0 || bridgePcmSamples >= bridgeBatchSamples) {
      flushIncomingBridge();
    } else if (!bridgeFlushTimer && typeof setTimeout === 'function') {
      bridgeFlushTimer = setTimeout(flushIncomingBridge, 30);
    }
  }

  function handleIncomingFloatFrame(floatData, fromRate, resampler, sourceTag) {
    var tag = typeof resampler === 'string' ? resampler : sourceTag;
    if (tag && tag.indexOf('webaudio_dest:') === 0 && activeWebrtcTrackCount > 0) {
      return;
    }
    if (!floatData || !floatData.length) return;
    var pcm16;
    if (resampler && typeof resampler.process === 'function') {
      var resampled = resampler.process(floatData, fromRate);
      if (!resampled || !resampled.length) return;
      pcm16 = float32ToInt16(resampled);
    } else {
      pcm16 = downsampleToInt16(floatData, fromRate, TARGET_INCOMING_RATE);
    }

    var peak = 0;
    var sumSq = 0;
    for (var i = 0; i < pcm16.length; i++) {
      var abs = Math.abs(pcm16[i]);
      if (abs > peak) peak = abs;
      sumSq += pcm16[i] * pcm16[i];
    }
    var rms = pcm16.length ? Math.sqrt(sumSq / pcm16.length) : 0;

    state.incomingChunksCaptured += 1;
    state.incomingBytesCaptured += pcm16.byteLength;
    state.lastIncomingPeak = peak;
    state.lastIncomingRms = Math.round(rms);

    var meta = { sampleRate: TARGET_INCOMING_RATE, peak: peak, rms: state.lastIncomingRms };

    if (capturingIncoming) {
      capturedIncomingChunks.push(pcm16);
      if (capturedIncomingChunks.length > MAX_CAPTURE_CHUNKS) {
        capturedIncomingChunks.shift();
      }
    }

    if (typeof incomingPcmHandler === 'function') {
      try { incomingPcmHandler(pcm16, meta); } catch (_) {}
    }

    enqueueBridgePcm(pcm16);
  }

  function attachScriptProcessorCapture(ctx, source, cleanupList, resampler, sourceTag, ownsSource) {
    if (typeof ctx.createScriptProcessor !== 'function') return;
    var sr = ctx.sampleRate || 48000;
    var bufSize = sr <= 24000 ? 512 : 2048;
    var processor = ctx.createScriptProcessor(bufSize, 1, 1);
    processor.__wpJarvisInternal = true;
    var zeroGain = ctx.createGain();
    zeroGain.__wpJarvisInternal = true;
    zeroGain.gain.value = 0;

    processor.onaudioprocess = function (evt) {
      var input = evt && evt.inputBuffer && evt.inputBuffer.getChannelData
        ? evt.inputBuffer.getChannelData(0)
        : null;
      if (input) {
        handleIncomingFloatFrame(input, ctx.sampleRate || 48000, resampler, sourceTag);
      }
    };

    source.connect(processor);
    processor.connect(zeroGain);
    if (ctx.destination) {
      zeroGain.connect(ctx.destination);
    }
    recordEvent({
      type: 'audio_capture_attached',
      mode: 'script_processor',
      sampleRate: sr,
      bufSize: bufSize,
      source: sourceTag || 'unknown',
      timestamp: Date.now()
    });
    cleanupList.push(function () {
      processor.onaudioprocess = null;
      if (ownsSource) {
        try { source.disconnect(); } catch (_) {}
      } else {
        try { source.disconnect(processor); } catch (_) {}
      }
      try { processor.disconnect(); } catch (_) {}
      try { zeroGain.disconnect(); } catch (_) {}
    });
  }

  function ensureInAudioContext() {
    if (!inCtx || inCtx.state === 'closed') {
      inCtx = new AudioCtx();
      incomingContexts.push(inCtx);
    }
    if (typeof inCtx.resume === 'function') {
      try { inCtx.resume().catch(function () {}); } catch (_) {}
    }
    return inCtx;
  }

  function ensureWorkletModuleLoaded(ctx) {
    if (ctx.__wpJarvisWorkletPromise) {
      return ctx.__wpJarvisWorkletPromise;
    }

    var workletCode = [
      'class WpJarvisCaptureProcessor extends AudioWorkletProcessor {',
      '  process(inputs) {',
      '    var input = inputs && inputs[0];',
      '    if (!input || !input.length) return true;',
      '    var ch0 = input[0];',
      '    if (!ch0 || !ch0.length) return true;',
      '    var copy = new Float32Array(ch0.length);',
      '    if (input.length === 1) {',
      '      copy.set(ch0);',
      '    } else {',
      '      var chCount = input.length;',
      '      for (var s = 0; s < ch0.length; s++) {',
      '        var sum = 0;',
      '        for (var c = 0; c < chCount; c++) {',
      '          sum += (input[c] && input[c][s]) || 0;',
      '        }',
      '        copy[s] = sum / chCount;',
      '      }',
      '    }',
      '    this.port.postMessage(copy, [copy.buffer]);',
      '    return true;',
      '  }',
      '}',
      'registerProcessor("wp-jarvis-capture", WpJarvisCaptureProcessor);'
    ].join('\\n');

    var blobUrl = window.URL.createObjectURL(new Blob([workletCode], { type: 'application/javascript' }));
    var loadPromise = Promise.resolve(ctx.audioWorklet.addModule(blobUrl)).then(function () {
      try { window.URL.revokeObjectURL(blobUrl); } catch (_) {}
    }, function (err) {
      try { window.URL.revokeObjectURL(blobUrl); } catch (_) {}
      ctx.__wpJarvisWorkletPromise = null;
      throw err;
    });
    ctx.__wpJarvisWorkletPromise = loadPromise;
    return loadPromise;
  }

  function attachNodeAudioCapture(ctx, source, cleanupNodes, stateRef, sourceTag, ownsSource) {
    var sr = ctx.sampleRate || 48000;
    var resampler = createStreamingResampler(TARGET_INCOMING_RATE);

    if (
      ctx.audioWorklet &&
      typeof window.AudioWorkletNode === 'function' &&
      typeof Blob !== 'undefined' &&
      window.URL &&
      typeof window.URL.createObjectURL === 'function'
    ) {
      ensureWorkletModuleLoaded(ctx).then(function () {
        if (stateRef && stateRef.cleaned) return;
        var workletNode = new window.AudioWorkletNode(ctx, 'wp-jarvis-capture', {
          channelCount: 1,
          channelCountMode: 'explicit'
        });
        workletNode.__wpJarvisInternal = true;
        var silentGain = ctx.createGain();
        silentGain.__wpJarvisInternal = true;
        silentGain.gain.value = 0;
        workletNode.port.onmessage = function (msg) {
          if (msg && msg.data) {
            handleIncomingFloatFrame(msg.data, sr, resampler, sourceTag);
          }
        };
        source.connect(workletNode);
        workletNode.connect(silentGain);
        if (ctx.destination) silentGain.connect(ctx.destination);
        recordEvent({
          type: 'audio_capture_attached',
          mode: 'worklet',
          sampleRate: sr,
          source: sourceTag || 'unknown',
          timestamp: Date.now()
        });
        cleanupNodes.push(function () {
          if (workletNode.port) workletNode.port.onmessage = null;
          if (ownsSource) {
            try { source.disconnect(); } catch (_) {}
          } else {
            try { source.disconnect(workletNode); } catch (_) {}
          }
          try { workletNode.disconnect(); } catch (_) {}
          try { silentGain.disconnect(); } catch (_) {}
        });
      }).catch(function () {
        if (!stateRef || !stateRef.cleaned) {
          attachScriptProcessorCapture(ctx, source, cleanupNodes, resampler, sourceTag, ownsSource);
        }
      });
    } else {
      attachScriptProcessorCapture(ctx, source, cleanupNodes, resampler, sourceTag, ownsSource);
    }
  }

  function attachWebAudioSourceCapture(sourceNode, targetCtx) {
    if (!targetCtx || targetCtx.state === 'closed' || !sourceNode) return;
    if (sourceNode === outGain || sourceNode.__wpJarvisInternal) return;
    if (incomingContexts.indexOf(targetCtx) === -1) {
      incomingContexts.push(targetCtx);
    }
    var srcName = (sourceNode.constructor && sourceNode.constructor.name) || 'AudioNode';
    var cleanupNodes = [];
    var stateRef = { cleaned: false };
    function cleanupSourceTap() {
      if (stateRef.cleaned) return;
      stateRef.cleaned = true;
      sourceNode.__wpJarvisTapped = false;
      for (var i = 0; i < cleanupNodes.length; i++) {
        try { cleanupNodes[i](); } catch (_) {}
      }
      var idx = webAudioDestCleanups.indexOf(cleanupSourceTap);
      if (idx !== -1) webAudioDestCleanups.splice(idx, 1);
    }
    webAudioDestCleanups.push(cleanupSourceTap);
    if (typeof sourceNode.addEventListener === 'function') {
      try { sourceNode.addEventListener('ended', cleanupSourceTap); } catch (_) {}
    }
    attachNodeAudioCapture(
      targetCtx,
      sourceNode,
      cleanupNodes,
      stateRef,
      'webaudio_dest:' + srcName,
      false
    );
  }

  function attachIncomingAudioCapture(event, pc) {
    if (!AudioCtx || !event || !event.track || event.track.kind !== 'audio') return;
    try {
      var ctx = ensureInAudioContext();
      var cleanupNodes = [];
      var stateRef = { cleaned: false };
      function cleanup() {
        if (stateRef.cleaned) return;
        stateRef.cleaned = true;
        activeWebrtcTrackCount = Math.max(0, activeWebrtcTrackCount - 1);
        flushIncomingBridge();
        for (var i = 0; i < cleanupNodes.length; i++) {
          try { cleanupNodes[i](); } catch (_) {}
        }
      }
      if (typeof event.track.addEventListener === 'function') {
        event.track.addEventListener('ended', cleanup);
      }
      if (pc && typeof pc.addEventListener === 'function') {
        var checkPcTerminal = function () {
          if (
            pc.connectionState === 'closed' ||
            pc.connectionState === 'failed' ||
            pc.iceConnectionState === 'closed' ||
            pc.iceConnectionState === 'failed'
          ) {
            cleanup();
          }
        };
        pc.addEventListener('connectionstatechange', checkPcTerminal);
        pc.addEventListener('iceconnectionstatechange', checkPcTerminal);
      }

      var stream = (event.streams && event.streams[0]) || (window.MediaStream ? new window.MediaStream([event.track]) : null);
      if (!stream || typeof ctx.createMediaStreamSource !== 'function') return;
      var source = ctx.createMediaStreamSource(stream);
      source.__wpJarvisInternal = true;
      activeWebrtcTrackCount += 1;
      attachNodeAudioCapture(ctx, source, cleanupNodes, stateRef, 'webrtc_track', true);
    } catch (_) {}
  }

  // Capture non-WebRTC playback routed through AudioWorklet/WebAudio -> AudioDestinationNode (e.g. WA Web VoIP WASM)
  if (typeof window !== 'undefined' && window.AudioNode && window.AudioNode.prototype && typeof window.AudioNode.prototype.connect === 'function') {
    var origAudioNodeConnect = window.AudioNode.prototype.connect;
    window.AudioNode.prototype.connect = function (destination) {
      var res = origAudioNodeConnect.apply(this, arguments);
      try {
        if (
          this &&
          !this.__wpJarvisInternal &&
          !this.__wpJarvisTapped &&
          destination &&
          this.context &&
          ((typeof window.AudioDestinationNode === 'function' && destination instanceof window.AudioDestinationNode) ||
            destination === this.context.destination)
        ) {
          this.__wpJarvisTapped = true;
          attachWebAudioSourceCapture(this, this.context);
        }
      } catch (_) {}
      return res;
    };
  }

  // Wrap navigator.mediaDevices.getUserMedia
  if (typeof navigator !== 'undefined' && navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') {
    var origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = function (constraints) {
      if (!constraints || !constraints.audio) {
        return origGetUserMedia(constraints);
      }

      state.hookedGetUserMediaCount += 1;
      recordEvent({ type: 'getUserMedia', audio: true, video: Boolean(constraints.video), timestamp: Date.now() });

      var audioStream = createSpoofedAudioStream();
      if (constraints.video && window.MediaStream) {
        return origGetUserMedia({ video: constraints.video }).then(function (videoStream) {
          var tracks = audioStream.getAudioTracks().concat(videoStream.getVideoTracks ? videoStream.getVideoTracks() : []);
          return new window.MediaStream(tracks);
        }).catch(function () {
          return audioStream;
        });
      }

      return Promise.resolve(audioStream);
    };
  }

  // Wrap window.RTCPeerConnection
  var OrigRTCPeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection;
  if (typeof OrigRTCPeerConnection === 'function') {
    var WrappedRTCPeerConnection = function (configuration, constraints) {
      var pc = constraints !== undefined
        ? new OrigRTCPeerConnection(configuration, constraints)
        : new OrigRTCPeerConnection(configuration);

      state.hookedPeerConnectionCount += 1;
      var pcId = state.hookedPeerConnectionCount;
      var record = {
        id: pcId,
        createdAt: Date.now(),
        connectionState: pc.connectionState || 'new',
        iceConnectionState: pc.iceConnectionState || 'new',
        signalingState: pc.signalingState || 'stable',
        remoteAudioTracks: 0
      };
      state.peerConnections.push(record);
      if (state.peerConnections.length > MAX_PEER_CONNECTIONS) {
        state.peerConnections.shift();
      }

      recordEvent({
        type: 'pc_created',
        pcId: pcId,
        connectionState: record.connectionState,
        iceConnectionState: record.iceConnectionState,
        signalingState: record.signalingState,
        timestamp: Date.now()
      });

      if (typeof pc.addEventListener === 'function') {
        pc.addEventListener('connectionstatechange', function () {
          record.connectionState = pc.connectionState;
          recordEvent({
            type: 'connectionstatechange',
            pcId: pcId,
            connectionState: pc.connectionState,
            iceConnectionState: pc.iceConnectionState,
            timestamp: Date.now()
          });
        });

        pc.addEventListener('iceconnectionstatechange', function () {
          record.iceConnectionState = pc.iceConnectionState;
          recordEvent({
            type: 'iceconnectionstatechange',
            pcId: pcId,
            connectionState: pc.connectionState,
            iceConnectionState: pc.iceConnectionState,
            timestamp: Date.now()
          });
        });

        pc.addEventListener('signalingstatechange', function () {
          record.signalingState = pc.signalingState;
          recordEvent({
            type: 'signalingstatechange',
            pcId: pcId,
            signalingState: pc.signalingState,
            timestamp: Date.now()
          });
        });

        pc.addEventListener('track', function (event) {
          var kind = event && event.track ? event.track.kind : 'unknown';
          if (kind === 'audio') {
            record.remoteAudioTracks += 1;
          }
          recordEvent({
            type: 'track',
            pcId: pcId,
            kind: kind,
            timestamp: Date.now()
          });
          attachIncomingAudioCapture(event, pc);
        });
      }

      return pc;
    };

    WrappedRTCPeerConnection.prototype = OrigRTCPeerConnection.prototype;
    try {
      Object.setPrototypeOf(WrappedRTCPeerConnection, OrigRTCPeerConnection);
    } catch (_) {}

    window.RTCPeerConnection = WrappedRTCPeerConnection;
    if (window.webkitRTCPeerConnection) {
      window.webkitRTCPeerConnection = WrappedRTCPeerConnection;
    }
  }

  window.__wpJarvisAudio = {
    pushOutgoingPcm: pushOutgoingPcm,
    pushOutgoingBase64Pcm: function (b64, sampleRate, expectedGen) {
      if (typeof expectedGen === 'number' && expectedGen < outFlushGen) {
        return 0;
      }
      return pushOutgoingPcm(base64ToInt16(b64), sampleRate);
    },
    flushOutgoingPcm: flushOutgoingPcm,
    startIncomingCapture: function () {
      capturedIncomingChunks = [];
      capturingIncoming = true;
    },
    stopIncomingCapture: function () {
      capturingIncoming = false;
    },
    drainIncomingPcm: function () {
      var totalLen = 0;
      for (var i = 0; i < capturedIncomingChunks.length; i++) {
        totalLen += capturedIncomingChunks[i].length;
      }
      var merged = new Int16Array(totalLen);
      var offset = 0;
      for (var j = 0; j < capturedIncomingChunks.length; j++) {
        merged.set(capturedIncomingChunks[j], offset);
        offset += capturedIncomingChunks[j].length;
      }
      capturedIncomingChunks = [];
      return merged;
    },
    setIncomingPcmHandler: function (fn) {
      incomingPcmHandler = typeof fn === 'function' ? fn : null;
    },
    setStateChangeHandler: function (fn) {
      stateChangeHandler = typeof fn === 'function' ? fn : null;
    },
    configureBridge: function (opts) {
      if (!opts || typeof opts !== 'object') return;
      if (opts.batchSamples !== undefined) {
        var parsedBatch = Number(opts.batchSamples);
        bridgeBatchSamples = Number.isFinite(parsedBatch) && parsedBatch >= 0
          ? Math.floor(parsedBatch)
          : DEFAULT_BRIDGE_BATCH_SAMPLES;
      }
      if (opts.enabled !== undefined) {
        var nextEnabled = Boolean(opts.enabled);
        if (nextEnabled !== bridgeStreamingEnabled) {
          clearBridgeBuffer();
        }
        bridgeStreamingEnabled = nextEnabled;
        if (!nextEnabled) {
          runWebAudioDestCleanups();
        }
      }
    },
    flushIncomingBridge: flushIncomingBridge,
    getTelemetry: function () {
      return {
        hookedGetUserMediaCount: state.hookedGetUserMediaCount,
        hookedPeerConnectionCount: state.hookedPeerConnectionCount,
        latestConnectionState: state.latestConnectionState,
        latestIceConnectionState: state.latestIceConnectionState,
        latestSignalingState: state.latestSignalingState,
        outgoingQueueCount: state.outgoingQueueCount,
        incomingChunksCaptured: state.incomingChunksCaptured,
        incomingBytesCaptured: state.incomingBytesCaptured,
        lastIncomingPeak: state.lastIncomingPeak,
        lastIncomingRms: state.lastIncomingRms,
        outgoingSampleRate: state.outgoingSampleRate,
        incomingSampleRate: state.incomingSampleRate,
        peerConnections: state.peerConnections.slice(),
        events: state.events.slice()
      };
    },
    resetTelemetry: function () {
      state.events = [];
      state.latestConnectionState = 'new';
      state.latestIceConnectionState = 'new';
      state.latestSignalingState = 'stable';
      state.incomingChunksCaptured = 0;
      state.incomingBytesCaptured = 0;
      state.lastIncomingPeak = 0;
      state.lastIncomingRms = 0;
      outFlushGen = 0;
      capturedIncomingChunks = [];
      clearBridgeBuffer();
      runWebAudioDestCleanups();
      pruneActiveDestinations();
    },
    _debugGetIncomingContexts: function () {
      return incomingContexts;
    }
  };
})();`;
}
