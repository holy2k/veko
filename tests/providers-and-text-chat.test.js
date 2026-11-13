import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VOICE_PROVIDER_IDS,
  TEXT_PROVIDER_IDS,
  isLocalHttpUrl,
  resolveVoiceProviderConfig,
  resolveTextProviderConfig,
} from '../src/ai/providers.js';
import { startOpenAIRealtimeSession } from '../src/ai/openai-realtime.js';
import { startVoiceSession } from '../src/ai/voice-session.js';
import { buildTextSystemInstruction, runOwnerTextTurn } from '../src/ai/text-chat.js';
import { createStateStore } from '../src/state/store.js';
import { base64ToInt16Safely, int16ToBase64 } from '../src/whatsapp/pcm.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('providers registry exposes all supported voice and text provider presets', () => {
  assert.deepEqual(VOICE_PROVIDER_IDS, ['gemini', 'openai', 'none']);
  for (const id of ['gemini', 'openai', 'deepseek', 'ollama', 'anthropic', 'openrouter', 'groq', 'xai', 'openai-compatible', 'none']) {
    assert.ok(TEXT_PROVIDER_IDS.includes(id), `Expected TEXT_PROVIDER_IDS to include ${id}`);
  }

  assert.equal(isLocalHttpUrl('http://localhost:11434/v1'), true);
  assert.equal(isLocalHttpUrl('http://127.0.0.1:11434/v1'), true);
  assert.equal(isLocalHttpUrl('https://ollama.com/v1'), false);
  assert.equal(isLocalHttpUrl('https://api.deepseek.com'), false);
});

test('resolveVoiceProviderConfig resolves gemini defaults, openai realtime, none, and rejects unknown providers', () => {
  const gem = resolveVoiceProviderConfig({ GEMINI_API_KEY: 'g-key' });
  assert.equal(gem.provider, 'gemini');
  assert.equal(gem.model, 'gemini-3.8-live');
  assert.equal(gem.apiKey, 'g-key');
  assert.equal(gem.voiceName, 'Aoede');

  const oai = resolveVoiceProviderConfig({
    AI_VOICE_PROVIDER: 'openai',
    OPENAI_API_KEY: 'oai-key',
    AI_VOICE_NAME: 'cedar',
  });
  assert.equal(oai.provider, 'openai');
  assert.equal(oai.model, 'gpt-realtime-2.1');
  assert.equal(oai.baseUrl, 'wss://api.openai.com/v1/realtime');
  assert.equal(oai.apiKey, 'oai-key');
  assert.equal(oai.voiceName, 'cedar');

  const none = resolveVoiceProviderConfig({ AI_VOICE_PROVIDER: 'none' });
  assert.equal(none.provider, 'none');
  assert.equal(none.apiKey, '');

  assert.throws(() => resolveVoiceProviderConfig({ AI_VOICE_PROVIDER: 'unknown-voice' }), /AI_VOICE_PROVIDER/);
  assert.throws(() => resolveVoiceProviderConfig({ AI_VOICE_PROVIDER: 'openai' }), /OPENAI_API_KEY/);
});

