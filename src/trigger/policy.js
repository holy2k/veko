import { phonesMatch, stripJidDeviceTag, toWhatsAppId } from '../utils/phone.js';
import { formatMessageBody } from '../whatsapp/media-format.js';
import { resolveCallSettings } from './settings.js';
import { isSameChatIdentity } from '../ai/tools.js';

function maxTimestamp(a, b) {
  const hasA = typeof a === 'number' && Number.isFinite(a);
  const hasB = typeof b === 'number' && Number.isFinite(b);
  if (hasA && hasB) return Math.max(a, b);
  if (hasA) return a;
  if (hasB) return b;
  return undefined;
}

function mergeChatStates(lidState = {}, phoneState = {}) {
  const a = lidState || {};
  const b = phoneState || {};
  const merged = { ...b, ...a };

  const thirdPartyOutreachUntil = maxTimestamp(
    a.thirdPartyOutreachUntil,
    b.thirdPartyOutreachUntil
  );
  if (thirdPartyOutreachUntil !== undefined) {
    merged.thirdPartyOutreachUntil = thirdPartyOutreachUntil;
  }

  const lastTextReplyAt = maxTimestamp(a.lastTextReplyAt, b.lastTextReplyAt);
  if (lastTextReplyAt !== undefined) {
    merged.lastTextReplyAt = lastTextReplyAt;
  }

  const lastOwnerReplyAt = maxTimestamp(a.lastOwnerReplyAt, b.lastOwnerReplyAt);
  if (lastOwnerReplyAt !== undefined) {
    merged.lastOwnerReplyAt = lastOwnerReplyAt;
  }

  const aCallAt =
    typeof a.lastCallAt === 'number' && Number.isFinite(a.lastCallAt) ? a.lastCallAt : -1;
  const bCallAt =
    typeof b.lastCallAt === 'number' && Number.isFinite(b.lastCallAt) ? b.lastCallAt : -1;
  if (bCallAt > aCallAt) {
    merged.lastCallAt = b.lastCallAt;
    merged.lastCallStatus = b.lastCallStatus;
    merged.missedRetryCount = b.missedRetryCount ?? 0;
  } else if (aCallAt >= 0) {
    merged.lastCallAt = a.lastCallAt;
    merged.lastCallStatus = a.lastCallStatus;
    merged.missedRetryCount = a.missedRetryCount ?? 0;
  }

  return merged;
}

/**
 * Checks whether an incoming message belongs to a non-individual chat
 * such as status broadcasts, groups, broadcast lists, or WhatsApp Channels.
 *
 * @param {object} event
 * @returns {boolean}
 */
