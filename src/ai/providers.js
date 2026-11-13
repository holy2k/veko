/**
 * Registry and configuration resolver for supported voice and text AI providers.
 * Recommended defaults remain Google Gemini (`gemini-3.8-live` voice + `gemini-3.8-flash` text).
 */

export const VOICE_PROVIDER_IDS = Object.freeze(['gemini', 'openai', 'none']);

export const TEXT_PROVIDER_IDS = Object.freeze([
  'gemini',
  'openai',
  'deepseek',
  'ollama',
  'anthropic',
  'openrouter',
  'groq',
  'xai',
  'openai-compatible',
  'none',
]);

const VOICE_PRESETS = Object.freeze({
  gemini: {
    defaultModel: 'gemini-3.8-live',
    defaultVoice: 'Aoede',
    defaultBaseUrl: '',
    modelEnvNames: ['AI_VOICE_MODEL', 'GEMINI_LIVE_MODEL'],
    keyEnvNames: ['AI_VOICE_API_KEY', 'GEMINI_API_KEY'],
    baseUrlEnvNames: ['AI_VOICE_BASE_URL'],
  },
  openai: {
    defaultModel: 'gpt-realtime-2.1',
    defaultVoice: 'cedar',
    defaultBaseUrl: 'wss://api.openai.com/v1/realtime',
    modelEnvNames: ['AI_VOICE_MODEL', 'OPENAI_REALTIME_MODEL'],
    keyEnvNames: ['AI_VOICE_API_KEY', 'OPENAI_API_KEY'],
    baseUrlEnvNames: ['AI_VOICE_BASE_URL'],
  },
  none: {
    defaultModel: '',
    defaultVoice: '',
    defaultBaseUrl: '',
    modelEnvNames: [],
    keyEnvNames: [],
    baseUrlEnvNames: [],
  },
});

const TEXT_PRESETS = Object.freeze({
  gemini: {
    protocol: 'gemini',
    defaultModel: 'gemini-3.8-flash',
    defaultBaseUrl: '',
    keyPolicy: 'always',
    modelEnvNames: ['AI_TEXT_MODEL', 'GEMINI_TEXT_MODEL'],
    keyEnvNames: ['AI_TEXT_API_KEY', 'GEMINI_API_KEY'],
    baseUrlEnvNames: ['AI_TEXT_BASE_URL'],
  },
  openai: {
    protocol: 'openai-compatible',
    defaultModel: 'gpt-4o',
    defaultBaseUrl: 'https://api.openai.com/v1',
    keyPolicy: 'always',
    modelEnvNames: ['AI_TEXT_MODEL'],
    keyEnvNames: ['AI_TEXT_API_KEY', 'OPENAI_API_KEY'],
    baseUrlEnvNames: ['AI_TEXT_BASE_URL'],
  },
  deepseek: {
    protocol: 'openai-compatible',
    defaultModel: 'deepseek-v4-flash',
    defaultBaseUrl: 'https://api.deepseek.com',
    keyPolicy: 'always',
    modelEnvNames: ['AI_TEXT_MODEL'],
    keyEnvNames: ['AI_TEXT_API_KEY', 'DEEPSEEK_API_KEY'],
    baseUrlEnvNames: ['AI_TEXT_BASE_URL'],
  },
  ollama: {
    protocol: 'openai-compatible',
    defaultModel: 'qwen3:8b',
    defaultBaseUrl: 'http://localhost:11434/v1',
    keyPolicy: 'remote_only',
    modelEnvNames: ['AI_TEXT_MODEL', 'OLLAMA_MODEL'],
    keyEnvNames: ['AI_TEXT_API_KEY', 'OLLAMA_API_KEY'],
    baseUrlEnvNames: ['OLLAMA_BASE_URL', 'AI_TEXT_BASE_URL'],
  },
  anthropic: {
    protocol: 'anthropic',
    defaultModel: 'claude-sonnet-4-5',
    defaultBaseUrl: 'https://api.anthropic.com',
    keyPolicy: 'always',
    modelEnvNames: ['AI_TEXT_MODEL'],
    keyEnvNames: ['AI_TEXT_API_KEY', 'ANTHROPIC_API_KEY'],
    baseUrlEnvNames: ['AI_TEXT_BASE_URL'],
  },
  openrouter: {
    protocol: 'openai-compatible',
    defaultModel: 'openai/gpt-4o-mini',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    keyPolicy: 'always',
    modelEnvNames: ['AI_TEXT_MODEL'],
    keyEnvNames: ['AI_TEXT_API_KEY', 'OPENROUTER_API_KEY'],
    baseUrlEnvNames: ['AI_TEXT_BASE_URL'],
  },
  groq: {
    protocol: 'openai-compatible',
    defaultModel: 'llama-3.3-70b-versatile',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    keyPolicy: 'always',
    modelEnvNames: ['AI_TEXT_MODEL'],
    keyEnvNames: ['AI_TEXT_API_KEY', 'GROQ_API_KEY'],
    baseUrlEnvNames: ['AI_TEXT_BASE_URL'],
  },
  xai: {
    protocol: 'openai-compatible',
    defaultModel: 'grok-4.7',
    defaultBaseUrl: 'https://api.x.ai/v1',
    keyPolicy: 'always',
    modelEnvNames: ['AI_TEXT_MODEL'],
    keyEnvNames: ['AI_TEXT_API_KEY', 'XAI_API_KEY'],
    baseUrlEnvNames: ['AI_TEXT_BASE_URL'],
  },
  'openai-compatible': {
    protocol: 'openai-compatible',
    defaultModel: '',
    defaultBaseUrl: '',
    requireBaseUrl: true,
    requireModel: true,
    keyPolicy: 'never',
    modelEnvNames: ['AI_TEXT_MODEL'],
    keyEnvNames: ['AI_TEXT_API_KEY', 'OPENAI_API_KEY'],
    baseUrlEnvNames: ['AI_TEXT_BASE_URL'],
  },
  none: {
    protocol: 'none',
    defaultModel: '',
    defaultBaseUrl: '',
    keyPolicy: 'never',
    modelEnvNames: [],
    keyEnvNames: [],
    baseUrlEnvNames: [],
  },
});

