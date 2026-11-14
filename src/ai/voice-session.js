import { startGeminiLiveSession } from './live-session.js';
import { startOpenAIRealtimeSession } from './openai-realtime.js';

const GEMINI_ONLY_VOICES = new Set(['aoede', 'puck', 'charon', 'fenrir', 'kore']);

function resolveOpenAIVoiceName(...candidates) {
  for (const candidate of candidates) {
    const trimmed = String(candidate || '').trim();
    if (trimmed && !GEMINI_ONLY_VOICES.has(trimmed.toLowerCase())) {
      return trimmed;
    }
  }
  return 'cedar';
}

function normalizeVoiceConfig(config = {}) {
  if (config?.aiVoice && typeof config.aiVoice === 'object' && config.aiVoice.provider) {
    const prov = String(config.aiVoice.provider).trim().toLowerCase();
    if (prov === 'openai') {
      return {
        ...config.aiVoice,
        provider: 'openai',
        voiceName: resolveOpenAIVoiceName(
          config.aiVoice.voiceName,
          config?.aiVoiceName,
          config?.ttsVoiceName
        ),
      };
    }
    return config.aiVoice;
  }

  const provider = String(config?.aiVoiceProvider || 'gemini').trim().toLowerCase();
  if (provider === 'none') {
    return { provider: 'none', apiKey: '', model: '', baseUrl: '', voiceName: '' };
  }
  if (provider === 'openai') {
    return {
      provider: 'openai',
      apiKey: String(config?.aiVoiceApiKey || config?.openaiApiKey || '').trim(),
      model: String(config?.aiVoiceModel || config?.openaiRealtimeModel || 'gpt-realtime-2.1').trim(),
      baseUrl: String(config?.aiVoiceBaseUrl || 'wss://api.openai.com/v1/realtime').trim(),
      voiceName: resolveOpenAIVoiceName(config?.aiVoiceName, config?.ttsVoiceName),
    };
  }
  return {
    provider,
    apiKey: String(config?.aiVoiceApiKey || config?.geminiApiKey || '').trim(),
    model: String(config?.aiVoiceModel || config?.geminiLiveModel || 'gemini-3.8-live').trim(),
    baseUrl: '',
    voiceName: String(config?.aiVoiceName || config?.ttsVoiceName || 'Aoede').trim() || 'Aoede',
  };
}

/**
 * Starts a voice session using the configured `AI_VOICE_PROVIDER` (`gemini` or `openai`).
 *
 * @param {object} params
 * @param {object} [deps]
 * @returns {Promise<{ sendOwnerAudio: (b64: string) => void, close: () => void }>}
 */
export async function startVoiceSession(params = {}, deps = {}) {
  const voiceConfig = normalizeVoiceConfig(params.config);
  const geminiRunner = deps.startGeminiLiveSession || startGeminiLiveSession;
  const openaiRunner = deps.startOpenAIRealtimeSession || startOpenAIRealtimeSession;

  if (voiceConfig.provider === 'none') {
    throw new Error('Voice AI provider is disabled (AI_VOICE_PROVIDER=none).');
  }

  if (voiceConfig.provider === 'gemini') {
    const mergedConfig = {
      ...params.config,
      geminiApiKey: voiceConfig.apiKey || params.config?.geminiApiKey || '',
      geminiLiveModel: voiceConfig.model || params.config?.geminiLiveModel || 'gemini-3.8-live',
      ttsVoiceName: voiceConfig.voiceName || params.config?.ttsVoiceName || 'Aoede',
    };
    return geminiRunner({ ...params, config: mergedConfig }, deps);
  }

  if (voiceConfig.provider === 'openai') {
    const mergedConfig = {
      ...params.config,
      aiVoice: voiceConfig,
    };
    return openaiRunner({ ...params, config: mergedConfig }, deps);
  }

  throw new Error(`Unsupported voice AI provider: ${voiceConfig.provider}`);
}