test('resolveTextProviderConfig handles all presets, local vs cloud ollama, and anthropic/openrouter/groq/xai', () => {
  const ds = resolveTextProviderConfig({ AI_TEXT_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'ds-key' });
  assert.equal(ds.protocol, 'openai-compatible');
  assert.equal(ds.baseUrl, 'https://api.deepseek.com');
  assert.equal(ds.model, 'deepseek-v4-flash');
  assert.equal(ds.apiKey, 'ds-key');

  const localOllama = resolveTextProviderConfig({ AI_TEXT_PROVIDER: 'ollama' });
  assert.equal(localOllama.protocol, 'openai-compatible');
  assert.equal(localOllama.baseUrl, 'http://localhost:11434/v1');
  assert.equal(localOllama.model, 'qwen3:8b');
  assert.equal(localOllama.apiKey, '');

  assert.throws(
    () => resolveTextProviderConfig({ AI_TEXT_PROVIDER: 'ollama', OLLAMA_BASE_URL: 'https://ollama.com/v1' }),
    /OLLAMA_API_KEY|AI_TEXT_API_KEY/
  );
  const cloudOllama = resolveTextProviderConfig({
    AI_TEXT_PROVIDER: 'ollama',
    OLLAMA_BASE_URL: 'https://ollama.com/v1/',
    OLLAMA_API_KEY: 'ol-cloud-key',
  });
  assert.equal(cloudOllama.baseUrl, 'https://ollama.com/v1');
  assert.equal(cloudOllama.apiKey, 'ol-cloud-key');

  const claude = resolveTextProviderConfig({ AI_TEXT_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'ant-key' });
  assert.equal(claude.protocol, 'anthropic');
  assert.equal(claude.baseUrl, 'https://api.anthropic.com');
  assert.equal(claude.model, 'claude-sonnet-4-5');

  const groq = resolveTextProviderConfig({ AI_TEXT_PROVIDER: 'groq', GROQ_API_KEY: 'gq-key' });
  assert.equal(groq.baseUrl, 'https://api.groq.com/openai/v1');

  const xai = resolveTextProviderConfig({ AI_TEXT_PROVIDER: 'xai', XAI_API_KEY: 'xai-key' });
  assert.equal(xai.baseUrl, 'https://api.x.ai/v1');
  assert.equal(xai.model, 'grok-4.7');

  const router = resolveTextProviderConfig({ AI_TEXT_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'or-key' });
  assert.equal(router.baseUrl, 'https://openrouter.ai/api/v1');

  assert.throws(
    () => resolveTextProviderConfig({ AI_TEXT_PROVIDER: 'openai-compatible', AI_TEXT_BASE_URL: 'http://192.168.1.50:8000/v1' }),
    /AI_TEXT_MODEL/
  );
  const customCompat = resolveTextProviderConfig({
    AI_TEXT_PROVIDER: 'openai-compatible',
    AI_TEXT_BASE_URL: 'http://127.0.0.1:8080/v1/',
    AI_TEXT_MODEL: 'my-local-model',
  });
  assert.equal(customCompat.baseUrl, 'http://127.0.0.1:8080/v1');
  assert.equal(customCompat.model, 'my-local-model');
});

function createFakeWsFactory() {
  const created = [];
  class FakeWebSocket {
    constructor(url, opts) {
      this.url = url;
      this.opts = opts;
      this.readyState = 0;
      this.sent = [];
      this.closeCount = 0;
      this.handlers = new Map();
      created.push(this);
    }
    on(event, fn) {
      if (!this.handlers.has(event)) {
        this.handlers.set(event, []);
      }
      this.handlers.get(event).push(fn);
    }
    emit(event, ...args) {
      for (const fn of this.handlers.get(event) || []) {
        fn(...args);
      }
    }
    send(payload) {
      this.sent.push(JSON.parse(payload));
    }
    close() {
      this.closeCount += 1;
      this.readyState = 3;
      this.emit('close', 1000, Buffer.from('done'));
    }
  }
  return { FakeWebSocket, created };
}

