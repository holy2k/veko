import fs from 'node:fs';
import path from 'node:path';
import { phonesMatch } from '../utils/phone.js';

const MAX_BOT_MESSAGE_IDS = 500;
const MAX_PENDING_DELAYED_CALLS = 100;
const MAX_QUIET_QUEUE_ITEMS = 100;
const PRIORITY_RANK = { ignore: 0, normal: 1, urgent: 2, critical: 3 };

function defaultQuietScheduleState() {
  return {
    lastMorningPromptYmd: null,
    wasQuietPendingResume: false,
    awaitingOwnerConfirm: false,
    snoozedUntilMs: null,
    resumeConfirmedYmd: null,
    pendingSnoozeDigest: false,
  };
}

/**
 * Creates a persistent state store backed by an atomic JSON file.
 * Manages chat-level cooldown/retry state, pending callback calls, temporary silence status,
 * and a bounded Set of Jarvis-sent message IDs to prevent self-trigger feedback loops.
 *
 * @param {string} filePath - Absolute or relative path to the persistent state JSON file.
 * @returns {StateStore}
 */
export function createStateStore(filePath) {
  const resolvedPath = path.resolve(filePath);

  let chats = {};
  let pendingCallChatId = null;
  let silencedUntil = null;
  let ownerChatHistory = [];
  let pendingOutgoingDraft = null;
  let installNotifiedAt = null;
  let lastStartupNoticeAt = null;
  let updateNotificationsEnabled = true;
  let lastUpdateCheckAt = null;
  let cachedLatestVersion = null;
  let lastNotifiedVersion = null;
  let callSettings = {};
  let pendingDelayedCalls = {};
  let quietQueue = [];
  let quietScheduleState = defaultQuietScheduleState();
  const botMessageIds = new Set();
  const MAX_OWNER_CHAT_HISTORY = 24;
  const PENDING_DRAFT_TTL_MS = 15 * 60_000;

  function normalizeDraft(draft) {
    if (!draft || typeof draft !== 'object') return null;
    const chatId = String(draft.chatId || '').trim();
    const messageText = String(draft.messageText || '');
    const proposedAt = Number(draft.proposedAt);
    if (!chatId || !messageText.trim() || !Number.isFinite(proposedAt)) {
      return null;
    }
    return {
      chatId,
      recipientName: String(draft.recipientName || '').trim(),
      messageText,
      isThirdParty: draft.isThirdParty === true,
      proposedAt,
      proposedInTurnId: String(draft.proposedInTurnId || '').trim(),
    };
  }

  if (fs.existsSync(resolvedPath)) {
    try {
      const content = fs.readFileSync(resolvedPath, 'utf-8');
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object') {
        if (parsed.chats && typeof parsed.chats === 'object' && !Array.isArray(parsed.chats)) {
          chats = parsed.chats;
        }
        if (typeof parsed.pendingCallChatId === 'string' || parsed.pendingCallChatId === null) {
          pendingCallChatId = parsed.pendingCallChatId;
        }
        if (typeof parsed.silencedUntil === 'number' || parsed.silencedUntil === null) {
          silencedUntil = parsed.silencedUntil;
        }
        if (Array.isArray(parsed.ownerChatHistory)) {
          ownerChatHistory = parsed.ownerChatHistory
            .filter((item) => item && typeof item === 'object' && typeof (item.content ?? item.text) === 'string')
            .slice(-MAX_OWNER_CHAT_HISTORY)
            .map((item) => ({
              role: String(item.role || 'user'),
              content: String(item.content ?? item.text ?? ''),
              timestamp: Number.isFinite(item.timestamp) ? item.timestamp : Date.now(),
            }));
        }
        if (parsed.pendingOutgoingDraft && typeof parsed.pendingOutgoingDraft === 'object') {
          pendingOutgoingDraft = normalizeDraft(parsed.pendingOutgoingDraft);
        }
        if (typeof parsed.installNotifiedAt === 'number' && Number.isFinite(parsed.installNotifiedAt)) {
          installNotifiedAt = parsed.installNotifiedAt;
        }
        if (typeof parsed.lastStartupNoticeAt === 'number' && Number.isFinite(parsed.lastStartupNoticeAt)) {
          lastStartupNoticeAt = parsed.lastStartupNoticeAt;
        }
        if (typeof parsed.updateNotificationsEnabled === 'boolean') {
          updateNotificationsEnabled = parsed.updateNotificationsEnabled;
        }
        if (typeof parsed.lastUpdateCheckAt === 'number' && Number.isFinite(parsed.lastUpdateCheckAt)) {
          lastUpdateCheckAt = parsed.lastUpdateCheckAt;
        }
        if (typeof parsed.cachedLatestVersion === 'string' && parsed.cachedLatestVersion.trim()) {
          cachedLatestVersion = parsed.cachedLatestVersion.trim();
        }
        if (typeof parsed.lastNotifiedVersion === 'string' && parsed.lastNotifiedVersion.trim()) {
          lastNotifiedVersion = parsed.lastNotifiedVersion.trim();
        }
        if (parsed.callSettings && typeof parsed.callSettings === 'object' && !Array.isArray(parsed.callSettings)) {
          callSettings = { ...parsed.callSettings };
        }
        if (
          parsed.pendingDelayedCalls &&
          typeof parsed.pendingDelayedCalls === 'object' &&
          !Array.isArray(parsed.pendingDelayedCalls)
        ) {
          for (const [k, v] of Object.entries(parsed.pendingDelayedCalls)) {
            if (v && typeof v === 'object' && typeof v.chatId === 'string' && Number.isFinite(v.dueAtMs)) {
              pendingDelayedCalls[k] = {
                ...v,
                messages: Array.isArray(v.messages) ? v.messages.slice(-20).map(String) : [],
              };
            }
          }
        }
        if (Array.isArray(parsed.quietQueue)) {
          quietQueue = parsed.quietQueue
            .filter((item) => item && typeof item === 'object' && typeof item.chatId === 'string')
            .slice(-MAX_QUIET_QUEUE_ITEMS)
            .map((item) => ({ ...item }));
        }
        if (
          parsed.quietScheduleState &&
          typeof parsed.quietScheduleState === 'object' &&
          !Array.isArray(parsed.quietScheduleState)
        ) {
          quietScheduleState = {
            ...defaultQuietScheduleState(),
            ...parsed.quietScheduleState,
          };
        }
        if (Array.isArray(parsed.botMessageIds)) {
          const ids = parsed.botMessageIds.slice(-MAX_BOT_MESSAGE_IDS);
          for (const id of ids) {
            botMessageIds.add(String(id));
          }
        }
      }
    } catch {
      // If corrupted or unreadable, initialize with clean default state
    }
  }

  function flush() {
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const payload = JSON.stringify(
      {
        chats,
        pendingCallChatId,
        silencedUntil,
        ownerChatHistory,
        pendingOutgoingDraft,
        installNotifiedAt,
        lastStartupNoticeAt,
        updateNotificationsEnabled,
        lastUpdateCheckAt,
        cachedLatestVersion,
        lastNotifiedVersion,
        callSettings,
        pendingDelayedCalls,
        quietQueue,
        quietScheduleState,
        botMessageIds: Array.from(botMessageIds),
      },
      null,
      2
    );

    const tmpPath = `${resolvedPath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmpPath, payload, 'utf-8');
    try {
      fs.renameSync(tmpPath, resolvedPath);
    } catch (err) {
      if (err && (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY')) {
        try {
          fs.copyFileSync(tmpPath, resolvedPath);
        } catch {
          fs.writeFileSync(resolvedPath, payload, 'utf-8');
        }
      } else {
        throw err;
      }
    } finally {
      try {
        if (fs.existsSync(tmpPath)) {
          fs.unlinkSync(tmpPath);
        }
      } catch {
        // Ignore temp file cleanup errors
      }
    }
  }

  return {
    getChatState(chatId) {
      if (!chatId) return {};
      return { ...(chats[chatId] || {}) };
    },

    updateChatState(chatId, patch) {
      if (!chatId) return {};
      chats[chatId] = { ...(chats[chatId] || {}), ...patch };
      flush();
      return { ...chats[chatId] };
    },

    isSilenced(nowMs = Date.now()) {
      return typeof silencedUntil === 'number' && nowMs < silencedUntil;
    },

    setSilencedUntil(untilMs) {
      silencedUntil = typeof untilMs === 'number' ? untilMs : null;
      flush();
    },

    getPendingCallChatId() {
      return pendingCallChatId || null;
    },

    setPendingCallChatId(chatId) {
      pendingCallChatId = chatId || null;
      flush();
    },

    markBotMessageId(msgId) {
      if (!msgId) return;
      const idStr = String(msgId);
      botMessageIds.add(idStr);
      if (botMessageIds.size > MAX_BOT_MESSAGE_IDS) {
        const oldest = botMessageIds.values().next().value;
        botMessageIds.delete(oldest);
      }
      flush();
    },

    consumeBotMessageId(msgId) {
      if (!msgId) return false;
      const idStr = String(msgId);
      if (botMessageIds.has(idStr)) {
        botMessageIds.delete(idStr);
        flush();
        return true;
      }
      return false;
    },

    getOwnerChatHistory() {
      return ownerChatHistory.map((item) => ({ ...item }));
    },

    appendOwnerChatMessage(entry) {
      if (!entry || typeof entry !== 'object') return;
      const content = String(entry.content ?? entry.text ?? '');
      if (!content.trim()) return;
      ownerChatHistory.push({
        role: String(entry.role || 'user'),
        content,
        timestamp: Number.isFinite(entry.timestamp) ? entry.timestamp : Date.now(),
      });
      while (ownerChatHistory.length > MAX_OWNER_CHAT_HISTORY) {
        ownerChatHistory.shift();
      }
      flush();
    },

    clearOwnerChatHistory() {
      ownerChatHistory = [];
      flush();
    },

    getPendingOutgoingDraft(nowMs = Date.now()) {
      if (!pendingOutgoingDraft) return null;
      if (nowMs - pendingOutgoingDraft.proposedAt >= PENDING_DRAFT_TTL_MS) {
        pendingOutgoingDraft = null;
        flush();
        return null;
      }
      return { ...pendingOutgoingDraft };
    },

    setPendingOutgoingDraft(draft) {
      pendingOutgoingDraft = normalizeDraft(draft);
      flush();
    },

    clearPendingOutgoingDraft() {
      pendingOutgoingDraft = null;
      flush();
    },

    getUpdateState() {
      return {
        installNotifiedAt,
        lastStartupNoticeAt,
        updateNotificationsEnabled,
        lastUpdateCheckAt,
        cachedLatestVersion,
        lastNotifiedVersion,
      };
    },

    setUpdateState(patch = {}) {
      const currentSnapshot = () => ({
        installNotifiedAt,
        lastStartupNoticeAt,
        updateNotificationsEnabled,
        lastUpdateCheckAt,
        cachedLatestVersion,
        lastNotifiedVersion,
      });
      if (!patch || typeof patch !== 'object') {
        return currentSnapshot();
      }
      if ('installNotifiedAt' in patch) {
        installNotifiedAt =
          typeof patch.installNotifiedAt === 'number' && Number.isFinite(patch.installNotifiedAt)
            ? patch.installNotifiedAt
            : null;
      }
      if ('lastStartupNoticeAt' in patch) {
        lastStartupNoticeAt =
          typeof patch.lastStartupNoticeAt === 'number' && Number.isFinite(patch.lastStartupNoticeAt)
            ? patch.lastStartupNoticeAt
            : null;
      }
      if ('updateNotificationsEnabled' in patch && typeof patch.updateNotificationsEnabled === 'boolean') {
        updateNotificationsEnabled = patch.updateNotificationsEnabled;
      }
      if ('lastUpdateCheckAt' in patch) {
        lastUpdateCheckAt =
          typeof patch.lastUpdateCheckAt === 'number' && Number.isFinite(patch.lastUpdateCheckAt)
            ? patch.lastUpdateCheckAt
            : null;
      }
      if ('cachedLatestVersion' in patch) {
        cachedLatestVersion =
          typeof patch.cachedLatestVersion === 'string' && patch.cachedLatestVersion.trim()
            ? patch.cachedLatestVersion.trim()
            : null;
      }
      if ('lastNotifiedVersion' in patch) {
        lastNotifiedVersion =
          typeof patch.lastNotifiedVersion === 'string' && patch.lastNotifiedVersion.trim()
            ? patch.lastNotifiedVersion.trim()
            : null;
      }
      flush();
      return currentSnapshot();
    },

    getCallSettingsOverrides() {
      return { ...callSettings };
    },

    setCallSettingsOverrides(patch = {}) {
      if (!patch || typeof patch !== 'object') {
        return { ...callSettings };
      }
      for (const [key, val] of Object.entries(patch)) {
        if (val === undefined) {
          delete callSettings[key];
        } else {
          callSettings[key] = val;
        }
      }
      flush();
      return { ...callSettings };
    },

    resetCallSettingsOverrides() {
      callSettings = {};
      flush();
      return {};
    },

    getPendingDelayedCalls() {
      const copy = {};
      for (const [k, v] of Object.entries(pendingDelayedCalls)) {
        copy[k] = { ...v, messages: Array.isArray(v.messages) ? [...v.messages] : [] };
      }
      return copy;
    },

    getPendingDelayedCall(chatId) {
      if (!chatId || !pendingDelayedCalls[chatId]) return null;
      const entry = pendingDelayedCalls[chatId];
      return { ...entry, messages: Array.isArray(entry.messages) ? [...entry.messages] : [] };
    },

    upsertPendingDelayedCall(entry) {
      if (!entry || typeof entry !== 'object' || !entry.chatId) return null;
      const chatId = String(entry.chatId);
      const keys = Object.keys(pendingDelayedCalls);
      if (!pendingDelayedCalls[chatId] && keys.length >= MAX_PENDING_DELAYED_CALLS) {
        delete pendingDelayedCalls[keys[0]];
      }
      pendingDelayedCalls[chatId] = {
        chatId,
        customerName: String(entry.customerName || chatId),
        dueAtMs: Number(entry.dueAtMs),
        firstMessageAt: Number(entry.firstMessageAt ?? entry.lastMessageAt ?? Date.now()),
        lastMessageAt: Number(entry.lastMessageAt ?? Date.now()),
        messages: Array.isArray(entry.messages) ? entry.messages.slice(-20).map(String) : [],
        priority: String(entry.priority || 'normal'),
        reason: String(entry.reason || 'delayed_debounce'),
      };
      flush();
      return {
        ...pendingDelayedCalls[chatId],
        messages: [...pendingDelayedCalls[chatId].messages],
      };
    },

    removePendingDelayedCall(chatId) {
      if (!chatId || !pendingDelayedCalls[chatId]) return false;
      delete pendingDelayedCalls[chatId];
      flush();
      return true;
    },

    getQuietQueue() {
      return quietQueue.map((item) => ({ ...item }));
    },

    enqueueQuietMessage(item) {
      if (!item || typeof item !== 'object' || !item.chatId) return null;
      const chatId = String(item.chatId);
      const atMs = Number.isFinite(item.atMs) ? item.atMs : Date.now();
      const incomingPriority = String(item.priority || 'normal');
      const existingIdx = quietQueue.findIndex(
        (q) =>
          q.chatId === chatId ||
          (q.phone && item.phone && phonesMatch(q.phone, item.phone)) ||
          (!q.chatId.endsWith('@lid') && !chatId.endsWith('@lid') && phonesMatch(q.chatId, chatId))
      );

      if (existingIdx >= 0) {
        const prev = quietQueue[existingIdx];
        const prevRank = PRIORITY_RANK[prev.priority] ?? 1;
        const newRank = PRIORITY_RANK[incomingPriority] ?? 1;
        const prevClean = String(prev.summary || '')
          .replace(/^\(\d+\s*mesaj\)\s*/i, '')
          .trim();
        const incomingClean = String(item.summary || '')
          .replace(/^\(\d+\s*mesaj\)\s*/i, '')
          .trim();
        const mergedSummary =
          prevClean && incomingClean
            ? prevClean.includes(incomingClean)
              ? prevClean
              : incomingClean.includes(prevClean)
                ? incomingClean
                : `${prevClean} | ${incomingClean}`
            : prevClean || incomingClean;
        const next = {
          ...prev,
          customerName: String(item.customerName || prev.customerName || chatId),
          phone: String(item.phone || prev.phone || ''),
          priority: newRank >= prevRank ? incomingPriority : prev.priority,
          summary: mergedSummary,
          latestMessage: String(item.latestMessage || prev.latestMessage || ''),
          messageCount: (Number(prev.messageCount) || 1) + 1,
          lastAtMs: atMs,
        };
        quietQueue[existingIdx] = next;
        flush();
        return { ...next };
      }

      const created = {
        chatId,
        customerName: String(item.customerName || chatId),
        phone: String(item.phone || ''),
        priority: incomingPriority,
        summary: String(item.summary || ''),
        latestMessage: String(item.latestMessage || ''),
        messageCount: 1,
        firstAtMs: atMs,
        lastAtMs: atMs,
      };
      quietQueue.push(created);
      while (quietQueue.length > MAX_QUIET_QUEUE_ITEMS) {
        quietQueue.shift();
      }
      flush();
      return { ...created };
    },

    removeQuietQueueItem(chatId) {
      if (!chatId) return false;
      const before = quietQueue.length;
      quietQueue = quietQueue.filter((item) => item.chatId !== chatId);
      if (quietQueue.length !== before) {
        flush();
        return true;
      }
      return false;
    },

    clearQuietQueue() {
      const copy = quietQueue.map((item) => ({ ...item }));
      quietQueue = [];
      flush();
      return copy;
    },

    getQuietScheduleState() {
      return { ...quietScheduleState };
    },

    setQuietScheduleState(patch = {}) {
      if (!patch || typeof patch !== 'object') {
        return { ...quietScheduleState };
      }
      if ('lastMorningPromptYmd' in patch) {
        quietScheduleState.lastMorningPromptYmd =
          typeof patch.lastMorningPromptYmd === 'string' && patch.lastMorningPromptYmd.trim()
            ? patch.lastMorningPromptYmd.trim()
            : null;
      }
      if ('wasQuietPendingResume' in patch && typeof patch.wasQuietPendingResume === 'boolean') {
        quietScheduleState.wasQuietPendingResume = patch.wasQuietPendingResume;
      }
      if ('awaitingOwnerConfirm' in patch && typeof patch.awaitingOwnerConfirm === 'boolean') {
        quietScheduleState.awaitingOwnerConfirm = patch.awaitingOwnerConfirm;
      }
      if ('snoozedUntilMs' in patch) {
        quietScheduleState.snoozedUntilMs =
          typeof patch.snoozedUntilMs === 'number' && Number.isFinite(patch.snoozedUntilMs)
            ? patch.snoozedUntilMs
            : null;
      }
      if ('resumeConfirmedYmd' in patch) {
        quietScheduleState.resumeConfirmedYmd =
          typeof patch.resumeConfirmedYmd === 'string' && patch.resumeConfirmedYmd.trim()
            ? patch.resumeConfirmedYmd.trim()
            : null;
      }
      if ('pendingSnoozeDigest' in patch && typeof patch.pendingSnoozeDigest === 'boolean') {
        quietScheduleState.pendingSnoozeDigest = patch.pendingSnoozeDigest;
      }
      flush();
      return { ...quietScheduleState };
    },

    flush,
  };
}
