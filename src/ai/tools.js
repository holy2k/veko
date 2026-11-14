import { Type } from '@google/genai';
import {
  resolveCallSettings,
  validateSettingsPatch,
  computeIstanbulTimeTargetMs,
  evaluateQuietStatus,
} from '../trigger/settings.js';
import { formatMessageBody } from '../whatsapp/media-format.js';
import { normalizePhone, phonesMatch, stripJidDeviceTag, toWhatsAppId } from '../utils/phone.js';
import {
  ISTANBUL_TZ,
  formatTimestampToIstanbulIso,
  resolveIstanbulPeriodRange,
  toIstanbulIso,
} from '../utils/time.js';
import { DEFAULT_GITHUB_REPO_URL, checkForUpdateIfStale } from '../update/checker.js';

const UNSUPPORTED_CHAT_SUFFIXES = ['@g.us', '@broadcast', '@newsletter'];

export const TOOL_DECLARATIONS = [
  {
    name: 'get_chat_history',
    description:
      'Reads recent WhatsApp messages from a chat without marking messages as read (no blue ticks). Returns text and lightweight placeholders for media.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        chatIdOrPhone: {
          type: Type.STRING,
          description: 'WhatsApp chatId (e.g. 905551234567@c.us or ...@lid) or phone number (e.g. 05551234567)',
        },
        limit: {
          type: Type.INTEGER,
          description: 'Maximum number of recent messages to return (default 20, max 50)',
        },
      },
      required: ['chatIdOrPhone'],
    },
  },
  {
    name: 'list_recent_chats',
    description:
      'Lists recent 1-on-1 WhatsApp customer chats with unread count and last message preview without marking messages as read.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        limit: {
          type: Type.INTEGER,
          description: 'Maximum number of recent chats to return (default 10, max 30)',
        },
        unreadOnly: {
          type: Type.BOOLEAN,
          description: 'Set true to return only chats with unread messages',
        },
      },
    },
  },
  {
    name: 'search_contacts',
    description:
      'Searches saved WhatsApp contacts and recent 1-on-1 chats by name or phone number. If multiple matches are returned, ask the owner to disambiguate before sending.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: 'Contact name or phone fragment to search (e.g. "Eren" or "0555")',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'send_whatsapp_message',
    description:
      'Sends a WhatsApp message to a user chat. CRITICAL: Read aloud the recipient name, phone/chatId, and exact message text and wait for explicit verbal confirmation from the owner BEFORE setting ownerConfirmed to true.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        chatId: {
          type: Type.STRING,
          description: 'Target WhatsApp chatId (e.g. 905551110001@c.us or ...@lid) or phone number',
        },
        messageText: {
          type: Type.STRING,
          description: 'Exact message text approved by the owner',
        },
        ownerConfirmed: {
          type: Type.BOOLEAN,
          description: 'Must be strictly true ONLY AFTER the owner verbally confirmed recipient and exact message text',
        },
        isThirdParty: {
          type: Type.BOOLEAN,
          description: 'Set true when messaging a third-party/supplier rather than the active customer',
        },
        recipientName: {
          type: Type.STRING,
          description: 'Optional recipient display name for the owner audit summary',
        },
      },
      required: ['chatId', 'messageText', 'ownerConfirmed'],
    },
  },
  {
    name: 'set_update_notifications',
    description:
      'Enables or disables automatic Veko update notifications according to the owner request.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        enabled: {
          type: Type.BOOLEAN,
          description: 'Set true to enable update notifications or false to disable/mute them',
        },
      },
      required: ['enabled'],
    },
  },
  {
    name: 'get_call_settings',
    description:
      'Returns current call policy, debounce delay, quiet hours schedule, morning resume confirmation status, pending delayed calls count, and quiet queue count.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'update_call_settings',
    description:
      'Updates Veko call policy, 10-minute debounce delay, quiet hours schedule, morning resume confirmation, or snooze duration at runtime.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        callPolicy: {
          type: Type.STRING,
          description: 'Call policy mode: "smart", "always", or "on_demand".',
        },
        callDelayMinutes: {
          type: Type.NUMBER,
          description: 'Debounce delay in minutes (0 to 180) before calling on normal messages in smart mode.',
        },
        quietHoursEnabled: {
          type: Type.BOOLEAN,
          description: 'Whether quiet hours suppression is enabled.',
        },
        quietHoursStart: {
          type: Type.STRING,
          description: 'Quiet hours start time in 24h Europe/Istanbul HH:MM format (e.g., "22:00").',
        },
        quietHoursEnd: {
          type: Type.STRING,
          description: 'Quiet hours end time in 24h Europe/Istanbul HH:MM format (e.g., "09:00").',
        },
        quietHoursResumeMode: {
          type: Type.STRING,
          description: 'Morning exit behavior: "auto" (automatic digest) or "ask" (ask owner confirmation first).',
        },
        quietHoursAllowUrgent: {
          type: Type.BOOLEAN,
          description: 'If true, critical emergencies can wake the owner even during quiet hours.',
        },
        confirmMorningResume: {
          type: Type.BOOLEAN,
          description: 'Set true when the owner confirms starting work/resuming calls after quiet hours.',
        },
        snoozeMinutes: {
          type: Type.NUMBER,
          description: 'Temporarily pause calls and digest for N minutes from now (1 to 720), queueing incoming items.',
        },
        snoozeUntilTime: {
          type: Type.STRING,
          description: 'Temporarily pause calls and digest until an Istanbul HH:MM time (e.g., "10:30").',
        },
        clearSnooze: {
          type: Type.BOOLEAN,
          description: 'Set true to cancel an active snooze immediately.',
        },
        resetToEnvDefaults: {
          type: Type.BOOLEAN,
          description: 'Set true to clear all WhatsApp runtime overrides and revert to .env defaults.',
        },
      },
    },
  },
  {
    name: 'check_for_updates',
    description:
      'Checks GitHub for the latest Veko release version right now and returns whether an update is available.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'end_call',
    description: 'Ends the active WhatsApp voice call with the owner and closes the live AI session.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        reason: {
          type: Type.STRING,
          description: 'Brief reason for ending the call',
        },
      },
    },
  },
];