function isIgnoredChat(event) {
  if (event.isStatus || event.isGroup || event.isBroadcast || event.isNewsletter) {
    return true;
  }
  const jids = [event.from, event.to, event.chatId].filter(Boolean);
  for (const jid of jids) {
    const s = String(jid);
    if (
      s.endsWith('@g.us') ||
      s.endsWith('@broadcast') ||
      s.endsWith('@newsletter') ||
      s === 'status@broadcast'
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Parses Turkish control commands sent by the owner:
 * - `ara`: calls owner with context of latest pending customer
 * - `ara <query>`: calls owner with context of matched contact or chat
 * - `sustur <dk>`: silences voice calls for N minutes (defaults to 60)
 * - `devam`: resumes voice calling
 * - `durum`: requests status overview
 *
 * @param {string|null|undefined} text
 * @returns {{ type: 'call_latest' | 'call_query' | 'silence' | 'resume' | 'status' | 'none', query?: string, minutes?: number }}
 */
export function parseOwnerCommand(text) {
  if (typeof text !== 'string') {
    return { type: 'none' };
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return { type: 'none' };
  }

  if (/^ara$/i.test(trimmed)) {
    return { type: 'call_latest' };
  }

  const araMatch = trimmed.match(/^ara\s+(.+)$/i);
  if (araMatch) {
    return { type: 'call_query', query: araMatch[1].trim() };
  }

  const susturMatch = trimmed.match(/^sustur(?:\s+(\S+))?$/i);
  if (susturMatch) {
    const rawNum = susturMatch[1];
    const parsed = rawNum ? Number(rawNum) : NaN;
    const minutes = Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 60;
    return { type: 'silence', minutes };
  }

  if (/^devam$/i.test(trimmed)) {
    return { type: 'resume' };
  }

  if (/^durum$/i.test(trimmed)) {
    return { type: 'status' };
  }

  return { type: 'none' };
}

/**
 * Evaluates incoming WhatsApp message events against Jarvis trigger, silence,
 * active window, and cooldown policies.
 *
 * @param {object} event - Incoming message event
 * @param {object} deps
 * @param {object} deps.config - Application config
 * @param {object} [deps.store] - StateStore instance
 * @param {boolean} [deps.callInProgress] - Whether a voice call is currently active
 * @param {number} [deps.nowMs] - Current timestamp in milliseconds
 * @returns {{ action: 'ignore' | 'owner_command' | 'update_owner_reply' | 'notify_and_call' | 'notify_only', command?: object, targetChatId?: string, reason?: string, summaryText?: string }}
 */
export function evaluateIncomingMessage(event, deps = {}) {
  if (!event || typeof event !== 'object') {
    return { action: 'ignore', reason: 'invalid_event' };
  }

  const config = deps.config || {};
  const store = deps.store;
  const callInProgress = Boolean(deps.callInProgress);
  const nowMs = typeof deps.nowMs === 'number' ? deps.nowMs : Date.now();

  // 1. Ignore broadcasts, status, groups, newsletters
  if (isIgnoredChat(event)) {
    return { action: 'ignore', reason: 'non_individual_chat' };
  }

  // 2. Consume Jarvis self-originated message IDs to prevent loops
  const rawId =
    typeof event.id === 'object' && event.id !== null
      ? event.id._serialized || event.id.id || String(event.id)
      : event.id;

  if (rawId && store && typeof store.consumeBotMessageId === 'function') {
    if (store.consumeBotMessageId(rawId)) {
      return { action: 'ignore', reason: 'bot_message' };
    }
  }

  const summaryText = formatMessageBody(event);
  const rawTargetChatId = event.fromMe
    ? event.to || event.chatId || event.from
    : event.chatId || event.from;
  const targetChatId = stripJidDeviceTag(rawTargetChatId);

  // 3. Check if message is from or addressed to Owner
  const rawFromLower = String(event.from || '').trim().toLowerCase();
  const isIncomingFromOwner =
    !event.fromMe &&
    ((!rawFromLower.endsWith('@lid') && phonesMatch(event.from, config.ownerPhone)) ||
      Boolean(event.phone && phonesMatch(event.phone, config.ownerPhone)));
  const isFromOwner =
    isIncomingFromOwner ||
    (event.fromMe &&
      ((!String(targetChatId).toLowerCase().endsWith('@lid') &&
        phonesMatch(targetChatId, config.ownerPhone)) ||
        Boolean(event.phone && phonesMatch(event.phone, config.ownerPhone))));

  if (isFromOwner) {
    const textToParse = typeof event.body === 'string' ? event.body : summaryText;
    const command = parseOwnerCommand(textToParse);
    if (command.type !== 'none') {
      if (store) {
        if (command.type === 'silence') {
          store.setSilencedUntil(nowMs + (command.minutes ?? 60) * 60_000);
        } else if (command.type === 'resume') {
          store.setSilencedUntil(null);
        }
      }
      return {
        action: 'owner_command',
        command,
        targetChatId: targetChatId || config.ownerChatId,
        summaryText,
      };
    }
    if (isIncomingFromOwner) {
      return {
        action: 'owner_chat',
        targetChatId: targetChatId || config.ownerChatId,
        messageText: textToParse,
        summaryText,
      };
    }
    return {
      action: 'ignore',
      reason: 'owner_message_no_command',
      targetChatId,
      summaryText,
    };
  }

  // 4. Human owner reply from mobile app (fromMe: true)
  if (event.fromMe) {
    if (store) {
      store.updateChatState(targetChatId, {
        lastOwnerReplyAt: nowMs,
        missedRetryCount: 0,
      });
      if (isSameChatIdentity(store.getPendingCallChatId?.(), targetChatId)) {
        store.setPendingCallChatId(null);
      }
    }
    return {
      action: 'update_owner_reply',
      targetChatId,
      summaryText,
    };
  }

  // 5. Customer message evaluation
  const rawChatState = store ? store.getChatState(targetChatId) : {};
  let chatState = rawChatState;
  if (store && String(targetChatId).toLowerCase().endsWith('@lid') && event.phone) {
    const phoneChatId = toWhatsAppId(event.phone);
    if (phoneChatId && typeof store.getChatState === 'function') {
      chatState = mergeChatStates(rawChatState, store.getChatState(phoneChatId));
    }
  }
  if (store && typeof store.updateChatState === 'function') {
    const prevCount = Number(rawChatState.customerMessageCount) || 0;
    store.updateChatState(targetChatId, {
      firstSeenAt: rawChatState.firstSeenAt ?? nowMs,
      lastCustomerMessageAt: nowMs,
      customerMessageCount: prevCount + 1,
    });
  }

  // Active owner window & call/cooldown suppression checks
  const suppressionReason = evaluateCallSuppressionReason({
    store,
    chatState,
    config,
    callInProgress,
    nowMs,
  });
  if (suppressionReason) {
    return {
      action: suppressionReason === 'owner_active_window' ? 'ignore' : 'notify_only',
      reason: suppressionReason,
      targetChatId,
      summaryText,
    };
  }

  const effectiveSettings = resolveCallSettings(config, store);
  if (effectiveSettings.callPolicy === 'on_demand') {
    return {
      action: 'notify_only',
      reason: 'on_demand_policy',
      targetChatId,
      summaryText,
    };
  }

  if (store && typeof store.setPendingCallChatId === 'function') {
    store.setPendingCallChatId(targetChatId);
  }

  return {
    action: 'notify_and_call',
    targetChatId,
    summaryText,
    reason: !chatState?.lastCallStatus ? 'new_customer' : 'cooldown_expired_or_retry',
  };
}

/**
 * Evaluates shared call-suppression and cooldown rules used by both immediate
 * message evaluation and matured scheduled-call ticks.
 *
 * @param {object} [params={}]
 * @returns {string|null} Suppression reason or `null` when calling is permitted
 */
export function evaluateCallSuppressionReason({
  store = null,
  chatState = {},
  config = {},
  callInProgress = false,
  nowMs = Date.now(),
} = {}) {
  const safeState = chatState || {};
  const ownerActiveWindowMs = (config.ownerActiveWindowMinutes ?? 15) * 60_000;
  if (
    typeof safeState.lastOwnerReplyAt === 'number' &&
    nowMs - safeState.lastOwnerReplyAt >= 0 &&
    nowMs - safeState.lastOwnerReplyAt < ownerActiveWindowMs
  ) {
    return 'owner_active_window';
  }

  if (store && typeof store.isSilenced === 'function' && store.isSilenced(nowMs)) {
    return 'silenced';
  }

  if (callInProgress) {
    return 'call_in_progress';
  }

  if (
    typeof safeState.thirdPartyOutreachUntil === 'number' &&
    nowMs < safeState.thirdPartyOutreachUntil
  ) {
    return 'third_party_outreach';
  }

  const voiceProvider = String(config?.aiVoice?.provider ?? config?.aiVoiceProvider ?? 'gemini')
    .trim()
    .toLowerCase();
  if (voiceProvider === 'none') {
    return 'voice_disabled';
  }

  const cooldownMs = (config.cooldownMinutes ?? 120) * 60_000;
  const missedRetryMs = (config.missedRetryMinutes ?? 30) * 60_000;
  const lastTextReplyAt = safeState.lastTextReplyAt;
  if (
    typeof lastTextReplyAt === 'number' &&
    nowMs - lastTextReplyAt >= 0 &&
    nowMs - lastTextReplyAt < cooldownMs
  ) {
    return 'recent_text_reply_cooldown';
  }

  const lastCallAt = safeState.lastCallAt;
  const lastCallStatus = safeState.lastCallStatus;
  const missedRetryCount = safeState.missedRetryCount ?? 0;

  if (lastCallStatus && typeof lastCallAt === 'number') {
    const elapsed = nowMs - lastCallAt;
    if (lastCallStatus === 'answered' && elapsed < cooldownMs) {
      return 'answered_cooldown';
    }
    if (lastCallStatus === 'rejected' && elapsed < cooldownMs) {
      return 'rejected_cooldown';
    }
    if (lastCallStatus === 'missed' && elapsed < cooldownMs) {
      if (missedRetryCount >= 1) {
        return 'missed_max_retries';
      }
      if (elapsed < missedRetryMs) {
        return 'missed_retry_window';
      }
    }
  }

  return null;
}

/**
 * Evaluates whether an incoming WhatsApp call should be automatically answered.
 * Only 1:1 incoming voice calls strictly matching `config.ownerPhone` (non-group,
 * non-video, resolved identity, no call already active) are ever permitted.
 *
 * @param {object} callEvent
 * @param {object} [deps={}]
 * @param {object} [deps.config]
 * @param {boolean} [deps.callInProgress=false]
 * @returns {{ action: 'ignore' | 'answer_owner_call', reason: string }}
 */
export function evaluateIncomingCall(callEvent, deps = {}) {
  if (!callEvent || typeof callEvent !== 'object') {
    return { action: 'ignore', reason: 'invalid_call' };
  }

  const from = String(callEvent.from || callEvent.peerJid || '').trim();
  const phone = String(callEvent.phone || '').trim();
  if (!from && !phone) {
    return { action: 'ignore', reason: 'invalid_call' };
  }

  if (callEvent.outgoing || callEvent.fromMe) {
    return { action: 'ignore', reason: 'outgoing_call' };
  }

  if (callEvent.isGroup || from.toLowerCase().endsWith('@g.us')) {
    return { action: 'ignore', reason: 'group_call' };
  }

  if (callEvent.isVideo) {
    return { action: 'ignore', reason: 'video_call' };
  }

  if (callEvent.isCallLink || callEvent.isEventLink) {
    return { action: 'ignore', reason: 'call_link' };
  }

  if (from.toLowerCase().endsWith('@lid') && !phone) {
    return { action: 'ignore', reason: 'unresolved_lid' };
  }

  const config = deps.config || {};
  const ownerRef = config.ownerPhone || config.ownerChatId || '';
  const callerRef = phone || from;
  if (!ownerRef || !phonesMatch(ownerRef, callerRef)) {
    return { action: 'ignore', reason: 'not_owner' };
  }

  const voiceProvider = String(config?.aiVoice?.provider ?? config?.aiVoiceProvider ?? 'gemini')
    .trim()
    .toLowerCase();
  if (voiceProvider === 'none') {
    return { action: 'ignore', reason: 'voice_disabled' };
  }

  if (deps.callInProgress) {
    return { action: 'ignore', reason: 'call_in_progress' };
  }

  return { action: 'answer_owner_call', reason: 'owner_incoming_call' };
}