test('startOpenAIRealtimeSession connects GA Realtime without OpenAI-Beta, resamples audio, handles tools & barge-in', async () => {
  const { FakeWebSocket, created } = createFakeWsFactory();
  const audioChunks = [];
  let interrupted = 0;
  let closed = 0;
  const toolCalls = [];

  const sessionPromise = startOpenAIRealtimeSession(
    {
      config: {
        assistantName: 'Veko',
        aiVoice: {
          provider: 'openai',
          model: 'gpt-realtime-2.1',
          baseUrl: 'wss://api.openai.com/v1/realtime',
          apiKey: 'oai-test-key',
          voiceName: 'cedar',
        },
      },
      customerContext: {
        customerName: 'Ahmet',
        customerPhone: '905551110003',
        chatId: '905551110003@c.us',
        triggerMessage: 'Fiyat nedir?',
      },
      toolExecutor: async (name, args) => {
        toolCalls.push({ name, args });
        if (name === 'boom') {
          throw new Error('Tool crashed');
        }
        return { ok: true, count: 2 };
      },
      onAudioChunk: (b64, mime) => audioChunks.push({ b64, mime }),
      onInterrupted: () => {
        interrupted += 1;
      },
      onClose: () => {
        closed += 1;
      },
    },
    { WebSocket: FakeWebSocket }
  );

  const ws = created[0];
  assert.equal(ws.url, 'wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1');
  assert.equal(ws.opts.headers.Authorization, 'Bearer oai-test-key');
  assert.equal('OpenAI-Beta' in ws.opts.headers, false);

  ws.readyState = 1;
  ws.emit('open');
  const handle = await sessionPromise;

  // Initial GA session.update + greeting item + response.create
  assert.equal(ws.sent[0].type, 'session.update');
  assert.equal(ws.sent[0].session.type, 'realtime');
  assert.equal(ws.sent[0].session.audio.input.format.rate, 24000);
  assert.equal(ws.sent[0].session.audio.output.voice, 'cedar');
  const sendTool = ws.sent[0].session.tools.find((t) => t.name === 'send_whatsapp_message');
  assert.equal(sendTool.type, 'function');
  assert.equal(sendTool.parameters.type, 'object');
  assert.equal(sendTool.parameters.properties.ownerConfirmed.type, 'boolean');

  assert.equal(ws.sent[1].type, 'conversation.item.create');
  assert.equal(ws.sent[2].type, 'response.create');

  // 16kHz -> 24kHz input audio resampling
  const samples16k = new Int16Array(160);
  samples16k.fill(1200);
  handle.sendOwnerAudio(int16ToBase64(samples16k));
  const appendEvt = ws.sent.find((m) => m.type === 'input_audio_buffer.append');
  assert.ok(appendEvt);
  const resampledSamples = base64ToInt16Safely(appendEvt.audio);
  assert.equal(resampledSamples.length, 240);

  // Server GA audio delta + VAD barge-in
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'response.output_audio.delta', delta: 'AQID' })));
  assert.deepEqual(audioChunks, [{ b64: 'AQID', mime: 'audio/pcm;rate=24000' }]);

  ws.emit('message', Buffer.from(JSON.stringify({ type: 'input_audio_buffer.speech_started' })));
  assert.equal(interrupted, 1);

  // Tool call lifecycle within an active response
  ws.sent.length = 0;
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'response.created', response: { id: 'resp-1' } })));
  ws.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        type: 'response.function_call_arguments.done',
        call_id: 'call-1',
        name: 'search_contacts',
        arguments: '{"query":"Eren"}',
      })
    )
  );
  ws.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        type: 'response.function_call_arguments.done',
        call_id: 'call-2',
        name: 'boom',
        arguments: '{}',
      })
    )
  );
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'response.done', response: { id: 'resp-1', output: [] } })));

  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(toolCalls, [
    { name: 'search_contacts', args: { query: 'Eren' } },
    { name: 'boom', args: {} },
  ]);
  const outputs = ws.sent.filter((m) => m.type === 'conversation.item.create');
  assert.equal(outputs.length, 2);
  assert.equal(outputs[0].item.type, 'function_call_output');
  assert.equal(outputs[0].item.call_id, 'call-1');
  assert.deepEqual(JSON.parse(outputs[0].item.output), { ok: true, count: 2 });
  assert.deepEqual(JSON.parse(outputs[1].item.output), { ok: false, error: 'Tool crashed' });
  assert.equal(ws.sent.filter((m) => m.type === 'response.create').length, 1);

  // Close is idempotent & stops future audio
  const sentBeforeClose = ws.sent.length;
  handle.close();
  handle.close();
  handle.sendOwnerAudio(int16ToBase64(samples16k));
  assert.equal(ws.closeCount, 1);
  assert.equal(closed, 1);
  assert.equal(ws.sent.length, sentBeforeClose);
});