const TEXT_EXTRA_TOOL_DECLARATIONS = [
  {
    name: 'get_customer_stats',
    description:
      'Counts unique customers (excluding owner, outbound-only chats, and active third-party suppliers) who messaged in a given Europe/Istanbul calendar period without marking chats as read.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        period: {
          type: Type.STRING,
          description:
            'Time window: "today", "yesterday", "this_week", "this_month", "last_month", "last_7_days", "last_30_days", or "custom" (default "this_month")',
        },
        startDate: {
          type: Type.STRING,
          description: 'Required when period="custom": start date YYYY-MM-DD in Europe/Istanbul',
        },
        endDate: {
          type: Type.STRING,
          description: 'Required when period="custom": inclusive end date YYYY-MM-DD in Europe/Istanbul',
        },
        limit: {
          type: Type.INTEGER,
          description: 'Max customer rows to return in details list (default 20, max 50)',
        },
      },
    },
  },
  {
    name: 'clear_pending_draft',
    description:
      'Clears any pending outgoing WhatsApp draft when the owner cancels sending or moves on to another topic.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
];

export const TEXT_TOOL_DECLARATIONS = [
  ...TOOL_DECLARATIONS.filter((decl) => decl.name !== 'end_call'),
  ...TEXT_EXTRA_TOOL_DECLARATIONS,
];

