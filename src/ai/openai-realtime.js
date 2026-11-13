import WebSocket from 'ws';
import { TOOL_DECLARATIONS } from './tools.js';
import { buildInitialGreetingPrompt, buildSystemInstruction } from './live-session.js';
import { base64ToInt16Safely, int16ToBase64, resamplePcm16 } from '../whatsapp/pcm.js';

const OPENAI_REALTIME_INPUT_RATE = 24000;
const WHATSAPP_PCM_INPUT_RATE = 16000;
const OPENAI_REALTIME_OUTPUT_MIME = 'audio/pcm;rate=24000';

/**
 * Converts a Gemini `@google/genai` Schema object into standard JSON Schema
 * (lowercase types) suitable for OpenAI, Anthropic, and OpenAI-compatible APIs.
 *
 * @param {object} schema
 * @returns {object}
 */
export function geminiSchemaToJsonSchema(schema) {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} };
  }

  const out = {};
  if (schema.type !== undefined) {
    out.type = String(schema.type).toLowerCase();
  }
  if (typeof schema.description === 'string') {
    out.description = schema.description;
  }
  if (Array.isArray(schema.enum)) {
    out.enum = [...schema.enum];
  }
  if (Array.isArray(schema.required)) {
    out.required = [...schema.required];
  }
  if (schema.properties && typeof schema.properties === 'object') {
    out.properties = {};
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      out.properties[key] = geminiSchemaToJsonSchema(propSchema);
    }
  }
  if (schema.items && typeof schema.items === 'object') {
    out.items = geminiSchemaToJsonSchema(schema.items);
  }
  return out;
}

/**
 * Converts Gemini `TOOL_DECLARATIONS` into OpenAI Realtime function tool descriptors.
 *
 * @param {Array<object>} [declarations]
 * @returns {Array<object>}
 */
export function toOpenAIRealtimeTools(declarations = TOOL_DECLARATIONS) {
  return declarations.map((decl) => ({
    type: 'function',
    name: decl.name,
    description: decl.description,
    parameters: geminiSchemaToJsonSchema(decl.parameters),
  }));
}

function buildRealtimeWsUrl(baseUrl, model) {
  const cleanBase = String(baseUrl || 'wss://api.openai.com/v1/realtime').replace(/\/+$/, '');
  const sep = cleanBase.includes('?') ? '&' : '?';
  return `${cleanBase}${sep}model=${encodeURIComponent(model)}`;
}

function safeParseJson(raw) {
  try {
    return JSON.parse(String(raw ?? ''));
  } catch {
    return null;
  }
}

export function parseToolArgs(rawArgs) {
  if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    return { ok: true, value: rawArgs };
  }
  if (typeof rawArgs !== 'string' || !rawArgs.trim()) {
    return { ok: true, value: {} };
  }
  try {
    const parsed = JSON.parse(rawArgs);
    return {
      ok: true,
      value: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {},
    };
  } catch (err) {
    return { ok: false, error: err?.message || 'Invalid tool arguments JSON' };
  }
}

/**
 * Opens an OpenAI Realtime API WebSocket voice session (supporting both GA and
 * `-preview` beta protocols) with 16kHz <-> 24kHz PCM16 resampling and tool execution.
 *
 * @param {object} options
 * @param {object} [deps]
 * @returns {Promise<{ sendOwnerAudio: (b64: string) => void, close: () => void }>}
 */