test('startOpenAIRealtimeSession sends OpenAI-Beta header and beta session payload for preview models', async () => {
  const { FakeWebSocket, created } = createFakeWsFactory();
  const audioChunks = [];

  const sessionPromise = startOpenAIRealtimeSession(
    {
      config: {
        assistantName: 'Veko',
        aiVoice: {
          provider: 'openai',
          model: 'gpt-4o-realtime-preview',
          baseUrl: 'wss://api.openai.com/v1/realtime',
          apiKey: 'oai-preview-key',
          voiceName: 'alloy',
        },
      },
      onAudioChunk: (b64, mime) => audioChunks.push({ b64, mime }),
    },
    { WebSocket: FakeWebSocket }
  );

  const ws = created[0];
  assert.equal(ws.opts.headers['OpenAI-Beta'], 'realtime=v1');
  ws.readyState = 1;
  ws.emit('open');
  const handle = await sessionPromise;

  assert.equal(ws.sent[0].type, 'session.update');
  assert.deepEqual(ws.sent[0].session.modalities, ['text', 'audio']);
  assert.equal(ws.sent[0].session.input_audio_format, 'pcm16');

  ws.emit('message', Buffer.from(JSON.stringify({ type: 'response.audio.delta', delta: 'BETA==' })));
  assert.deepEqual(audioChunks, [{ b64: 'BETA==', mime: 'audio/pcm;rate=24000' }]);
  handle.close();
});

test('startVoiceSession dispatches gemini, openai, and rejects when voice provider is none', async () => {
  const calls = [];
  const fakeHandle = { sendOwnerAudio() {}, close() {} };

  const gemHandle = await startVoiceSession(
    { config: { aiVoice: { provider: 'gemini', apiKey: 'g', model: 'gemini-3.8-live', voiceName: 'Aoede' } } },
    {
      startGeminiLiveSession: async (args) => {
        calls.push({ kind: 'gemini', args });
        return fakeHandle;
      },
      startOpenAIRealtimeSession: async () => {
        throw new Error('should not call openai');
      },
    }
  );
  assert.equal(gemHandle, fakeHandle);
  assert.equal(calls[0].kind, 'gemini');
  assert.equal(calls[0].args.config.geminiApiKey, 'g');

  const oaiHandle = await startVoiceSession(
    { config: { aiVoice: { provider: 'openai', apiKey: 'o', model: 'gpt-realtime-2.1', voiceName: 'cedar' } } },
    {
      startGeminiLiveSession: async () => {
        throw new Error('should not call gemini');
      },
      startOpenAIRealtimeSession: async (args) => {
        calls.push({ kind: 'openai', args });
        return fakeHandle;
      },
    }
  );
  assert.equal(oaiHandle, fakeHandle);
  assert.equal(calls[1].kind, 'openai');

  await assert.rejects(
    () => startVoiceSession({ config: { aiVoice: { provider: 'none' } } }),
    /disabled|none/i
  );
});

function createTextTestEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpj-text-chat-'));
  const store = createStateStore(path.join(dir, 'state.json'));
  const sent = [];
  const whatsapp = {
    async scanCustomerChats() {
      return {
        customers: [
          { chatId: '905551110001@c.us', name: 'Ali', phone: '905551110001', isNew: true, messageCountInRange: 2 },
        ],
        scannedChats: 1,
        skippedByPreFilter: 0,
        excludedCount: 0,
        truncated: false,
      };
    },
    async searchContacts() { return []; },
    async fetchChatHistory() { return []; },
    async listRecentChats() { return []; },
    async sendMessage(chatId, text) {
      sent.push({ chatId, text });
      return { id: `sent-${sent.length}` };
    },
  };
  const baseConfig = {
    assistantName: 'Veko',
    assistantStyle: '',
    ownerChatId: '905321112233@c.us',
    ownerPhone: '905321112233',
  };
  return { store, sent, whatsapp, config: baseConfig };
}

test('buildTextSystemInstruction injects IST time, Veko identity, pending draft verbatim rule, and trust boundaries', () => {
  const instr = buildTextSystemInstruction({
    assistantName: 'Veko',
    nowMs: Date.parse('2026-11-13T14:30:00+03:00'),
    pendingDraft: {
      chatId: '905551110001@c.us',
      recipientName: 'Ali',
      messageText: 'Fiyat 5000 TL',
      proposedAt: 1000,
      proposedInTurnId: 'turn-1',
    },
  });
  assert.match(instr, /Veko/);
  assert.match(instr, /Europe\/Istanbul|14:30|Kasım/i);
  assert.match(instr, /905551110001@c\.us/);
  assert.match(instr, /Fiyat 5000 TL/);
  assert.match(instr, /clear_pending_draft/);
});