function pickFirstEnv(env, names) {
  for (const name of names || []) {
    const raw = env?.[name];
    if (typeof raw === 'string' && raw.trim()) {
      return raw.trim();
    }
  }
  return '';
}

function stripTrailingSlashes(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

/**
 * Checks whether an HTTP URL points to loopback/localhost (where local runtimes like Ollama need no API key).
 *
 * @param {string} rawUrl
 * @returns {boolean}
 */
export function isLocalHttpUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(trimmed);
  }
}

/**
 * Resolves and validates voice-call AI provider settings from `env`.
 *
 * @param {Record<string, string | undefined>} [env={}]
 * @returns {{ provider: string, model: string, apiKey: string, baseUrl: string, voiceName: string }}
 */
export function resolveVoiceProviderConfig(env = {}) {
  const provider = String(env?.AI_VOICE_PROVIDER || 'gemini').trim().toLowerCase() || 'gemini';
  const preset = VOICE_PRESETS[provider];
  if (!preset) {
    throw new Error(
      `Unsupported AI_VOICE_PROVIDER "${provider}". Supported values: ${VOICE_PROVIDER_IDS.join(', ')}`
    );
  }

  if (provider === 'none') {
    return {
      provider: 'none',
      model: '',
      apiKey: '',
      baseUrl: '',
      voiceName: '',
    };
  }

  const model = pickFirstEnv(env, preset.modelEnvNames) || preset.defaultModel;
  const apiKey = pickFirstEnv(env, preset.keyEnvNames);
  const baseUrl = stripTrailingSlashes(
    pickFirstEnv(env, preset.baseUrlEnvNames) || preset.defaultBaseUrl
  );
  const GEMINI_ONLY_VOICES = new Set(['aoede', 'puck', 'charon', 'fenrir', 'kore']);
  const explicitAiVoice = String(env?.AI_VOICE_NAME || '').trim();
  const legacyTtsVoice = String(env?.TTS_VOICE_NAME || '').trim();
  const safeLegacyVoice =
    provider === 'openai' && GEMINI_ONLY_VOICES.has(legacyTtsVoice.toLowerCase())
      ? ''
      : legacyTtsVoice;
  const voiceName = explicitAiVoice || safeLegacyVoice || preset.defaultVoice;

  if (!apiKey) {
    const expectedKeys = preset.keyEnvNames.join(' or ');
    throw new Error(
      `Missing required API key for AI_VOICE_PROVIDER=${provider}: set ${expectedKeys}`
    );
  }

  return {
    provider,
    model,
    apiKey,
    baseUrl,
    voiceName,
  };
}

/**
 * Resolves and validates text-chat AI provider settings from `env`.
 *
 * @param {Record<string, string | undefined>} [env={}]
 * @returns {{ provider: string, protocol: string, model: string, apiKey: string, baseUrl: string }}
 */
export function resolveTextProviderConfig(env = {}) {
  const provider = String(env?.AI_TEXT_PROVIDER || 'gemini').trim().toLowerCase() || 'gemini';
  const preset = TEXT_PRESETS[provider];
  if (!preset) {
    throw new Error(
      `Unsupported AI_TEXT_PROVIDER "${provider}". Supported values: ${TEXT_PROVIDER_IDS.join(', ')}`
    );
  }

  if (provider === 'none') {
    return {
      provider: 'none',
      protocol: 'none',
      model: '',
      apiKey: '',
      baseUrl: '',
    };
  }

  const baseUrl = stripTrailingSlashes(
    pickFirstEnv(env, preset.baseUrlEnvNames) || preset.defaultBaseUrl
  );
  if (preset.requireBaseUrl && !baseUrl) {
    throw new Error(`Missing required AI_TEXT_BASE_URL for AI_TEXT_PROVIDER=${provider}`);
  }

  const model = pickFirstEnv(env, preset.modelEnvNames) || preset.defaultModel;
  if (preset.requireModel && !model) {
    throw new Error(`Missing required AI_TEXT_MODEL for AI_TEXT_PROVIDER=${provider}`);
  }

  const apiKey = pickFirstEnv(env, preset.keyEnvNames);
  const needsKey =
    preset.keyPolicy === 'always' || (preset.keyPolicy === 'remote_only' && !isLocalHttpUrl(baseUrl));

  if (needsKey && !apiKey) {
    const expectedKeys = preset.keyEnvNames.join(' or ');
    throw new Error(
      `Missing required API key for AI_TEXT_PROVIDER=${provider}: set ${expectedKeys}`
    );
  }

  return {
    provider,
    protocol: preset.protocol,
    model,
    apiKey,
    baseUrl,
  };
}
