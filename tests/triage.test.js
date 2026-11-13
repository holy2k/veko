import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRuleBasedMessage,
  parseTriageJson,
  triageCustomerMessage,
} from '../src/ai/triage.js';
import { generateTextCompletion } from '../src/ai/text-chat.js';

test('classifyRuleBasedMessage ignores noise, emojis, stickers, closings, and OTPs while preserving greetings', () => {
  assert.equal(classifyRuleBasedMessage({ type: 'chat', body: '👍' }).priority, 'ignore');
  assert.equal(classifyRuleBasedMessage({ type: 'sticker', body: '' }, '[Çıkartma]').priority, 'ignore');
  assert.equal(classifyRuleBasedMessage({ type: 'chat', body: 'Tamam teşekkürler' }).priority, 'ignore');
  assert.equal(classifyRuleBasedMessage({ type: 'chat', body: 'Sağ olun hayırlı işler' }).priority, 'ignore');
  assert.equal(classifyRuleBasedMessage({ type: 'chat', body: 'Eyvallah ok' }).priority, 'ignore');
  assert.equal(
    classifyRuleBasedMessage({
      type: 'chat',
      body: 'Tek kullanımlık doğrulama kodunuz: 492817. Kimseyle paylaşmayınız.',
    }).priority,
    'ignore'
  );
  assert.equal(
    classifyRuleBasedMessage({
      type: 'chat',
      body: 'Değerli müşterimiz siparişiniz kargoya verilmiştir. Takip no: 123456.',
    }).priority,
    'ignore'
  );

  // Bare greetings must NOT be ignored (customers often follow up 10 seconds later)
  assert.equal(classifyRuleBasedMessage({ type: 'chat', body: 'Merhaba' }).priority, 'normal');
  assert.equal(classifyRuleBasedMessage({ type: 'chat', body: 'Selam iyi çalışmalar' }).priority, 'normal');
  // Normal pricing inquiry
  assert.equal(classifyRuleBasedMessage({ type: 'chat', body: 'Yıllık bakım fiyatı nedir?' }).priority, 'normal');
});

test('classifyRuleBasedMessage detects critical outages, urgent keywords, and voice notes', () => {
  assert.equal(
    classifyRuleBasedMessage({ type: 'chat', body: 'Sunucu kapandı acil bakar mısınız!' }).priority,
    'critical'
  );
  assert.equal(
    classifyRuleBasedMessage({ type: 'chat', body: 'Site açılmıyor sistem tamamen çöktü' }).priority,
    'critical'
  );
  assert.equal(
    classifyRuleBasedMessage({ type: 'chat', body: 'Acil fiyat teklifi rica ediyorum' }).priority,
    'urgent'
  );
  assert.equal(
    classifyRuleBasedMessage({ type: 'ptt', body: '' }, '[Sesli mesaj, 14 sn]').priority,
    'urgent'
  );
});

test('parseTriageJson safely parses strict or fenced JSON and rejects invalid payloads', () => {
  assert.deepEqual(
    parseTriageJson('```json\n{"priority":"urgent","reason":"hızlı teklif","summary":"Müşteri acil teklif istedi"}\n```'),
    { priority: 'urgent', reason: 'hızlı teklif', summary: 'Müşteri acil teklif istedi' }
  );
  assert.equal(parseTriageJson('bu kesinlikle json değil'), null);
  assert.equal(parseTriageJson('{"priority":"invalid_level"}'), null);
});