test('runOwnerTextTurn gemini protocol preserves thoughtSignature and functionCall id across tool rounds', async () => {
  const { store, whatsapp, config } = createTextTestEnv();
  store.appendOwnerChatMessage({ role: 'system', content: '[Sistem Bildirimi] Ali mesaj attı', timestamp: 1000 });

  const capturedCalls = [];
  class FakeGoogleGenAI {
    constructor(opts) {
      this.apiKey = opts.apiKey;
      this.models = {
        generateContent: async (req) => {
          capturedCalls.push(JSON.parse(JSON.stringify(req)));
          if (capturedCalls.length === 1) {
            return {
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [
                      {
                        functionCall: { id: 'fc-gem-1', name: 'get_customer_stats', args: { period: 'today' } },
                        thoughtSignature: 'sig-xyz-999',
                      },
                    ],
                  },
                },
              ],
            };
          }
          return {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [{ text: 'Bugün 1 yeni müşteri mesaj attı (Ali).' }],
                },
              },
            ],
          };
        },
      };
    }
  }

  const res = await runOwnerTextTurn(
    {
      config: { ...config, aiText: { provider: 'gemini', protocol: 'gemini', apiKey: 'gem-key', model: 'gemini-3.8-flash' } },
      store,
      whatsapp,
      ownerMessage: 'Bugün kaç müşteri geldi?',
      turnId: 't-gem-1',
    },
    { GoogleGenAI: FakeGoogleGenAI }
  );

  assert.equal(res.ok, true);
  assert.equal(res.text, 'Bugün 1 yeni müşteri mesaj attı (Ali).');
  assert.equal(capturedCalls.length, 2);

  // Round 2 must preserve candidate.content with thoughtSignature & functionResponse.id
  const round2Contents = capturedCalls[1].contents;
  const modelPart = round2Contents.find((c) => c.role === 'model')?.parts[0];
  assert.equal(modelPart.thoughtSignature, 'sig-xyz-999');
  const fnResp = round2Contents[round2Contents.length - 1].parts[0].functionResponse;
  assert.equal(fnResp.id, 'fc-gem-1');
  assert.equal(fnResp.name, 'get_customer_stats');
  assert.equal(fnResp.response.uniqueCustomers, 1);

  const savedHist = store.getOwnerChatHistory();
  assert.equal(savedHist[savedHist.length - 2].content, 'Bugün kaç müşteri geldi?');
  assert.equal(savedHist[savedHist.length - 1].content, 'Bugün 1 yeni müşteri mesaj attı (Ali).');
});

test('runOwnerTextTurn supports openai-compatible DeepSeek and keyless local Ollama tool-calling loops', async () => {
  const { store, whatsapp, config } = createTextTestEnv();
  const requests = [];

  const fakeFetch = async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    if (requests.length === 1) {
      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_ds_1',
                      type: 'function',
                      function: { name: 'get_customer_stats', arguments: '{"period":"this_month"}' },
                    },
                  ],
                },
              },
            ],
          };
        },
      };
    }
    return {
      ok: true,
      async json() {
        return {
          choices: [{ message: { role: 'assistant', content: 'Bu ay 1 müşteri yazdı.' } }],
        };
      },
    };
  };

  // 1. DeepSeek (with Bearer key)
  const dsRes = await runOwnerTextTurn(
    {
      config: {
        ...config,
        aiText: {
          provider: 'deepseek',
          protocol: 'openai-compatible',
          apiKey: 'ds-secret',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-v4-flash',
        },
      },
      store,
      whatsapp,
      ownerMessage: 'Bu ay kaç müşteri?',
      turnId: 't-ds-1',
    },
    { fetch: fakeFetch }
  );
  assert.equal(dsRes.ok, true);
  assert.equal(dsRes.text, 'Bu ay 1 müşteri yazdı.');
  assert.equal(requests[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(requests[0].headers.Authorization, 'Bearer ds-secret');
  const toolReply = requests[1].body.messages.find((m) => m.role === 'tool');
  assert.equal(toolReply.tool_call_id, 'call_ds_1');

  // 2. Local Ollama (no apiKey -> NO Authorization header!)
  requests.length = 0;
  const ollamaFetch = async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { role: 'assistant', content: 'Yerel Ollama hazır!' } }] };
      },
    };
  };
  const olRes = await runOwnerTextTurn(
    {
      config: {
        ...config,
        aiText: {
          provider: 'ollama',
          protocol: 'openai-compatible',
          apiKey: '',
          baseUrl: 'http://localhost:11434/v1',
          model: 'qwen3:8b',
        },
      },
      store,
      whatsapp,
      ownerMessage: 'Merhaba',
      turnId: 't-ol-1',
    },
    { fetch: ollamaFetch }
  );
  assert.equal(olRes.ok, true);
  assert.equal(requests[0].url, 'http://localhost:11434/v1/chat/completions');
  assert.equal('Authorization' in requests[0].headers, false);
});