function normalizeDraftText(text) {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

let autoTurnCounter = 0;

function isLidJid(raw) {
  return String(raw || '').trim().toLowerCase().endsWith('@lid');
}

function isUnsupportedChatId(chatId) {
  const lower = String(chatId || '').trim().toLowerCase();
  if (!lower || lower === 'status@broadcast') return true;
  return UNSUPPORTED_CHAT_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * Resolves a phone number or JID into a canonical chatId while preserving unresolved `@lid` JIDs
 * (stripping any `:device` suffix without converting `@lid` into `@c.us`).
 *
 * @param {string} chatIdOrPhone
 * @returns {string}
 */
export function resolveChatId(chatIdOrPhone) {
  const raw = String(chatIdOrPhone || '').trim();
  if (!raw) return '';

  if (raw.includes('@')) {
    const clean = stripJidDeviceTag(raw);
    const lower = clean.toLowerCase();
    if (lower.endsWith('@lid')) {
      const userPart = clean.slice(0, -4).trim();
      return userPart ? clean : '';
    }
    if (isUnsupportedChatId(lower)) {
      return clean;
    }
    return toWhatsAppId(clean);
  }

  return toWhatsAppId(raw);
}

/**
 * Checks whether two JIDs or phone numbers refer to the same chat identity.
 * Unresolved `@lid` JIDs only match identical `@lid` user IDs and never match phone JIDs via digits.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function isSameChatIdentity(a, b) {
  const resA = resolveChatId(a);
  const resB = resolveChatId(b);
  if (!resA || !resB) return false;

  const aLid = isLidJid(resA);
  const bLid = isLidJid(resB);
  if (aLid || bLid) {
    return aLid && bLid && resA.toLowerCase() === resB.toLowerCase();
  }

  return resA.toLowerCase() === resB.toLowerCase() || phonesMatch(resA, resB);
}

function normalizeContactMatch(entry) {
  const chatId = resolveChatId(entry?.chatId || entry?.id || entry?.phone || '');
  const lid = isLidJid(chatId);
  const rawPhone = normalizePhone(entry?.phone || '');
  const lidUserDigits = lid ? chatId.split('@')[0].replace(/\D/g, '') : '';
  const lidNormalizedDigits = lid ? normalizePhone(lidUserDigits) : '';
  const phone = lid
    ? (rawPhone && rawPhone !== lidUserDigits && rawPhone !== lidNormalizedDigits ? rawPhone : '')
    : (rawPhone || normalizePhone(chatId));

  return {
    name: String(entry?.name || '').trim() || phone || chatId,
    phone,
    chatId,
  };
}

/**
 * Creates the confirmation-gated tool executor used by the Gemini Live session.
 *
 * @param {object} deps
 * @param {object} deps.whatsapp - WhatsAppAdapter instance
 * @param {object} deps.store - StateStore instance
 * @param {object} deps.config - AppConfig
 * @param {string} [deps.activeCustomerChatId] - Active customer chatId for third-party outreach detection
 * @param {Function} [deps.onEndCallRequested] - Callback invoked when Gemini requests `end_call`
 * @returns {(name: string, args: object) => Promise<object>}
 */
export function createToolExecutor({
  whatsapp,
  store,
  config = {},
  activeCustomerChatId = '',
  mode = 'voice',
  turnId = '',
  nowMs = () => Date.now(),
  fetchImpl = globalThis.fetch,
  onEndCallRequested,
  onDelayCleared,
} = {}) {
  const isTextMode = mode === 'text';
  const effectiveTurnId = String(turnId || '').trim() || `auto-turn-${++autoTurnCounter}`;
  const getNowMs =
    typeof nowMs === 'function'
      ? nowMs
      : () => (Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now());

  function buildSettingsSnapshot(now) {
    const effective = resolveCallSettings(config, store);
    const overrides = store?.getCallSettingsOverrides?.() || {};
    const scheduleState = store?.getQuietScheduleState?.() || {};
    const quietQueue = store?.getQuietQueue?.() || [];
    const pendingDelayed = store?.getPendingDelayedCalls?.() || {};
    const quietStatus = evaluateQuietStatus(effective, scheduleState, now, quietQueue.length);

    return {
      settings: effective,
      overrides,
      quietStatus: {
        ...quietStatus,
        snoozedUntilIso: scheduleState?.snoozedUntilMs
          ? formatTimestampToIstanbulIso(Math.floor(scheduleState.snoozedUntilMs / 1000))
          : null,
      },
      pendingDelayedCount: Object.keys(pendingDelayed).length,
      quietQueueCount: quietQueue.length,
    };
  }

  function handleGetCallSettings() {
    return {
      ok: true,
      ...buildSettingsSnapshot(getNowMs()),
    };
  }

  function handleUpdateCallSettings(args = {}) {
    const now = getNowMs();
    const patchCheck = validateSettingsPatch(args);
    if (!patchCheck.ok) {
      return { ok: false, error: patchCheck.error };
    }

    let nextSnoozeMs = null;
    if ('snoozeUntilTime' in args && args.snoozeUntilTime !== undefined) {
      const targetMs = computeIstanbulTimeTargetMs(String(args.snoozeUntilTime), now);
      if (!targetMs) {
        return { ok: false, error: 'snoozeUntilTime geçerli bir HH:MM (ör. 10:30) saati olmalıdır.' };
      }
      nextSnoozeMs = targetMs;
    } else if ('snoozeMinutes' in args && args.snoozeMinutes !== undefined) {
      const mins = Number(args.snoozeMinutes);
      if (!Number.isFinite(mins) || mins <= 0 || mins > 720) {
        return { ok: false, error: 'snoozeMinutes 1 ile 720 dakika arasında olmalıdır.' };
      }
      nextSnoozeMs = now + Math.round(mins * 60_000);
    }

    const snapBefore = buildSettingsSnapshot(now);

    if (args.resetToEnvDefaults === true) {
      store?.resetCallSettingsOverrides?.();
    }
    if (Object.keys(patchCheck.patch).length > 0) {
      store?.setCallSettingsOverrides?.(patchCheck.patch);
      if (patchCheck.patch.quietHoursEnabled === false) {
        store?.setQuietScheduleState?.({
          awaitingOwnerConfirm: false,
          wasQuietPendingResume: false,
        });
      }
    }

    if (args.clearSnooze === true) {
      store?.setQuietScheduleState?.({
        snoozedUntilMs: null,
        pendingSnoozeDigest: false,
      });
    } else if (nextSnoozeMs !== null) {
      store?.setQuietScheduleState?.({
        snoozedUntilMs: nextSnoozeMs,
        pendingSnoozeDigest: true,
        awaitingOwnerConfirm: false,
        resumeConfirmedYmd: null,
      });
    }

    let confirmedMorningResume = false;
    let flushedQuietMessages = [];
    if (args.confirmMorningResume === true) {
      const todayYmd = snapBefore.quietStatus.todayYmd;
      flushedQuietMessages = store?.clearQuietQueue?.() || [];
      store?.setQuietScheduleState?.({
        awaitingOwnerConfirm: false,
        wasQuietPendingResume: false,
        snoozedUntilMs: null,
        pendingSnoozeDigest: false,
        resumeConfirmedYmd: todayYmd,
        lastMorningPromptYmd: todayYmd,
      });
      confirmedMorningResume = true;
    } else {
      const snapAfter = buildSettingsSnapshot(now);
      const disabledQuietHours = patchCheck.patch.quietHoursEnabled === false;
      const switchedToAutoWhileAwaiting =
        patchCheck.patch.quietHoursResumeMode === 'auto' &&
        !snapBefore.quietStatus.scheduledQuiet &&
        snapBefore.quietStatus.awaitingOwnerConfirm;
      const resetReleasedQuiet =
        args.resetToEnvDefaults === true &&
        !snapAfter.quietStatus.scheduledQuiet &&
        !snapAfter.quietStatus.snoozeActive &&
        resolveCallSettings(config, store).quietHoursResumeMode !== 'ask' ||
        (args.resetToEnvDefaults === true && !snapAfter.quietStatus.isQuietNow);

      if (disabledQuietHours || switchedToAutoWhileAwaiting || resetReleasedQuiet) {
        store?.setQuietScheduleState?.({
          awaitingOwnerConfirm: false,
          wasQuietPendingResume: false,
        });
        const postReleaseSnap = buildSettingsSnapshot(now);
        if (!postReleaseSnap.quietStatus.isQuietNow) {
          flushedQuietMessages = store?.clearQuietQueue?.() || [];
        }
      }
    }

    return {
      ok: true,
      confirmedMorningResume,
      flushedQuietQueueCount: flushedQuietMessages.length,
      flushedQuietMessages,
      ...buildSettingsSnapshot(now),
    };
  }

  async function handleGetChatHistory(args = {}) {
    const chatId = resolveChatId(args.chatIdOrPhone);
    if (!chatId || isUnsupportedChatId(chatId)) {
      return { ok: false, error: 'Valid chatIdOrPhone is required.' };
    }

    const rawLimit = Number(args.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 50) : 20;
    const rawMessages = await whatsapp.fetchChatHistory(chatId, limit);

    const messages = (rawMessages || []).map((msg) => ({
      sender: msg.fromMe ? 'Siz/İşletme' : 'Karşı Taraf',
      fromMe: Boolean(msg.fromMe),
      timestamp: msg.timestamp ?? null,
      type: msg.type || 'chat',
      text: formatMessageBody(msg),
    }));

    return {
      ok: true,
      chatId,
      count: messages.length,
      messages,
    };
  }

  async function handleListRecentChats(args = {}) {
    if (typeof whatsapp?.listRecentChats !== 'function') {
      return { ok: false, error: 'Son sohbetler şu an listelenemiyor.' };
    }

    const rawLimit = Number(args.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 30) : 10;
    const unreadOnly = args.unreadOnly === true;
    const rawChats = await whatsapp.listRecentChats(unreadOnly ? 50 : Math.min(limit + 5, 50));
    const ownerChatId = config?.ownerChatId ? resolveChatId(config.ownerChatId) : '';

    const chats = [];
    for (const ch of rawChats || []) {
      const chatId = resolveChatId(ch?.chatId || ch?.id || ch?.phone || '');
      if (!chatId || isUnsupportedChatId(chatId)) continue;
      if (ownerChatId && isSameChatIdentity(chatId, ownerChatId)) continue;
      const unreadCount = Number(ch?.unreadCount || 0) || 0;
      if (unreadOnly && unreadCount <= 0) continue;

      chats.push({
        chatId,
        name: String(ch?.name || '').trim() || ch?.phone || chatId,
        phone: String(ch?.phone || '').trim(),
        unreadCount,
        timestamp: ch?.timestamp ?? null,
        timestampIso: ch?.timestampIso || formatTimestampToIstanbulIso(ch?.timestamp),
        lastMessageText: ch?.lastMessage ? formatMessageBody(ch.lastMessage) : '',
      });
    }

    const limitedChats = chats.slice(0, limit);
    return {
      ok: true,
      count: limitedChats.length,
      chats: limitedChats,
    };
  }

  async function handleSearchContacts(args = {}) {
    const query = String(args?.query || '').trim();
    if (!query) {
      return { ok: false, error: 'Arama sorgusu gerekli.' };
    }

    const rawMatches = await whatsapp.searchContacts(query);
    const matches = (rawMatches || []).map(normalizeContactMatch);

    return {
      ok: true,
      query,
      count: matches.length,
      ambiguous: matches.length > 1,
      matches,
    };
  }

  async function handleSendWhatsAppMessage(args = {}) {
    if (!isTextMode && args?.ownerConfirmed !== true) {
      return {
        ok: false,
        error:
          'Owner confirmation required: read recipient name/phone and exact messageText aloud and wait for explicit approval before setting ownerConfirmed to true.',
      };
    }

    const messageText = typeof args.messageText === 'string' ? args.messageText.trim() : '';
    if (!messageText) {
      return { ok: false, error: 'messageText is required and must be non-empty.' };
    }

    const targetChatId = resolveChatId(args.chatId);
    if (!targetChatId || !targetChatId.includes('@') || isUnsupportedChatId(targetChatId)) {
      return { ok: false, error: 'Valid target chatId is required.' };
    }

    const now = getNowMs();
    const effectiveCustomerChatId = isTextMode
      ? activeCustomerChatId
      : activeCustomerChatId || store?.getPendingCallChatId?.() || '';
    const ownerChatId = config?.ownerChatId ? resolveChatId(config.ownerChatId) : '';
    const isOwnerTarget = Boolean(ownerChatId && isSameChatIdentity(targetChatId, ownerChatId));
    const isCustomerTarget = Boolean(
      effectiveCustomerChatId && isSameChatIdentity(targetChatId, effectiveCustomerChatId)
    );
    const delayedMapBefore = store?.getPendingDelayedCalls?.() || {};
    const hasPendingDelayed = Object.keys(delayedMapBefore).some(
      (key) => key === targetChatId || isSameChatIdentity(key, targetChatId)
    );
    const quietItemsBefore = store?.getQuietQueue?.() || [];
    const hasQuietQueued = quietItemsBefore.some(
      (item) =>
        item?.chatId &&
        (item.chatId === targetChatId || isSameChatIdentity(item.chatId, targetChatId))
    );
    const targetState = store?.getChatState?.(targetChatId) || {};
    const hasActiveThirdPartyOutreach =
      typeof targetState.thirdPartyOutreachUntil === 'number' &&
      targetState.thirdPartyOutreachUntil > now;
    const hasExistingCustomerActivity =
      Number(targetState.customerMessageCount) > 0 && !hasActiveThirdPartyOutreach;
    const isKnownCustomerTarget =
      isCustomerTarget || hasPendingDelayed || hasQuietQueued || hasExistingCustomerActivity;

    let effectiveIsThirdParty =
      !isOwnerTarget &&
      !isKnownCustomerTarget &&
      args.isThirdParty !== false &&
      (args.isThirdParty === true || Boolean(effectiveCustomerChatId));

    const recipientName = String(args.recipientName || '').trim();

    if (isTextMode) {
      const existingDraft = store?.getPendingOutgoingDraft?.(now) || null;
      const stageDraft = (status, error) => {
        const draft = {
          chatId: targetChatId,
          recipientName,
          messageText,
          isThirdParty: effectiveIsThirdParty,
          proposedAt: now,
          proposedInTurnId: effectiveTurnId,
        };
        store?.setPendingOutgoingDraft?.(draft);
        return {
          ok: false,
          status,
          requiresOwnerReply: true,
          draft,
          error,
        };
      };

      if (!existingDraft) {
        return stageDraft(
          'pending_confirmation',
          'Text mode 2-step confirmation required: draft saved. Show the recipient and exact messageText to the owner and wait for their reply before sending.'
        );
      }

      if (!existingDraft.proposedInTurnId || existingDraft.proposedInTurnId === effectiveTurnId) {
        return stageDraft(
          'pending_confirmation',
          'Same-turn confirmation is blocked. Wait for the owner’s next reply confirming the draft before sending.'
        );
      }

      const sameTarget = isSameChatIdentity(existingDraft.chatId, targetChatId);
      const sameBody = normalizeDraftText(existingDraft.messageText) === normalizeDraftText(messageText);
      if (!sameTarget || !sameBody) {
        return stageDraft(
          'draft_updated_pending_confirmation',
          'Recipient or messageText changed; updated draft saved. Ask the owner to confirm the new draft before sending.'
        );
      }

      if (args?.isThirdParty !== false && existingDraft.isThirdParty) {
        effectiveIsThirdParty = !isOwnerTarget && !isKnownCustomerTarget;
      }

      if (args?.ownerConfirmed !== true) {
        return {
          ok: false,
          status: 'pending_confirmation',
          requiresOwnerReply: true,
          draft: {
            ...existingDraft,
            isThirdParty: effectiveIsThirdParty,
          },
          error:
            'Owner confirmation required: set ownerConfirmed to true only after the owner explicitly approves sending.',
        };
      }
    }

    let targetRes;
    try {
      targetRes = await whatsapp.sendMessage(targetChatId, messageText);
    } catch (err) {
      return {
        ok: false,
        error: err?.message || 'Failed to send WhatsApp message.',
      };
    }
    if (!targetRes || (!targetRes.id && targetRes.sent === false)) {
      return { ok: false, error: 'Failed to send WhatsApp message.' };
    }

    if (isTextMode) {
      store?.clearPendingOutgoingDraft?.();
    }

    if (targetRes.id) {
      store?.markBotMessageId?.(targetRes.id);
    }

    if (effectiveIsThirdParty) {
      const hours = Number(config?.thirdPartyOutreachHours ?? 24);
      const validHours = Number.isFinite(hours) && hours > 0 ? hours : 24;
      store?.updateChatState?.(targetChatId, {
        thirdPartyOutreachUntil: now + validHours * 3600_000,
      });
    } else if (isTextMode && !isOwnerTarget) {
      store?.updateChatState?.(targetChatId, {
        lastTextReplyAt: now,
        missedRetryCount: 0,
      });
    }

    if (!isOwnerTarget) {
      const pendingId = store?.getPendingCallChatId?.();
      if (pendingId && (pendingId === targetChatId || isSameChatIdentity(pendingId, targetChatId))) {
        store?.setPendingCallChatId?.(null);
      }
      const delayedMap = store?.getPendingDelayedCalls?.() || {};
      for (const key of Object.keys(delayedMap)) {
        if (key === targetChatId || isSameChatIdentity(key, targetChatId)) {
          store?.removePendingDelayedCall?.(key);
          onDelayCleared?.(key);
        }
      }
      const quietItems = store?.getQuietQueue?.() || [];
      for (const item of quietItems) {
        if (
          item?.chatId &&
          (item.chatId === targetChatId || isSameChatIdentity(item.chatId, targetChatId))
        ) {
          store?.removeQuietQueueItem?.(item.chatId);
        }
      }
      onDelayCleared?.(targetChatId);
    }

    let auditMessageId = null;
    let auditSent = false;
    let auditError;
    if (!isTextMode && ownerChatId && !isOwnerTarget) {
      try {
        const assistantName = String(config?.assistantName || 'Veko').trim() || 'Veko';
        const recipientLabel = recipientName ? `${recipientName} (${targetChatId})` : targetChatId;
        const auditText = `📤 [${assistantName}] Onaylı mesaj gönderildi\nAlıcı: ${recipientLabel}\nMesaj: ${messageText}`;
        const auditRes = await whatsapp.sendMessage(ownerChatId, auditText);
        if (auditRes?.id) {
          store?.markBotMessageId?.(auditRes.id);
          auditMessageId = auditRes.id;
        }
        auditSent = Boolean(auditRes && (auditRes.id || auditRes.sent !== false));
        if (!auditSent) {
          auditError = 'Owner audit send returned an empty or failed response.';
        }
      } catch (err) {
        auditSent = false;
        auditError = err?.message || String(err || 'Owner audit send failed');
      }
    }

    return {
      ok: true,
      sentTo: targetChatId,
      chatId: targetChatId,
      messageId: targetRes.id || null,
      auditMessageId,
      auditSent,
      ...(auditError ? { auditError } : {}),
      isThirdParty: effectiveIsThirdParty,
    };
  }

  async function handleGetCustomerStats(args = {}) {
    if (typeof whatsapp?.scanCustomerChats !== 'function') {
      return {
        ok: false,
        error: 'Müşteri istatistiği taraması WhatsApp istemcisi tarafından desteklenmiyor.',
      };
    }

    const now = getNowMs();
    const resolved = resolveIstanbulPeriodRange(args, now);
    if (!resolved.ok) {
      return resolved;
    }

    const excludeChatIds = [];
    if (config?.ownerChatId) {
      excludeChatIds.push(resolveChatId(config.ownerChatId));
    }

    const rawLimit = Number(args?.limit);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 50) : 20;

    const scanRes = await whatsapp.scanCustomerChats({
      rangeStartMs: resolved.rangeStartMs,
      rangeEndMs: resolved.rangeEndMs,
      excludeChatIds,
      store,
      nowMs: now,
    });

    const customers = Array.isArray(scanRes?.customers) ? scanRes.customers : [];
    const normalizedCustomers = customers.map((c) => ({
      chatId: c.chatId,
      name: c.name,
      phone: c.phone,
      isNew: c?.isNew === true ? true : c?.isNew === false ? false : null,
      messageCount: Number(c.messageCountInRange) || 0,
    }));
    const excludedThirdPartyCount = Number(scanRes?.excludedThirdPartyCount) || 0;
    const excludedOutboundOnlyCount = Number(scanRes?.excludedOutboundOnlyCount) || 0;
    const excludedCount =
      scanRes?.excludedCount != null
        ? Number(scanRes.excludedCount) || 0
        : excludedThirdPartyCount + excludedOutboundOnlyCount;
    return {
      ok: true,
      period: resolved.period,
      timezone: ISTANBUL_TZ,
      rangeStartIso: toIstanbulIso(resolved.rangeStartMs),
      rangeEndIso: toIstanbulIso(resolved.rangeEndMs),
      uniqueCustomers: normalizedCustomers.length,
      newCustomers: normalizedCustomers.filter((c) => c.isNew === true).length,
      returningCustomers: normalizedCustomers.filter((c) => c.isNew === false).length,
      unknownHistoryCustomers: normalizedCustomers.filter((c) => c.isNew === null).length,
      totalIncomingMessages: normalizedCustomers.reduce((sum, c) => sum + c.messageCount, 0),
      customers: normalizedCustomers.slice(0, limit),
      scannedChats: Number(scanRes?.scannedChats) || 0,
      skippedByPreFilter: Number(scanRes?.skippedByPreFilter) || 0,
      excludedCount,
      excludedThirdPartyCount,
      excludedOutboundOnlyCount,
      truncated: Boolean(scanRes?.truncated),
    };
  }

  async function handleClearPendingDraft() {
    store?.clearPendingOutgoingDraft?.();
    return { ok: true, cleared: true };
  }

  async function handleSetUpdateNotifications(args = {}) {
    if (typeof args?.enabled !== 'boolean') {
      return {
        ok: false,
        error: 'enabled parametresi boolean (true veya false) olmalıdır.',
      };
    }
    const updated =
      store?.setUpdateState?.({ updateNotificationsEnabled: args.enabled }) || {
        updateNotificationsEnabled: args.enabled,
      };
    return {
      ok: true,
      updateNotificationsEnabled: Boolean(updated.updateNotificationsEnabled),
      message: updated.updateNotificationsEnabled
        ? 'Güncelleme bildirimleri açıldı.'
        : 'Güncelleme bildirimleri kapatıldı.',
    };
  }

  async function handleCheckForUpdates() {
    const res = await checkForUpdateIfStale({
      store,
      config,
      fetchImpl,
      nowMs: getNowMs(),
      force: true,
    });
    return {
      ok: Boolean(res.ok),
      currentVersion: res.currentVersion,
      latestVersion: res.latestVersion,
      hasUpdate: Boolean(res.hasUpdate),
      repoUrl: res.repoUrl || config?.githubRepoUrl || DEFAULT_GITHUB_REPO_URL,
      ...(res.error ? { error: res.error } : {}),
    };
  }

  async function handleEndCall(args = {}) {
    if (isTextMode) {
      return {
        ok: false,
        error: 'end_call is only available during active voice calls.',
      };
    }
    const reason = String(args?.reason || 'owner_done').trim() || 'owner_done';
    await Promise.resolve(onEndCallRequested?.(reason));
    return {
      ok: true,
      ended: true,
      reason,
    };
  }

  return async function executeTool(name, args = {}) {
    const safeArgs = args && typeof args === 'object' ? args : {};
    switch (name) {
      case 'get_chat_history':
        return handleGetChatHistory(safeArgs);
      case 'list_recent_chats':
        return handleListRecentChats(safeArgs);
      case 'search_contacts':
        return handleSearchContacts(safeArgs);
      case 'send_whatsapp_message':
        return handleSendWhatsAppMessage(safeArgs);
      case 'get_customer_stats':
        return handleGetCustomerStats(safeArgs);
      case 'clear_pending_draft':
        return handleClearPendingDraft();
      case 'get_call_settings':
        return handleGetCallSettings();
      case 'update_call_settings':
        return handleUpdateCallSettings(safeArgs);
      case 'set_update_notifications':
        return handleSetUpdateNotifications(safeArgs);
      case 'check_for_updates':
        return handleCheckForUpdates();
      case 'end_call':
        return handleEndCall(safeArgs);
      default:
        return { ok: false, error: `Unknown tool: ${String(name || '')}` };
    }
  };
}
