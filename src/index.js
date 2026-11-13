import 'dotenv/config';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import qrcode from 'qrcode-terminal';
import { loadConfig } from './config.js';
import { createStateStore } from './state/store.js';
import { evaluateIncomingMessage, evaluateIncomingCall } from './trigger/policy.js';
import { createWhatsAppClient } from './whatsapp/client.js';
import { createCallController } from './whatsapp/call-controller.js';
import { startVoiceSession } from './ai/voice-session.js';
import { runOwnerTextTurn } from './ai/text-chat.js';
import { createToolExecutor } from './ai/tools.js';
import {
  DEFAULT_GITHUB_REPO_URL,
  UPDATE_CHECK_CACHE_TTL_MS,
  checkForUpdateIfStale,
  isNewerVersion,
  normalizeVersionString,
} from './update/checker.js';

const MAX_PRECONNECT_AUDIO_CHUNKS = 50;
const HISTORY_FETCH_LIMIT = 15;
const MAX_WHATSAPP_CHUNK_CHARS = 3500;
const STARTUP_NOTICE_COOLDOWN_MS = 15 * 60_000;

function normalizeUpdateTogglePhrase(text) {
  return String(text || '')
    .replace(/İ/g, 'i')
    .toLowerCase()
    .replace(/\u0307/g, '')
    .replace(/ı/g, 'i')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitTextIntoChunks(text, maxLen = MAX_WHATSAPP_CHUNK_CHARS) {
  const str = String(text || '').trim();
  if (!str) return [];
  if (str.length <= maxLen) return [str];

  const chunks = [];
  let remaining = str;
  while (remaining.length > maxLen) {
    const window = remaining.slice(0, maxLen + 1);
    let splitIdx = window.lastIndexOf('\n\n');
    if (splitIdx < maxLen * 0.4) {
      splitIdx = window.lastIndexOf('\n');
    }
    if (splitIdx < maxLen * 0.4) {
      splitIdx = window.lastIndexOf(' ');
    }
    if (splitIdx <= 0) {
      splitIdx = maxLen;
    }
    const piece = remaining.slice(0, splitIdx).trim();
    if (piece) chunks.push(piece);
    remaining = remaining.slice(splitIdx).trimStart();
  }
  if (remaining.trim()) {
    chunks.push(remaining.trim());
  }
  return chunks;
}

function stripJid(jidOrText = '') {
  return String(jidOrText).replace(/@.+$/, '').trim();
}

function extractCustomerPhone(chatId, fallbackPhone = '') {
  if (typeof fallbackPhone === 'string' && fallbackPhone.trim()) {
    return fallbackPhone.trim();
  }
  const str = String(chatId ?? '');
  if (/@c\.us$/i.test(str)) {
    return str.replace(/@c\.us$/i, '');
  }
  return '';
}

function formatSenderLabel(msg, fallbackChatId = '') {
  const name = typeof msg?.senderName === 'string' ? msg.senderName.trim() : '';
  if (name) return name;
  return stripJid(fallbackChatId || msg?.chatId || msg?.from || '') || 'Bilinmeyen Kişi';
}

function formatMessagePreview(msg) {
  if (!msg) return '';
  const body = typeof msg.body === 'string' ? msg.body.trim() : '';
  if (body) return body;
  const text = typeof msg.text === 'string' ? msg.text.trim() : '';
  if (text) return text;
  if (msg.type && msg.type !== 'chat') {
    return `[${msg.type}]`;
  }
  return '';
}

function formatHistoryForPrompt(rawHistory, customerName, assistantName) {
  if (!Array.isArray(rawHistory)) return [];
  return rawHistory.map((m) => ({
    fromMe: Boolean(m?.fromMe),
    sender: m?.fromMe ? assistantName || 'Asistan' : customerName,
    body: formatMessagePreview(m),
  }));
}

/**
 * Creates the main message & voice-call orchestrator connecting trigger policy,
 * WhatsApp Web calling, and Gemini Live AI sessions.
 *
 * @param {object} deps
 * @param {object} deps.config
 * @param {object} deps.store
 * @param {object} deps.whatsapp
 * @param {object} deps.callController
 * @param {Function} [deps.startLiveSession=startGeminiLiveSession]
 * @param {Function} [deps.createTools=createToolExecutor]
 * @param {Function} [deps.nowFn=() => Date.now()]
 */
export function createOrchestrator({
  config,
  store,
  whatsapp,
  callController,
  startLiveSession = startVoiceSession,
  runTextTurn = runOwnerTextTurn,
  createTools = createToolExecutor,
  fetchImpl = null,
  nowFn = () => Date.now(),
}) {
  let callRunning = false;
  let ownerChatQueue = Promise.resolve();
  let ownerTurnSeq = 0;
  let startupHandled = false;

  function isVoiceDisabled() {
    const provider = String(config?.aiVoice?.provider ?? config?.aiVoiceProvider ?? 'gemini')
      .trim()
      .toLowerCase();
    return provider === 'none';
  }

  function isTextDisabled() {
    const provider = String(config?.aiText?.provider ?? config?.aiTextProvider ?? 'gemini')
      .trim()
      .toLowerCase();
    return provider === 'none';
  }

  function appendSystemNoticeToHistory(noticeText) {
    if (!noticeText || !store?.appendOwnerChatMessage) return;
    store.appendOwnerChatMessage({
      role: 'system',
      content: `[Sistem Bildirimi] ${noticeText}`,
      timestamp: nowFn(),
    });
    store.flush?.();
  }

  async function sendOwnerNotice(text) {
    if (!text || !config?.ownerChatId) return null;
    try {
      const sent = await whatsapp.sendMessage(config.ownerChatId, text);
      if (sent?.id) {
        store.markBotMessageId(sent.id);
      }
      return sent;
    } catch (err) {
      console.error('[orchestrator] Failed to notify owner:', err?.message || err);
      return null;
    }
  }

  async function maybeNotifyPendingUpdateAfterConversation() {
    const state = store?.getUpdateState?.();
    if (!state || state.updateNotificationsEnabled === false) {
      return { notified: false, reason: 'disabled' };
    }

    if (fetchImpl) {
      await checkForUpdateIfStale({
        store,
        config,
        fetchImpl,
        nowMs: nowFn(),
        force: false,
      });
    }

    const refreshed = store?.getUpdateState?.() || state;
    if (refreshed.updateNotificationsEnabled === false) {
      return { notified: false, reason: 'disabled' };
    }

    const currentVersion = normalizeVersionString(config?.appVersion) || '0.2.0';
    const latestVersion = normalizeVersionString(refreshed.cachedLatestVersion);
    if (!latestVersion || !isNewerVersion(latestVersion, currentVersion)) {
      return { notified: false, reason: 'no_update' };
    }
    if (refreshed.lastNotifiedVersion === latestVersion) {
      return { notified: false, reason: 'already_notified' };
    }

    const repoUrl = config?.githubRepoUrl || DEFAULT_GITHUB_REPO_URL;
    const noticeText = `🆕 Yeni Veko güncellemesi mevcut: v${latestVersion} (mevcut: v${currentVersion})\n${repoUrl}\nBildirimleri kapatmak için "güncelleme bildirimi kapat" yazabilirsiniz.`;
    const sent = await sendOwnerNotice(noticeText);
    if (sent) {
      store?.setUpdateState?.({ lastNotifiedVersion: latestVersion });
      appendSystemNoticeToHistory(noticeText);
      return { notified: true, version: latestVersion };
    }
    return { notified: false, reason: 'send_failed' };
  }

  async function checkForUpdateInBackground() {
    const state = store?.getUpdateState?.();
    if (state?.updateNotificationsEnabled === false || !fetchImpl) {
      return { ok: false, skipped: true };
    }
    return checkForUpdateIfStale({
      store,
      config,
      fetchImpl,
      nowMs: nowFn(),
      force: false,
    });
  }

  async function handleStartupReady() {
    if (startupHandled) {
      return { handled: false, skipped: true, reason: 'already_handled_in_process' };
    }
    startupHandled = true;

    const now = nowFn();
    const assistantName = config?.assistantName || 'Veko';
    const repoUrl = config?.githubRepoUrl || DEFAULT_GITHUB_REPO_URL;
    const currentVersion = normalizeVersionString(config?.appVersion) || '0.2.0';
    const updateState = store?.getUpdateState?.() || {};

    if (!updateState.installNotifiedAt) {
      const welcomeText = `✅ ${assistantName} kuruldu! Güncellemeler otomatik olarak ${repoUrl} üzerinden kontrol edilir ve yeni güncelleme çıktığında görüşmelerinizden sonra buradan bildirilir. Bildirim almak istemiyorsanız "Güncelleme bildirimi kapat" yazmanız yeterlidir.`;
      const sent = await sendOwnerNotice(welcomeText);
      if (sent) {
        store?.setUpdateState?.({
          installNotifiedAt: now,
          lastStartupNoticeAt: now,
        });
      }
      return { handled: Boolean(sent), mode: 'install', notified: Boolean(sent) };
    }

    const lastStartup = updateState.lastStartupNoticeAt;
    if (
      typeof lastStartup === 'number' &&
      Number.isFinite(lastStartup) &&
      now - lastStartup >= 0 &&
      now - lastStartup < STARTUP_NOTICE_COOLDOWN_MS
    ) {
      console.log(
        `[${assistantName}] Yeniden başlatma bildirimi atlandı (15 dk spam koruması aktif).`
      );
      return { handled: false, skipped: true, reason: 'startup_cooldown' };
    }

    if (updateState.updateNotificationsEnabled === false) {
      const sent = await sendOwnerNotice(`✅ ${assistantName} başarıyla yeniden başlatıldı.`);
      if (sent) {
        store?.setUpdateState?.({ lastStartupNoticeAt: now });
      }
      return {
        handled: Boolean(sent),
        mode: 'restart',
        notificationsEnabled: false,
        hasUpdate: false,
      };
    }

    let checkRes = {
      ok: false,
      currentVersion,
      latestVersion: null,
      hasUpdate: false,
    };
    if (fetchImpl) {
      checkRes = await checkForUpdateIfStale({
        store,
        config,
        fetchImpl,
        nowMs: now,
        force: true,
      });
    } else if (updateState.cachedLatestVersion) {
      const cached = normalizeVersionString(updateState.cachedLatestVersion);
      checkRes = {
        ok: true,
        currentVersion,
        latestVersion: cached,
        hasUpdate: Boolean(cached && isNewerVersion(cached, currentVersion)),
      };
    }

    let restartText;
    if (checkRes.hasUpdate && checkRes.latestVersion) {
      restartText = `✅ ${assistantName} başarıyla yeniden başlatıldı. 🆕 Yeni sürüm mevcut: v${checkRes.latestVersion} (${repoUrl})`;
    } else if (checkRes.ok) {
      restartText = `✅ ${assistantName} başarıyla yeniden başlatıldı, güncelleme yok (v${currentVersion}).`;
    } else {
      restartText = `✅ ${assistantName} başarıyla yeniden başlatıldı. (v${currentVersion})`;
    }

    const sent = await sendOwnerNotice(restartText);
    if (sent) {
      store?.setUpdateState?.({
        lastStartupNoticeAt: now,
        ...(checkRes.hasUpdate && checkRes.latestVersion
          ? { lastNotifiedVersion: checkRes.latestVersion }
          : {}),
      });
    }
    return {
      handled: Boolean(sent),
      mode: 'restart',
      notificationsEnabled: true,
      hasUpdate: Boolean(checkRes.hasUpdate),
      latestVersion: checkRes.latestVersion || null,
    };
  }

  async function loadCustomerContext(chatId, customerName, triggerMessage) {
    let rawHistory = [];
    try {
      rawHistory = (await whatsapp.fetchChatHistory?.(chatId, HISTORY_FETCH_LIMIT)) ?? [];
    } catch (err) {
      console.error('[orchestrator] fetchChatHistory failed:', err?.message || err);
    }

    const recentMessages = formatHistoryForPrompt(
      rawHistory,
      customerName,
      config?.assistantName
    );

    return {
      customerName,
      senderName: customerName,
      chatId,
      customerPhone: extractCustomerPhone(chatId),
      triggerMessage: triggerMessage || recentMessages.at(-1)?.body || '',
      recentMessages,
    };
  }

  async function handleCallOutcome(outcome, { targetChatId, customerName, triggerBody }) {
    const endedAt = nowFn();
    const prevState = store.getChatState(targetChatId);

    if (outcome === 'answered') {
      store.updateChatState(targetChatId, {
        lastCallAt: endedAt,
        lastCallStatus: 'answered',
        missedRetryCount: 0,
      });
      if (store.getPendingCallChatId() === targetChatId) {
        store.setPendingCallChatId(null);
      }
      return;
    }

    if (outcome === 'rejected') {
      store.updateChatState(targetChatId, {
        lastCallAt: endedAt,
        lastCallStatus: 'rejected',
        missedRetryCount: 0,
      });
      await sendOwnerNotice(
        `📵 Aramayı reddettiniz — ${customerName}: "${triggerBody}". (İsterseniz "ara" yazarak bağlanabilirsiniz.)`
      );
      return;
    }

    if (outcome === 'missed') {
      const cooldownMs = (config.cooldownMinutes ?? 120) * 60 * 1000;
      const isRetryWithinCooldown =
        prevState?.lastCallStatus === 'missed' &&
        typeof prevState?.lastCallAt === 'number' &&
        endedAt - prevState.lastCallAt < cooldownMs;
      const nextRetryCount = isRetryWithinCooldown
        ? (prevState.missedRetryCount ?? 0) + 1
        : 0;

      store.updateChatState(targetChatId, {
        lastCallAt: endedAt,
        lastCallStatus: 'missed',
        missedRetryCount: nextRetryCount,
      });
      store.setPendingCallChatId(targetChatId);
      await sendOwnerNotice(
        `📵 Aramayı açamadınız (cevap yok) — ${customerName}: "${triggerBody}". Özet için "ara" yazabilirsiniz.`
      );
      return;
    }

    // Outcome 'error' or unknown: keep cooldown state untouched so customer messages aren't masked.
    await sendOwnerNotice(
      `⚠️ Arama başlatılamadı (hata) — ${customerName}: "${triggerBody}". Lütfen mesajı kontrol edin veya "ara" yazın.`
    );
  }

  async function runCallBridgeSession({
    startControllerCall,
    getCustomerContext,
    activeCustomerChatId = '',
    noticeLabel = 'Arama',
    preloadContext = false,
  }) {
    callRunning = true;
    let callSession = null;
    let liveSession = null;
    let liveConnecting = false;
    let callEnded = false;
    let liveClosed = false;
    let endedReason = '';
    const pendingOwnerAudio = [];

    const closeLiveSafely = () => {
      liveClosed = true;
      const handle = liveSession;
      liveSession = null;
      if (handle) {
        try {
          handle.close?.();
        } catch (err) {
          console.error('[orchestrator] liveSession.close failed:', err?.message || err);
        }
      }
    };

    const requestCallHangup = (reason) => {
      if (callSession && !callEnded) {
        Promise.resolve(callSession.hangUp?.(reason)).catch((err) => {
          console.error('[orchestrator] callSession.hangUp failed:', err?.message || err);
        });
      }
    };

    try {
      const preloadedContext = preloadContext ? await getCustomerContext() : null;

      const startLiveForCall = (session) => {
        callSession = session;
        if (callEnded) return;
        liveConnecting = true;

        const toolExecutor = createTools({
          whatsapp,
          store,
          config,
          activeCustomerChatId,
          ...(fetchImpl ? { fetchImpl } : {}),
          onEndCallRequested: () => requestCallHangup('end_call_tool'),
        });

        Promise.resolve()
          .then(() => (preloadContext ? preloadedContext : getCustomerContext()))
          .then((customerContext) => {
            if (callEnded || liveClosed) return null;
            return startLiveSession({
              config,
              customerContext,
              toolExecutor,
              onAudioChunk: (b64Pcm24k) => {
                if (!callEnded && callSession) {
                  callSession.pushAudioToOwner?.(b64Pcm24k);
                }
              },
              onInterrupted: () => {
                if (!callEnded && callSession) {
                  callSession.flushAudioToOwner?.();
                }
              },
              onError: async (err) => {
                console.error('[orchestrator] Gemini Live session error:', err?.message || err);
                closeLiveSafely();
                await sendOwnerNotice(
                  `⚠️ ${config.assistantName || 'Asistan'} ses bağlantısı hatası (${noticeLabel}).`
                );
                requestCallHangup('live_session_error');
              },
              onClose: () => {
                liveClosed = true;
                liveSession = null;
                if (!callEnded) {
                  requestCallHangup('live_session_closed');
                }
              },
            });
          })
          .then((handle) => {
            liveConnecting = false;
            if (!handle) return;
            if (callEnded || liveClosed) {
              try {
                handle?.close?.();
              } catch {}
              return;
            }
            liveSession = handle;
            while (pendingOwnerAudio.length > 0 && !callEnded && !liveClosed) {
              const chunk = pendingOwnerAudio.shift();
              liveSession.sendOwnerAudio?.(chunk);
            }
          })
          .catch(async (err) => {
            liveConnecting = false;
            console.error('[orchestrator] startLiveSession failed:', err?.message || err);
            if (!callEnded) {
              await sendOwnerNotice(
                `⚠️ ${config.assistantName || 'Asistan'} başlatılamadı (${noticeLabel}): ${err?.message || err}`
              );
              requestCallHangup('live_session_start_failed');
            }
          });
      };

      const callResult = await startControllerCall({
        onConnected: startLiveForCall,
        onAudioFromOwner: (b64Pcm16k) => {
          if (callEnded || liveClosed) return;
          if (liveSession) {
            liveSession.sendOwnerAudio?.(b64Pcm16k);
            return;
          }
          if (liveConnecting) {
            if (pendingOwnerAudio.length >= MAX_PRECONNECT_AUDIO_CHUNKS) {
              pendingOwnerAudio.shift();
            }
            pendingOwnerAudio.push(b64Pcm16k);
          }
        },
        onEnded: (_outcome, details) => {
          endedReason = details?.reason || '';
          callEnded = true;
          pendingOwnerAudio.length = 0;
          closeLiveSafely();
        },
      });

      const outcome =
        callResult && typeof callResult === 'object' && callResult.done
          ? await callResult.done
          : callResult;

      callEnded = true;
      pendingOwnerAudio.length = 0;
      closeLiveSafely();

      return { outcome, endedReason };
    } catch (err) {
      callEnded = true;
      pendingOwnerAudio.length = 0;
      closeLiveSafely();
      throw err;
    } finally {
      callRunning = false;
    }
  }

  async function initiateOwnerCall({ targetChatId, customerName, triggerBody }) {
    if (callRunning || callController.isCallActive?.()) {
      await sendOwnerNotice(`📞 Zaten aktif bir arama var — ${customerName}: "${triggerBody}"`);
      return 'skipped';
    }

    try {
      const { outcome, endedReason } = await runCallBridgeSession({
        startControllerCall: (callbacks) => callController.startCallWithOwner(callbacks),
        getCustomerContext: () => loadCustomerContext(targetChatId, customerName, triggerBody),
        activeCustomerChatId: targetChatId,
        noticeLabel: customerName,
        preloadContext: true,
      });

      console.log(
        `[${config.assistantName || 'Veko'}] Arama bitti: outcome=${outcome} reason=${endedReason || 'normal'} (${customerName})`
      );
      if (outcome === 'answered' && endedReason === 'max_duration') {
        await sendOwnerNotice('⏱️ Maksimum görüşme süresi dolduğu için arama sonlandırıldı.');
      }

      await handleCallOutcome(outcome, { targetChatId, customerName, triggerBody });
      if (outcome === 'answered') {
        await maybeNotifyPendingUpdateAfterConversation();
      }
      return outcome;
    } catch (err) {
      console.error('[orchestrator] initiateOwnerCall failed:', err?.message || err);
      await handleCallOutcome('error', { targetChatId, customerName, triggerBody });
      return 'error';
    }
  }

  async function handleIncomingCall(callEvent) {
    const callInProgress = callRunning || Boolean(callController.isCallActive?.());
    const decision = evaluateIncomingCall(callEvent, { config, callInProgress });

    if (decision.action !== 'answer_owner_call') {
      if (decision.reason !== 'outgoing_call') {
        console.log(
          `[${config.assistantName || 'Veko'}] Gelen arama yanıtlanmadı: reason=${decision.reason}`
        );
      }
      return decision;
    }

    if (typeof callController?.answerIncomingCall !== 'function') {
      return { action: 'ignore', reason: 'unsupported_controller' };
    }

    const pendingChatId = store.getPendingCallChatId?.() || '';
    const getCustomerContext = async () => {
      if (!pendingChatId) {
        return { callMode: 'owner_initiated', hasPendingCustomer: false };
      }
      let customerLabel = stripJid(pendingChatId) || 'Bekleyen Müşteri';
      try {
        const chat = await whatsapp.getChatById?.(pendingChatId);
        if (chat?.name) customerLabel = chat.name;
      } catch {
        // Fallback to JID strip if chat lookup fails
      }
      const ctx = await loadCustomerContext(
        pendingChatId,
        customerLabel,
        'Patron aradı (bekleyen müşteri)'
      );
      return { ...ctx, callMode: 'owner_initiated', hasPendingCustomer: true };
    };

    try {
      console.log(`[${config.assistantName || 'Veko'}] Patron arıyor, çağrı yanıtlanıyor...`);
      const { outcome, endedReason } = await runCallBridgeSession({
        startControllerCall: (callbacks) => callController.answerIncomingCall(callbacks),
        getCustomerContext,
        activeCustomerChatId: pendingChatId,
        noticeLabel: callEvent?.senderName || 'Patron',
        preloadContext: false,
      });

      console.log(
        `[${config.assistantName || 'Veko'}] Gelen patron araması bitti: outcome=${outcome} reason=${endedReason || 'normal'}`
      );
      if (outcome === 'answered' && endedReason === 'max_duration') {
        await sendOwnerNotice('⏱️ Maksimum görüşme süresi dolduğu için arama sonlandırıldı.');
      }
      if (outcome === 'answered' && pendingChatId) {
        store.updateChatState?.(pendingChatId, {
          lastCallAt: nowFn(),
          lastCallStatus: 'answered',
          missedRetryCount: 0,
        });
        if (store.getPendingCallChatId?.() === pendingChatId) {
          store.setPendingCallChatId?.(null);
        }
      }
      if (outcome === 'answered') {
        await maybeNotifyPendingUpdateAfterConversation();
      }

      return { action: 'answer_owner_call', outcome, reason: endedReason };
    } catch (err) {
      console.error('[orchestrator] handleIncomingCall failed:', err?.message || err);
      return { action: 'answer_owner_call', outcome: 'error', reason: err?.message || 'error' };
    }
  }

  async function handleOwnerCommand(decision, msg) {
    const { command } = decision;
    const assistantName = config.assistantName || 'Asistan';

    if (command.type === 'silence') {
      await sendOwnerNotice(
        `🔇 ${assistantName} ${command.minutes} dakika süreyle susturuldu. Yalnızca sessiz bildirim gönderilecek. (Devam için "devam" yazın.)`
      );
      return;
    }

    if (command.type === 'resume') {
      await sendOwnerNotice(
        `🔔 ${assistantName} tekrar aktif. Uygun mesajlarda arama yapılacak.`
      );
      return;
    }

    if (command.type === 'status') {
      const now = nowFn();
      const silenced = store.isSilenced(now);
      const activeCall = callRunning || Boolean(callController.isCallActive?.());
      const pending = store.getPendingCallChatId();
      const updateState = store.getUpdateState?.() || {};
      const notifEnabled = updateState.updateNotificationsEnabled !== false;
      const currentVersion = normalizeVersionString(config?.appVersion) || '0.2.0';
      const hasNewCached = Boolean(
        updateState.cachedLatestVersion &&
          isNewerVersion(updateState.cachedLatestVersion, currentVersion)
      );
      await sendOwnerNotice(
        [
          `📊 ${assistantName} Durum: ${silenced ? 'Susturulmuş (sessiz bildirim)' : 'Aktif'}`,
          `📞 Aktif Arama: ${activeCall ? 'Var' : 'Yok'}`,
          `⏳ Bekleyen Arama: ${pending || 'Yok'}`,
          `📦 Sürüm: v${currentVersion}`,
          `🔔 Güncelleme Bildirimi: ${notifEnabled ? 'Açık' : 'Kapalı'}${hasNewCached ? ` (Yeni: v${updateState.cachedLatestVersion})` : ''}`,
        ].join('\n')
      );
      return;
    }

    if (command.type === 'call_latest') {
      if (isVoiceDisabled()) {
        await sendOwnerNotice(
          'ℹ️ Sesli arama modu kapalı (AI_VOICE_PROVIDER=none). Yazılı sohbetten devam edebilirsiniz.'
        );
        return;
      }
      if (callRunning || callController.isCallActive?.()) {
        await sendOwnerNotice('⚠️ Zaten aktif bir arama var.');
        return;
      }
      const pendingChatId = store.getPendingCallChatId();
      if (!pendingChatId) {
        await sendOwnerNotice(
          'ℹ️ Bekleyen müşteri araması yok. Kişi seçmek için "ara <isim veya numara>" yazın.'
        );
        return;
      }
      const label = stripJid(pendingChatId);
      await initiateOwnerCall({
        targetChatId: pendingChatId,
        customerName: label,
        triggerBody: formatMessagePreview(msg) || 'Patron arama isteği',
      });
      return;
    }

    if (command.type === 'call_query') {
      if (isVoiceDisabled()) {
        await sendOwnerNotice(
          'ℹ️ Sesli arama modu kapalı (AI_VOICE_PROVIDER=none). Yazılı sohbetten devam edebilirsiniz.'
        );
        return;
      }
      if (callRunning || callController.isCallActive?.()) {
        await sendOwnerNotice('⚠️ Zaten aktif bir arama var.');
        return;
      }
      const matches = (await whatsapp.searchContacts?.(command.query)) ?? [];
      if (matches.length === 0) {
        await sendOwnerNotice(`❌ "${command.query}" için eşleşen kişi veya sohbet bulunamadı.`);
        return;
      }
      if (matches.length > 1) {
        const preview = matches
          .slice(0, 5)
          .map((c, idx) => `${idx + 1}. ${c.name || c.phone || c.chatId} (${c.phone || c.chatId})`)
          .join('\n');
        await sendOwnerNotice(
          `🔍 "${command.query}" için birden fazla eşleşme bulundu. Lütfen daha spesifik "ara <isim/numara>" yazın:\n${preview}`
        );
        return;
      }
      const match = matches[0];
      const targetChatId = match.chatId;
      const customerName = match.name || match.phone || stripJid(targetChatId);
      await initiateOwnerCall({
        targetChatId,
        customerName,
        triggerBody: formatMessagePreview(msg) || `Patron komutu: ara ${command.query}`,
      });
      return;
    }

    await sendOwnerNotice(
      'ℹ️ Anlaşılamayan komut. Kullanılabilir komutlar: "durum", "ara", "ara <isim>", "sustur <dk>", "devam".'
    );
  }

  async function handleOwnerTextChat(decision, msg) {
    const ownerText = String(decision.messageText ?? msg?.body ?? decision.summaryText ?? '').trim();
    if (isTextDisabled()) {
      const normalizedCmd = normalizeUpdateTogglePhrase(ownerText);
      if (normalizedCmd === 'guncelleme bildirimi kapat') {
        store.setUpdateState?.({ updateNotificationsEnabled: false });
        await sendOwnerNotice(
          '🔕 Güncelleme bildirimleri kapatıldı. İstediğiniz zaman "güncelleme bildirimi aç" yazarak tekrar açabilirsiniz.'
        );
        return { ...decision, updateNotificationsEnabled: false };
      }
      if (normalizedCmd === 'guncelleme bildirimi ac') {
        store.setUpdateState?.({ updateNotificationsEnabled: true });
        await sendOwnerNotice('🔔 Güncelleme bildirimleri açıldı.');
        return { ...decision, updateNotificationsEnabled: true };
      }
      return {
        ...decision,
        action: 'ignore',
        reason: 'text_disabled',
      };
    }

    if (!ownerText) {
      return {
        ...decision,
        action: 'ignore',
        reason: 'empty_owner_chat',
      };
    }

    const turnId = `owner-${msg?.id || ++ownerTurnSeq}-${nowFn()}`;
    const queuedTurn = ownerChatQueue.then(async () => {
      const reply = await runTextTurn(
        {
          config,
          store,
          whatsapp,
          ownerMessage: ownerText,
          turnId,
          nowMs: nowFn,
        },
        ...(fetchImpl ? [{ fetch: fetchImpl }] : [])
      );

      if (reply?.disabled) {
        return { ...decision, action: 'ignore', reason: 'text_disabled' };
      }

      const replyText = String(reply?.text || '').trim();
      if (replyText) {
        const chunks = splitTextIntoChunks(replyText, MAX_WHATSAPP_CHUNK_CHARS);
        for (const chunk of chunks) {
          await sendOwnerNotice(chunk);
        }
        if (reply?.ok !== false) {
          await maybeNotifyPendingUpdateAfterConversation();
        }
      }

      return { ...decision, reply };
    });

    ownerChatQueue = queuedTurn.catch(() => {});
    return queuedTurn;
  }

  async function handleIncomingMessage(msg) {
    const callInProgress = callRunning || Boolean(callController.isCallActive?.());
    const decision = evaluateIncomingMessage(msg, {
      config,
      store,
      callInProgress,
      nowMs: nowFn(),
    });

    if (decision.action === 'ignore' || decision.action === 'update_owner_reply') {
      return decision;
    }

    if (decision.action === 'owner_command') {
      await handleOwnerCommand(decision, msg);
      return decision;
    }

    if (decision.action === 'owner_chat') {
      return handleOwnerTextChat(decision, msg);
    }

    const targetChatId = decision.targetChatId || msg.chatId || msg.from;
    const customerName = formatSenderLabel(msg, targetChatId);
    const triggerBody = formatMessagePreview(msg) || decision.summaryText;

    if (decision.action === 'notify_only') {
      const noticeText =
        decision.reason === 'voice_disabled'
          ? `🔕 ${customerName} (Sesli arama kapalı - AI_VOICE_PROVIDER=none): ${decision.summaryText}`
          : `🔕 ${customerName}: ${decision.summaryText}`;
      await sendOwnerNotice(noticeText);
      appendSystemNoticeToHistory(noticeText);
      return decision;
    }

    if (decision.action === 'notify_and_call') {
      const noticeText = `📩 ${customerName}: ${decision.summaryText}\n📞 ${config.assistantName || 'Asistan'} sizi arıyor...`;
      await sendOwnerNotice(noticeText);
      appendSystemNoticeToHistory(noticeText);
      await initiateOwnerCall({ targetChatId, customerName, triggerBody });
      return decision;
    }

    return decision;
  }

  function shutdown() {
    store.flush?.();
  }

  return {
    handleIncomingMessage,
    handleIncomingCall,
    handleStartupReady,
    maybeNotifyPendingUpdateAfterConversation,
    checkForUpdateInBackground,
    shutdown,
  };
}

/**
 * Boots the live WhatsApp Business Web client, call controller, and orchestrator CLI process.
 */
export async function main() {
  const config = loadConfig();
  const store = createStateStore(config.stateFilePath);

  const voiceProvider = config.aiVoice?.provider ?? config.aiVoiceProvider ?? 'gemini';
  const voiceModel = config.aiVoice?.model ?? config.aiVoiceModel ?? config.geminiLiveModel;
  const voiceName = config.aiVoice?.voiceName ?? config.ttsVoiceName;
  const textProvider = config.aiText?.provider ?? config.aiTextProvider ?? 'gemini';
  const textModel = config.aiText?.model ?? config.aiTextModel ?? config.geminiTextModel ?? 'gemini-3.8-flash';

  console.log(`[${config.assistantName}] Başlatılıyor...`, {
    ownerChatId: config.ownerChatId,
    voiceProvider,
    voiceModel,
    voiceName,
    textProvider,
    textModel,
    ...(config.assistantStyle ? { assistantStyle: config.assistantStyle } : {}),
    chromeHeadless: config.chromeHeadless,
  });
  if (voiceProvider === 'none' && textProvider === 'none') {
    console.warn(`[${config.assistantName}] UYARI: Hem sesli hem metin AI devre dışı (none). Yalnızca sessiz bildirimler ve temel komutlar çalışacaktır.`);
  }

  let shuttingDown = false;
  let orchestrator = null;

  const whatsapp = createWhatsAppClient(config, {
    onQr: (qr) => {
      console.log(`\n[${config.assistantName}] WhatsApp Web QR kodunu telefonunuzdan tarayın:\n`);
      qrcode.generate(qr, { small: true });
    },
    onReady: () => {
      console.log(`[${config.assistantName}] WhatsApp Web HAZIR. Mesajlar dinleniyor...`);
      Promise.resolve(orchestrator?.handleStartupReady?.()).catch((err) => {
        console.error(
          `[${config.assistantName}] Başlangıç güncelleme bildirimi hatası:`,
          err?.message || err
        );
      });
    },
    onMessage: (msg) => {
      const dispatch = async () => {
        if (msg?.fromMe) {
          // Let sendMessage callers record markBotMessageId before message_create is evaluated.
          await new Promise((r) => setTimeout(r, 150));
        }
        await orchestrator?.handleIncomingMessage(msg);
      };
      dispatch().catch((err) => {
        console.error(`[${config.assistantName}] Mesaj işleme hatası:`, err);
      });
    },
    onIncomingCall: (call) => {
      Promise.resolve(orchestrator?.handleIncomingCall(call)).catch((err) => {
        console.error(`[${config.assistantName}] Gelen arama işleme hatası:`, err);
      });
    },
    onAuthFailure: (message) => {
      console.error(`[${config.assistantName}] WhatsApp kimlik doğrulama hatası:`, message);
    },
    onDisconnected: (reason) => {
      console.warn(`[${config.assistantName}] WhatsApp bağlantısı kesildi:`, reason);
      if (!shuttingDown) {
        store.flush?.();
        process.exit(1);
      }
    },
    onError: (err) => {
      console.error(`[${config.assistantName}] WhatsApp istemci hatası:`, err?.message || err);
    },
  });

  const callController = createCallController({ client: whatsapp, config });
  orchestrator = createOrchestrator({
    config,
    store,
    whatsapp,
    callController,
    fetchImpl: globalThis.fetch,
  });

  const updateTimer = setInterval(() => {
    Promise.resolve(orchestrator?.checkForUpdateInBackground?.()).catch((err) => {
      console.error(
        `[${config.assistantName}] Arka plan güncelleme kontrolü hatası:`,
        err?.message || err
      );
    });
  }, UPDATE_CHECK_CACHE_TTL_MS);
  updateTimer.unref?.();

  const handleSignal = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[${config.assistantName}] ${signal} alındı, güvenli kapatılıyor...`);
    clearInterval(updateTimer);
    try {
      orchestrator?.shutdown?.();
      await whatsapp.destroy?.();
    } catch (err) {
      console.error(`[${config.assistantName}] Kapatma sırasında hata:`, err?.message || err);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));

  await whatsapp.initialize();
}

const isMain =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  main().catch((err) => {
    console.error('[Veko] Başlatma hatası:', err);
    process.exit(1);
  });
}