test('runOwnerTextTurn supports Anthropic /v1/messages, enforces 8-round bound, and returns Turkish fallback on error', async () => {
  const { store, whatsapp, config } = createTextTestEnv();
  const requests = [];

  const anthropicFetch = async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    if (requests.length === 1) {
      return {
        ok: true,
        async json() {
          return {
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_customer_stats', input: { period: 'today' } }],
          };
        },
      };
    }
    return {
      ok: true,
      async json() {
        return { content: [{ type: 'text', text: 'Claude üzerinden özet: 1 müşteri.' }] };
      },
    };
  };

  const antRes = await runOwnerTextTurn(
    {
      config: {
        ...config,
        aiText: {
          provider: 'anthropic',
          protocol: 'anthropic',
          apiKey: 'ant-key',
          baseUrl: 'https://api.anthropic.com',
          model: 'claude-sonnet-4-5',
        },
      },
      store,
      whatsapp,
      ownerMessage: 'Bugün?',
      turnId: 't-ant-1',
    },
    { fetch: anthropicFetch }
  );
  assert.equal(antRes.ok, true);
  assert.equal(antRes.text, 'Claude üzerinden özet: 1 müşteri.');
  assert.equal(requests[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(requests[0].headers['x-api-key'], 'ant-key');
  assert.equal(requests[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(requests[1].body.messages.at(-1).content[0].type, 'tool_result');
  assert.equal(requests[1].body.messages.at(-1).content[0].tool_use_id, 'toolu_1');

  // 8-round bound test
  let rounds = 0;
  const infiniteToolFetch = async () => {
    rounds += 1;
    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: `c_${rounds}`, type: 'function', function: { name: 'list_recent_chats', arguments: '{}' } }],
              },
            },
          ],
        };
      },
    };
  };
  const boundRes = await runOwnerTextTurn(
    {
      config: {
        ...config,
        aiText: { provider: 'openai', protocol: 'openai-compatible', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5' },
      },
      store,
      whatsapp,
      ownerMessage: 'Döngü test',
      turnId: 't-bound',
    },
    { fetch: infiniteToolFetch }
  );
  assert.equal(rounds, 8);
  assert.equal(boundRes.ok, false);
  assert.match(boundRes.text, /sınır|adım/i);

  // Network/API error returns clean Turkish fallback without crashing
  const errRes = await runOwnerTextTurn(
    {
      config: {
        ...config,
        aiText: { provider: 'openai', protocol: 'openai-compatible', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5' },
      },
      store,
      whatsapp,
      ownerMessage: 'Hata test',
      turnId: 't-err',
    },
    {
      fetch: async () => ({
        ok: false,
        status: 503,
        async text() {
          return 'Service Unavailable';
        },
      }),
    }
  );
  assert.equal(errRes.ok, false);
  assert.match(errRes.text, /geçici.*sorun|tekrar|ara/i);
});