export async function startOpenAIRealtimeSession(
  {
    config = {},
    customerContext = {},
    history = [],
    callContext = {},
    toolExecutor,
    onAudioChunk,
    onInterrupted,
    onError,
    onClose,
  } = {},
  deps = {}
) {
  const WebSocketImpl = deps.WebSocket || WebSocket;
  const aiVoice = config.aiVoice && typeof config.aiVoice === 'object' ? config.aiVoice : {};

  const apiKey = String(aiVoice.apiKey || config.openaiApiKey || config.aiVoiceApiKey || '').trim();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY (or AI_VOICE_API_KEY) is required for OpenAI Realtime voice sessions.');
  }

  const model = String(aiVoice.model || config.aiVoiceModel || config.openaiRealtimeModel || 'gpt-realtime-2.1').trim();
  const baseUrl = String(aiVoice.baseUrl || config.aiVoiceBaseUrl || 'wss://api.openai.com/v1/realtime').trim();
  const voiceName = String(aiVoice.voiceName || config.aiVoiceName || config.ttsVoiceName || 'cedar').trim() || 'cedar';
  const assistantName = String(config.assistantName || 'Veko').trim() || 'Veko';
  const assistantStyle = String(config.assistantStyle || '').trim();
  const isBetaPreview = /preview/i.test(model);

  const effectiveCustomerContext = {
    ...(callContext && typeof callContext === 'object' ? callContext : {}),
    ...(customerContext && typeof customerContext === 'object' ? customerContext : {}),
    ...(Array.isArray(history) && history.length > 0 && !customerContext?.recentHistory && !customerContext?.recentMessages
      ? { recentHistory: history }
      : {}),
  };

  const instructions = buildSystemInstruction(
    { ...config, assistantName, assistantStyle },
    effectiveCustomerContext
  );
  const greetingPrompt = buildInitialGreetingPrompt(
    { ...config, assistantName, assistantStyle },
    effectiveCustomerContext
  );

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    ...(isBetaPreview ? { 'OpenAI-Beta': 'realtime=v1' } : {}),
  };

  const wsUrl = buildRealtimeWsUrl(baseUrl, model);
  const ws = new WebSocketImpl(wsUrl, { headers });

  let opened = false;
  let closed = false;
  let closeNotified = false;
  let activeResponseId = null;
  let responseHadToolCalls = false;
  let inFlightToolPromises = [];
  const handledCallIds = new Set();

  function safeCallback(fn, ...args) {
    if (typeof fn !== 'function') return;
    try {
      const res = fn(...args);
      if (res && typeof res.catch === 'function') {
        res.catch((err) => {
          if (fn !== onError) {
            safeCallback(onError, err);
          }
        });
      }
    } catch (err) {
      if (fn !== onError) {
        safeCallback(onError, err);
      }
    }
  }

  function emitCloseOnce(event) {
    if (closeNotified) return;
    closeNotified = true;
    closed = true;
    safeCallback(onClose, event);
  }

  function sendJson(payload) {
    if (closed || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(payload));
    return true;
  }

  function executeToolCallItem(call) {
    const callId = String(call?.call_id || call?.id || '').trim();
    const name = String(call?.name || '').trim();
    if (!callId || !name || handledCallIds.has(callId)) {
      return Promise.resolve();
    }
    handledCallIds.add(callId);

    const execPromise = (async () => {
      let response;
      const parsed = parseToolArgs(call?.arguments);
      if (!parsed.ok) {
        response = { ok: false, error: parsed.error };
      } else if (typeof toolExecutor !== 'function') {
        response = { ok: false, error: 'No toolExecutor configured' };
      } else {
        try {
          response = await toolExecutor(name, parsed.value);
        } catch (err) {
          response = { ok: false, error: err?.message || 'Tool execution failed' };
        }
      }

      if (closed) return;
      try {
        sendJson({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: callId,
            output: JSON.stringify(response ?? { ok: true }),
          },
        });
      } catch (err) {
        safeCallback(onError, err);
      }
    })();

    return execPromise;
  }

  function buildSessionUpdatePayload() {
    const tools = toOpenAIRealtimeTools(TOOL_DECLARATIONS);
    const turnDetection = {
      type: 'server_vad',
      threshold: 0.5,
      prefix_padding_ms: 300,
      silence_duration_ms: 500,
    };

    if (isBetaPreview) {
      return {
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions,
          voice: voiceName,
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          tools,
          tool_choice: 'auto',
          turn_detection: turnDetection,
        },
      };
    }

    return {
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions,
        tools,
        tool_choice: 'auto',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: OPENAI_REALTIME_INPUT_RATE },
            turn_detection: turnDetection,
          },
          output: {
            format: { type: 'audio/pcm', rate: OPENAI_REALTIME_INPUT_RATE },
            voice: voiceName,
          },
        },
      },
    };
  }

  function closeSession() {
    if (closed) return;
    closed = true;
    if (ws.readyState === 3 || typeof ws.close !== 'function') {
      if (opened) {
        emitCloseOnce({ code: 1000, reason: 'client_close' });
      }
      return;
    }
    try {
      ws.close();
    } catch {
      if (opened) {
        emitCloseOnce({ code: 1000, reason: 'client_close' });
      }
    }
  }

  function handleServerMessage(raw) {
    if (closed) return;
    const msg = safeParseJson(raw);
    if (!msg || typeof msg !== 'object') return;

    const audioDeltaType = isBetaPreview ? 'response.audio.delta' : 'response.output_audio.delta';
    if (msg.type === audioDeltaType && typeof msg.delta === 'string' && msg.delta) {
      safeCallback(onAudioChunk, msg.delta, OPENAI_REALTIME_OUTPUT_MIME);
      return;
    }

    if (msg.type === 'input_audio_buffer.speech_started') {
      safeCallback(onInterrupted);
      return;
    }

    if (msg.type === 'response.created') {
      activeResponseId = msg.response?.id || 'active';
      responseHadToolCalls = false;
      inFlightToolPromises = [];
      return;
    }

    if (msg.type === 'response.function_call_arguments.done') {
      const p = executeToolCallItem(msg);
      if (activeResponseId) {
        responseHadToolCalls = true;
        inFlightToolPromises.push(p);
      } else {
        p.then(() => {
          if (!closed) {
            try {
              sendJson({ type: 'response.create' });
            } catch (err) {
              safeCallback(onError, err);
            }
          }
        });
      }
      return;
    }

    if (msg.type === 'response.done') {
      const outputItems = Array.isArray(msg.response?.output) ? msg.response.output : [];
      for (const item of outputItems) {
        if (item?.type === 'function_call') {
          const callId = String(item.call_id || item.id || '').trim();
          if (callId && !handledCallIds.has(callId)) {
            responseHadToolCalls = true;
            inFlightToolPromises.push(executeToolCallItem(item));
          }
        }
      }

      const pending = [...inFlightToolPromises];
      const shouldCreateNextResponse = responseHadToolCalls;
      activeResponseId = null;
      responseHadToolCalls = false;
      inFlightToolPromises = [];

      if (shouldCreateNextResponse) {
        Promise.all(pending).then(() => {
          if (!closed) {
            try {
              sendJson({ type: 'response.create' });
            } catch (err) {
              safeCallback(onError, err);
            }
          }
        });
      }
      return;
    }

    if (msg.type === 'error') {
      const errMsg = msg.error?.message || JSON.stringify(msg.error || 'OpenAI Realtime error');
      safeCallback(onError, new Error(errMsg));
    }
  }

  await new Promise((resolve, reject) => {
    let settled = false;

    ws.on('open', () => {
      opened = true;
      try {
        sendJson(buildSessionUpdatePayload());
        sendJson({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: greetingPrompt }],
          },
        });
        sendJson({ type: 'response.create' });
        if (!settled) {
          settled = true;
          resolve();
        }
      } catch (err) {
        closeSession();
        if (!settled) {
          settled = true;
          reject(err);
        }
      }
    });

    ws.on('message', handleServerMessage);

    ws.on('error', (err) => {
      const errorObj = err instanceof Error ? err : new Error(err?.message || 'OpenAI Realtime WebSocket error');
      if (!opened && !settled) {
        settled = true;
        closeSession();
        reject(errorObj);
        return;
      }
      safeCallback(onError, errorObj);
    });

    ws.on('close', (code, reason) => {
      const reasonStr = Buffer.isBuffer(reason) ? reason.toString('utf8') : String(reason || '');
      if (!opened && !settled) {
        settled = true;
        closed = true;
        reject(new Error(`OpenAI Realtime closed before open (${code ?? ''}${reasonStr ? `: ${reasonStr}` : ''})`));
        return;
      }
      emitCloseOnce({ code, reason: reasonStr });
    });
  });

  return {
    sendOwnerAudio(base64Pcm16) {
      if (closed || !base64Pcm16 || typeof base64Pcm16 !== 'string') {
        return;
      }
      try {
        const samples16k = base64ToInt16Safely(base64Pcm16);
        if (!samples16k.length) return;
        const samples24k = resamplePcm16(samples16k, WHATSAPP_PCM_INPUT_RATE, OPENAI_REALTIME_INPUT_RATE);
        const audioB64 = int16ToBase64(samples24k);
        if (!audioB64) return;
        sendJson({
          type: 'input_audio_buffer.append',
          audio: audioB64,
        });
      } catch (err) {
        safeCallback(onError, err);
      }
    },
    close: closeSession,
  };
}