test('triageCustomerMessage skips AI for Tier-1 ignore and supports Gemini, OpenAI-compatible, and Anthropic AI triage', async () => {
  let aiCalls = 0;
  const geminiResIgnored = await triageCustomerMessage(
    {
      event: { type: 'chat', body: 'Teşekkür ederim görüşürüz' },
      summaryText: 'Teşekkür ederim görüşürüz',
      config: { aiTextProvider: 'gemini', geminiApiKey: 'g-key', geminiTextModel: 'gemini-3.5-flash-lite' },
    },
    {
      GoogleGenAI: class {
        constructor() {
          aiCalls += 1;
        }
      },
    }
  );
  assert.equal(geminiResIgnored.priority, 'ignore');
  assert.equal(aiCalls, 0);

  // Gemini AI classification overrides normal phrase to critical when outage context applies
  let capturedPrompt = '';
  const gemRes = await triageCustomerMessage(
    {
      event: { type: 'chat', body: 'Panelde hiçbir şey yüklenmiyor, müşteriler ödeme geçemiyor' },
      summaryText: 'Panelde hiçbir şey yüklenmiyor, müşteriler ödeme geçemiyor',
      config: { aiTextProvider: 'gemini', geminiApiKey: 'g-key', geminiTextModel: 'gemini-3.5-flash-lite' },
    },
    {
      GoogleGenAI: class {
        constructor() {
          this.models = {
            generateContent: async (req) => {
              capturedPrompt = req.contents?.[0]?.parts?.[0]?.text || '';
              return {
                text: '{"priority":"critical","reason":"Ödeme ve sistem erişimi durmuş","summary":"Müşteriler ödeme geçemiyor"}',
              };
            },
          };
        }
      },
    }
  );
  assert.equal(gemRes.priority, 'critical');
  assert.equal(gemRes.source, 'ai');
  assert.match(capturedPrompt, /<MUSTERI_MESAJI>/);

  // OpenAI-compatible (keyless local Ollama)
  const ollamaRes = await triageCustomerMessage(
    {
      event: { type: 'chat', body: 'Merhaba iki adet fiyat sormak istiyorum' },
      summaryText: 'Merhaba iki adet fiyat sormak istiyorum',
      config: { aiTextProvider: 'ollama', aiTextBaseUrl: 'http://localhost:11434/v1', aiTextModel: 'qwen3:8b' },
    },
    {
      fetch: async () => ({
        ok: true,
        status: 200,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: '{"priority":"normal","reason":"standart fiyat sorusu","summary":"2 adet fiyat soruyor"}',
                },
              },
            ],
          };
        },
      }),
    }
  );
  assert.equal(ollamaRes.priority, 'normal');
  assert.equal(ollamaRes.source, 'ai');

  // Anthropic
  const antRes = await triageCustomerMessage(
    {
      event: { type: 'chat', body: 'Acil teklif gönderebilir misiniz?' },
      summaryText: 'Acil teklif gönderebilir misiniz?',
      config: { aiTextProvider: 'anthropic', aiTextApiKey: 'ant-key', aiTextModel: 'claude-sonnet-4-5' },
    },
    {
      fetch: async () => ({
        ok: true,
        status: 200,
        async json() {
          return {
            content: [
              {
                type: 'text',
                text: '{"priority":"urgent","reason":"gündüz hızlı teklif talebi","summary":"Acil teklif istedi"}',
              },
            ],
          };
        },
      }),
    }
  );
  assert.equal(antRes.priority, 'urgent');
  assert.equal(antRes.source, 'ai');
});

test('triageCustomerMessage degrades gracefully when AI fails, times out, returns non-JSON, or text provider is none', async () => {
  const noneRes = await triageCustomerMessage({
    event: { type: 'chat', body: 'Sunucu kapandı acil bakın' },
    summaryText: 'Sunucu kapandı acil bakın',
    config: { aiTextProvider: 'none' },
  });
  assert.equal(noneRes.priority, 'critical');
  assert.equal(noneRes.source, 'rules');

  const brokenAiRes = await triageCustomerMessage(
    {
      event: { type: 'chat', body: 'Acil bilgi lazım' },
      summaryText: 'Acil bilgi lazım',
      config: { aiTextProvider: 'deepseek', aiTextApiKey: 'ds-key', aiTextBaseUrl: 'https://api.deepseek.com', aiTextModel: 'deepseek-v4-flash' },
    },
    {
      fetch: async () => {
        throw new Error('network error');
      },
    }
  );
  assert.equal(brokenAiRes.priority, 'urgent');
  assert.equal(brokenAiRes.source, 'rules');

  // Gemini hanging call enforces timeoutMs + passes abortSignal and falls back cleanly
  let receivedSignal = null;
  let aborted = false;
  const raceResult = await Promise.race([
    generateTextCompletion(
      {
        config: { aiTextProvider: 'gemini', geminiApiKey: 'g-key', geminiTextModel: 'gemini-3.5-flash-lite' },
        userPrompt: 'Fiyat sorusu sınıflandır',
        timeoutMs: 35,
      },
      {
        GoogleGenAI: class {
          constructor() {
            this.models = {
              generateContent: (req) => {
                receivedSignal = req?.config?.abortSignal || null;
                receivedSignal?.addEventListener('abort', () => {
                  aborted = true;
                });
                return new Promise(() => {});
              },
            };
          }
        },
      }
    ),
    new Promise((resolve) => setTimeout(() => resolve('HUNG'), 250)),
  ]);
  assert.notEqual(raceResult, 'HUNG');
  assert.equal(raceResult.ok, false);
  assert.match(raceResult.error, /timed out/i);
  assert.ok(receivedSignal instanceof AbortSignal);
  assert.equal(aborted, true);

  const triageTimedOut = await Promise.race([
    triageCustomerMessage(
      {
        event: { type: 'chat', body: 'Acil fiyat lütfen' },
        summaryText: 'Acil fiyat lütfen',
        config: { aiTextProvider: 'gemini', geminiApiKey: 'g-key' },
      },
      {
        timeoutMs: 35,
        GoogleGenAI: class {
          constructor() {
            this.models = {
              generateContent: () => new Promise(() => {}),
            };
          }
        },
      }
    ),
    new Promise((resolve) => setTimeout(() => resolve('HUNG'), 250)),
  ]);
  assert.notEqual(triageTimedOut, 'HUNG');
  assert.equal(triageTimedOut.priority, 'urgent');
  assert.equal(triageTimedOut.source, 'rules');
});