test('review fixes: aiVoiceApiKey precedence, OpenAI ignores Gemini TTS_VOICE_NAME, BEKLEYEN_TASLAK shows ucuncu_taraf, realtime closeSession notifies onClose when closed', async () => {
  // 1. OpenAI voice config ignores Gemini-only TTS_VOICE_NAME ('Aoede') unless AI_VOICE_NAME is set
  const oaiNoExplicit = resolveVoiceProviderConfig({
    AI_VOICE_PROVIDER: 'openai',
    OPENAI_API_KEY: 'oai-key',
    TTS_VOICE_NAME: 'Aoede',
  });
  assert.equal(oaiNoExplicit.voiceName, 'cedar');

  const oaiExplicit = resolveVoiceProviderConfig({
    AI_VOICE_PROVIDER: 'openai',
    OPENAI_API_KEY: 'oai-key',
    TTS_VOICE_NAME: 'Aoede',
    AI_VOICE_NAME: 'alloy',
  });
  assert.equal(oaiExplicit.voiceName, 'alloy');

  // 2. startVoiceSession prioritizes aiVoiceApiKey over geminiApiKey / openaiApiKey
  let gemSeenKey = '';
  let oaiSeenKey = '';
  await startVoiceSession(
    {
      config: {
        aiVoiceProvider: 'gemini',
        aiVoiceApiKey: 'voice-override-gem',
        geminiApiKey: 'fallback-gem',
      },
    },
    {
      startGeminiLiveSession: async ({ config }) => {
        gemSeenKey = config.geminiApiKey;
        return { sendOwnerAudio() {}, close() {} };
      },
    }
  );
  assert.equal(gemSeenKey, 'voice-override-gem');

  await startVoiceSession(
    {
      config: {
        aiVoiceProvider: 'openai',
        aiVoiceApiKey: 'voice-override-oai',
        openaiApiKey: 'fallback-oai',
      },
    },
    {
      startOpenAIRealtimeSession: async ({ config }) => {
        oaiSeenKey = config.aiVoice?.apiKey || config.openaiApiKey;
        return { sendOwnerAudio() {}, close() {} };
      },
    }
  );
  assert.equal(oaiSeenKey, 'voice-override-oai');

  // 3. <BEKLEYEN_TASLAK> includes ucuncu_taraf flag
  const sysThirdParty = buildTextSystemInstruction({
    assistantName: 'Veko',
    pendingDraft: {
      chatId: '905552223344@c.us',
      recipientName: 'Usta',
      messageText: 'Müsait misiniz?',
      isThirdParty: true,
    },
  });
  assert.match(sysThirdParty, /<BEKLEYEN_TASLAK>[\s\S]*ucuncu_taraf: evet[\s\S]*<\/BEKLEYEN_TASLAK>/);

  const sysCustomer = buildTextSystemInstruction({
    assistantName: 'Veko',
    pendingDraft: {
      chatId: '905551110008@c.us',
      recipientName: 'Müşteri',
      messageText: 'Hemen bilgi verelim',
      isThirdParty: false,
    },
  });
  assert.match(sysCustomer, /<BEKLEYEN_TASLAK>[\s\S]*ucuncu_taraf: hayir[\s\S]*<\/BEKLEYEN_TASLAK>/);

  // 4. OpenAI Realtime closeSession triggers onClose if socket is already CLOSED (readyState === 3)
  let closedEvents = 0;
  class AlreadyClosingWs {
    constructor() {
      this.handlers = new Map();
      this.readyState = 1;
      queueMicrotask(() => {
        const openFn = this.handlers.get('open');
        if (openFn) openFn();
      });
    }
    on(evt, fn) {
      this.handlers.set(evt, fn);
    }
    send() {}
    close() {
      // Simulate silent no-op after close without emitting 'close'
    }
  }
  const rtSession = await startOpenAIRealtimeSession(
    {
      config: { openaiApiKey: 'oai-test' },
      onClose: () => {
        closedEvents += 1;
      },
    },
    { WebSocket: AlreadyClosingWs }
  );
  // Flip WebSocket readyState to 3 via throwing/closed path check
  const wsClosedInstance = {
    handlers: new Map(),
    readyState: 3,
    on(evt, fn) {
      this.handlers.set(evt, fn);
    },
    send() {},
    close() {},
  };
  const rtSessionClosed = await startOpenAIRealtimeSession(
    {
      config: { openaiApiKey: 'oai-test' },
      onClose: () => {
        closedEvents += 1;
      },
    },
    {
      WebSocket: class {
        constructor() {
          queueMicrotask(() => {
            const openFn = wsClosedInstance.handlers.get('open');
            wsClosedInstance.readyState = 1;
            if (openFn) openFn();
            wsClosedInstance.readyState = 3;
          });
          return wsClosedInstance;
        }
      },
    }
  );
  rtSession.close();
  rtSessionClosed.close();
  assert.equal(closedEvents, 1);
});
