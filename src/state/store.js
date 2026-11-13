import fs from 'node:fs';
import path from 'node:path';

const MAX_BOT_MESSAGE_IDS = 500;

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
        botMessageIds: Array.from(botMessageIds),
      },
      null,
      2
    );

    const tmpPath = `${resolvedPath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmpPath, payload, 'utf-8');
    fs.renameSync(tmpPath, resolvedPath);
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

    flush,
  };
}
