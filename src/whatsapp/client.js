import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import whatsappPkg from 'whatsapp-web.js';
import puppeteer from 'puppeteer';
import { getBrowserHookScript } from './injected-hook.js';
import { normalizePhone, stripJidDeviceTag, toWhatsAppId } from '../utils/phone.js';
import { formatTimestampToIstanbulIso } from '../utils/time.js';

const { Client: DefaultClient, LocalAuth: DefaultLocalAuth } = whatsappPkg;

const DEFAULT_BROWSER_ARGS = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-features=CalculateNativeWinOcclusion',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--no-sandbox',
];

function findCachedPuppeteerBinary(cacheDir, existsSync) {
  if (!cacheDir || !existsSync(cacheDir)) return null;
  const targetNames = process.platform === 'win32' ? ['chrome.exe'] : ['chrome', 'chromium'];

  try {
    const queue = [{ dir: cacheDir, depth: 0 }];
    while (queue.length > 0) {
      const { dir, depth } = queue.shift();
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isFile() && targetNames.includes(entry.name.toLowerCase())) {
          return fullPath;
        }
        if (entry.isDirectory() && depth < 4) {
          queue.push({ dir: fullPath, depth: depth + 1 });
        }
      }
    }
  } catch {
    return null;
  }

  return null;
}

function defaultPuppeteerExecutablePath() {
  try {
    return puppeteer.executablePath();
  } catch {
    return '';
  }
}

/**
 * Resolves the browser executable path for Puppeteer.
 * Order:
 * 1. Explicit `config.chromeExecutablePath` or `env.CHROME_EXECUTABLE_PATH`
 * 2. Installed Google Chrome (standard Windows / Linux paths)
 * 3. Installed Microsoft Edge (standard Windows paths)
 * 4. Cached Puppeteer Chromium binary
 *
 * @param {object} [config={}]
 * @param {object} [deps={}]
 * @returns {string|undefined}
 */
export function resolveChromeExecutablePath(config = {}, deps = {}) {
  const existsSync = deps.existsSync || fs.existsSync;
  const env = deps.env || process.env;
  const homedir = deps.homedir ?? os.homedir();
  const getPuppeteerPath = deps.puppeteerExecutablePath || defaultPuppeteerExecutablePath;

  const explicit = (config.chromeExecutablePath || env.CHROME_EXECUTABLE_PATH || '').trim();
  if (explicit) {
    return explicit;
  }

  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ...(env.LOCALAPPDATA
      ? [path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')]
      : []),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];

  const puppeteerBinary = getPuppeteerPath();
  if (puppeteerBinary) {
    candidates.push(puppeteerBinary);
  }

  if (process.platform !== 'win32') {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge'
    );
  }

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }

  if (homedir) {
    const cached = findCachedPuppeteerBinary(path.join(homedir, '.cache', 'puppeteer'), existsSync);
    if (cached) return cached;
  }

  return undefined;
}

/**
 * Builds Puppeteer launch options configured for unattended VDS WebRTC audio calling.
 *
 * @param {object} [config={}]
 * @param {object} [deps={}]
 * @returns {object}
 */
export function buildPuppeteerOptions(config = {}, deps = {}) {
  const headless =
    config.chromeHeadless === false || config.chromeHeadless === 'false' ? false : 'new';

  const executablePath = resolveChromeExecutablePath(config, deps);

  return {
    headless,
    ignoreDefaultArgs: ['--mute-audio'],
    args: [...DEFAULT_BROWSER_ARGS],
    ...(executablePath ? { executablePath } : {}),
  };
}

function resolveChatId(chatIdOrPhone) {
  const raw = String(chatIdOrPhone || '').trim();
  if (!raw) return '';
  if (raw.includes('@')) return raw;
  return toWhatsAppId(raw);
}

function extractSerializedId(idObj) {
  if (!idObj) return '';
  if (typeof idObj === 'string') return idObj;
  return idObj._serialized || idObj.$1 || idObj.id || String(idObj);
}

function normalizeDuration(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const num = Number(raw);
  return Number.isFinite(num) ? num : raw;
}

function normalizeHistoryMessage(msg) {
  const duration = normalizeDuration(msg.duration ?? msg._data?.duration ?? msg.rawData?.duration);
  const filename = (msg.filename ?? msg._data?.filename ?? msg.rawData?.filename ?? '').trim();

  return {
    fromMe: Boolean(msg.fromMe),
    timestamp: msg.timestamp,
    type: msg.type || 'chat',
    ...(duration !== undefined ? { duration } : {}),
    ...(filename ? { filename } : {}),
    body: msg.body || '',
  };
}

async function resolveLidJid(client, jid) {
  const clean = stripJidDeviceTag(jid);
  if (!clean || !clean.endsWith('@lid') || typeof client?.getContactLidAndPhone !== 'function') {
    return clean;
  }
  try {
    const mapped = await client.getContactLidAndPhone([clean]);
    const pn = mapped?.[0]?.pn;
    if (pn) {
      return pn.includes('@') ? stripJidDeviceTag(pn) : toWhatsAppId(pn);
    }
  } catch {
    // Keep original @lid if lookup fails
  }
  return clean;
}

async function resolveLidsBatch(client, lidSet) {
  const lidMap = new Map();
  if (!lidSet?.size || typeof client?.getContactLidAndPhone !== 'function') {
    return lidMap;
  }
  const resolved = await client.getContactLidAndPhone(Array.from(lidSet)).catch(() => []);
  for (const item of resolved || []) {
    if (item?.lid && item?.pn) {
      const chatId = item.pn.includes('@') ? stripJidDeviceTag(item.pn) : toWhatsAppId(item.pn);
      const phone = normalizePhone(item.pn);
      if (chatId) {
        lidMap.set(stripJidDeviceTag(item.lid), { chatId, phone });
      }
    }
  }
  return lidMap;
}

async function resolveReverseOwnerLid(client, rawLid, ownerChatId = '') {
  const cleanLid = stripJidDeviceTag(rawLid || '');
  const normalizedOwnerChatId = stripJidDeviceTag(ownerChatId || '');
  if (
    !cleanLid.endsWith('@lid') ||
    !normalizedOwnerChatId ||
    typeof client?.getContactLidAndPhone !== 'function'
  ) {
    return cleanLid;
  }
  try {
    const mapped = await client.getContactLidAndPhone([normalizedOwnerChatId]);
    const items = Array.isArray(mapped) ? mapped : mapped ? [mapped] : [];
    const expectedOwnerPhone = normalizePhone(normalizedOwnerChatId);
    const matched = items.some((entry) => {
      const ownerLid = stripJidDeviceTag(entry?.lid || '');
      if (!ownerLid || ownerLid !== cleanLid) return false;
      const entryPn = stripJidDeviceTag(entry?.pn || '');
      return !entryPn || normalizePhone(entryPn) === expectedOwnerPhone;
    });
    if (matched) {
      return normalizedOwnerChatId;
    }
  } catch {
    // Ignore reverse @lid lookup failures
  }
  return cleanLid;
}

async function normalizeIncomingCall(rawCall, client, ownerChatId = '') {
  const rawFrom = stripJidDeviceTag(rawCall?.from || rawCall?.peerJid || '');
  const outgoing = Boolean(rawCall?.outgoing ?? rawCall?.fromMe);
  const isGroup = Boolean(rawCall?.isGroup || rawFrom.endsWith('@g.us'));
  const isVideo = Boolean(rawCall?.isVideo);
  const isCallLink = Boolean(rawCall?.isCallLink || rawCall?.isEventLink);

  let from = rawFrom;
  let senderName = String(rawCall?.callerName || '').trim();

  if (from && !isGroup && !isCallLink) {
    from = await resolveLidJid(client, from);
    if (typeof client?.getContactById === 'function') {
      try {
        const contact = await client.getContactById(from);
        if (contact) {
          senderName = contact.name || contact.pushname || contact.shortName || senderName;
          const serialized = contact.id?._serialized ? stripJidDeviceTag(contact.id._serialized) : '';
          const resolvedJid = serialized.endsWith('@c.us')
            ? serialized
            : contact.phoneNumber
              ? toWhatsAppId(contact.phoneNumber)
              : '';
          if (from.endsWith('@lid') && resolvedJid.endsWith('@c.us')) {
            from = resolvedJid;
          }
        }
      } catch {
        // Keep previously resolved from / senderName if contact lookup fails
      }
    }

    if (from.endsWith('@lid')) {
      from = await resolveReverseOwnerLid(client, from, ownerChatId);
    }
  }

  const isLid = from.endsWith('@lid');
  const phone = !isLid && from && !isGroup ? normalizePhone(from) : '';

  return {
    id: String(rawCall?.id || '').trim(),
    from,
    rawFrom,
    phone,
    senderName,
    fromMe: outgoing,
    outgoing,
    isGroup,
    isVideo,
    isCallLink,
    raw: rawCall,
  };
}

async function normalizeIncomingMessage(msg, client, ownerChatId = '') {
  const id = extractSerializedId(msg.id);
  const fromMe = Boolean(msg.fromMe);
  let from = msg.from || '';
  let to = msg.to || '';

  const isStatus = Boolean(
    msg.isStatus || from === 'status@broadcast' || to === 'status@broadcast'
  );
  const isGroup = Boolean(
    from.endsWith('@g.us') || to.endsWith('@g.us')
  );
  const isNewsletter = Boolean(
    from.endsWith('@newsletter') || to.endsWith('@newsletter')
  );
  const isBroadcast = Boolean(
    msg.broadcast ||
      (!isStatus && (from.endsWith('@broadcast') || to.endsWith('@broadcast')))
  );

  // On outgoing messages (fromMe: true), msg._data.notifyName and msg.getContact()
  // reflect our own 0850 account rather than the customer recipient.
  let senderName = !fromMe ? (msg._data?.notifyName || '') : '';

  if (!isStatus && !isGroup && !isNewsletter && !isBroadcast) {
    try {
      if (!fromMe) {
        if (typeof msg.getContact === 'function') {
          const contact = await msg.getContact();
          if (contact) {
            senderName = contact.name || contact.pushname || contact.shortName || senderName;
            const serialized = contact.id?._serialized || '';
            const resolvedJid = serialized.endsWith('@c.us')
              ? serialized
              : (contact.phoneNumber ? toWhatsAppId(contact.phoneNumber) : '');
            if (from.endsWith('@lid') && resolvedJid.endsWith('@c.us')) {
              from = resolvedJid;
            }
          }
        }
        from = stripJidDeviceTag(await resolveLidJid(client, from));
        if (from.endsWith('@lid')) {
          if (!senderName && typeof client?.getContactById === 'function') {
            const lidContact = await client.getContactById(from);
            if (lidContact) {
              senderName =
                lidContact.name || lidContact.pushname || lidContact.shortName || senderName;
            }
          }
          from = await resolveReverseOwnerLid(client, from, ownerChatId);
        }
      } else {
        to = stripJidDeviceTag(await resolveLidJid(client, to));
        if (typeof client.getContactById === 'function' && to) {
          const targetContact = await client.getContactById(to);
          if (targetContact) {
            senderName =
              targetContact.name ||
              targetContact.pushname ||
              targetContact.shortName ||
              senderName;
          }
        } else if (typeof client.getChatById === 'function' && to) {
          const targetChat = await client.getChatById(to);
          if (targetChat?.name) {
            senderName = targetChat.name;
          }
        }
      }
    } catch {
      // Keep fallback notifyName / original JID if contact lookup fails
    }
  }

  const duration = normalizeDuration(msg.duration ?? msg._data?.duration ?? msg.rawData?.duration);
  const filename = (msg.filename ?? msg._data?.filename ?? msg.rawData?.filename ?? '').trim();
  const chatId = stripJidDeviceTag(fromMe ? to : from);
  const phone =
    !isStatus && !isGroup && !isNewsletter && !isBroadcast && chatId && !chatId.endsWith('@lid')
      ? normalizePhone(chatId)
      : '';

  return {
    id,
    from,
    to,
    chatId,
    phone,
    author: msg.author || undefined,
    fromMe,
    type: msg.type || 'chat',
    body: msg.body || '',
    timestamp: msg.timestamp,
    ...(duration !== undefined ? { duration } : {}),
    ...(filename ? { filename } : {}),
    isStatus,
    isGroup,
    isNewsletter,
    isBroadcast,
    senderName,
    raw: msg,
  };
}

function lowerTr(str) {
  return String(str || '').toLocaleLowerCase('tr-TR');
}

function mergeSearchEntry(byChatId, { rawId, phoneHint, aliases, displayName, lidMap }) {
  const isLid = rawId.endsWith('@lid');
  let chatId = rawId;
  let phone = '';

  if (isLid) {
    const mapped = lidMap.get(rawId);
    if (mapped) {
      chatId = mapped.chatId;
      phone = mapped.phone;
    }
  } else {
    phone = normalizePhone(phoneHint || rawId);
  }

  const existing = byChatId.get(chatId);
  const cleanAliases = aliases.filter(Boolean);
  if (existing) {
    for (const alias of cleanAliases) {
      if (!existing._aliases.includes(alias)) {
        existing._aliases.push(alias);
      }
    }
    if ((!existing.name || existing.name === existing.phone) && displayName) {
      existing.name = displayName;
    }
    if (!existing.phone && phone) {
      existing.phone = phone;
    }
  } else {
    byChatId.set(chatId, {
      name: displayName || phone,
      phone,
      chatId,
      _aliases: cleanAliases,
    });
  }
}

function isUserChatId(chatId) {
  return Boolean(
    chatId &&
      !chatId.endsWith('@g.us') &&
      !chatId.endsWith('@broadcast') &&
      !chatId.endsWith('@newsletter') &&
      chatId !== 'status@broadcast'
  );
}

/**
 * Creates a WhatsApp Web client adapter backed by `whatsapp-web.js` + `LocalAuth`.
 * Never invokes `sendSeen()` when reading messages or chat histories.
 *
 * @param {object} [config={}]
 * @param {object} [handlers={}]
 * @param {Function} [handlers.onMessage]
 * @param {Function} [handlers.onQr]
 * @param {Function} [handlers.onReady]
 * @param {Function} [handlers.onAuthFailure]
 * @param {Function} [handlers.onDisconnected]
 * @param {Function} [handlers.onError]
 * @param {object} [deps={}]
 * @returns {object}
 */
export function createWhatsAppClient(config = {}, handlers = {}, deps = {}) {
  const ClientCtor = deps.Client || DefaultClient;
  const LocalAuthCtor = deps.LocalAuth || DefaultLocalAuth;
  const hookScript = getBrowserHookScript();

  const client = new ClientCtor({
    authStrategy: new LocalAuthCtor(
      config.authDataPath ? { dataPath: config.authDataPath } : undefined
    ),
    puppeteer: buildPuppeteerOptions(config, deps),
    userAgent: config.userAgent ?? false,
    evalOnNewDoc: hookScript,
  });

  async function ensureHookInjected() {
    const page = client.pupPage;
    if (!page) return;
    try {
      if (typeof page.evaluateOnNewDocument === 'function') {
        await page.evaluateOnNewDocument(hookScript);
      }
      if (typeof page.evaluate === 'function') {
        await page.evaluate((src) => {
          if (!window.__wpJarvisAudio) {
            // eslint-disable-next-line no-eval
            (0, eval)(src);
          }
        }, hookScript);
      }
    } catch {
      // Best-effort fallback; evalOnNewDoc handles primary injection before navigation
    }
  }

  const callObserverPages = new WeakSet();
  const seenIncomingCallIds = new Set();
  let callQueue = Promise.resolve();

  const ownerChatId = stripJidDeviceTag(
    config.ownerChatId || (config.ownerPhone ? toWhatsAppId(config.ownerPhone) : '')
  );

  function enqueueIncomingCall(rawCall) {
    if (!rawCall || rawCall.outgoing || rawCall.fromMe) return;
    const callId = rawCall.id ? String(rawCall.id).trim() : '';
    if (callId) {
      if (seenIncomingCallIds.has(callId)) return;
      seenIncomingCallIds.add(callId);
      if (seenIncomingCallIds.size > 100) {
        const oldest = seenIncomingCallIds.values().next().value;
        seenIncomingCallIds.delete(oldest);
      }
    }

    callQueue = callQueue
      .then(() => normalizeIncomingCall(rawCall, client, ownerChatId))
      .then((normalized) => handlers.onIncomingCall?.(normalized))
      .catch((err) => {
        if (handlers.onError) {
          handlers.onError(err);
        } else {
          console.error('[wp-jarvis] Error handling incoming WhatsApp call:', err);
        }
      });
  }

  async function ensureIncomingCallObserver() {
    const page = client.pupPage;
    if (!page) return;
    try {
      if (!callObserverPages.has(page) && typeof page.exposeFunction === 'function') {
        const safeExpose = async (name, fn) => {
          try {
            await page.exposeFunction(name, fn);
          } catch (err) {
            if (!/already exists/i.test(String(err?.message || err))) {
              throw err;
            }
          }
        };
        await safeExpose('__wpJarvisOnWaIncomingCall', (rawCall) => {
          enqueueIncomingCall(rawCall);
        });
        await safeExpose('__wpJarvisOnWaCallEnded', (endedCallId) => {
          handlers.onIncomingCallEnded?.(endedCallId);
        });
        callObserverPages.add(page);
      }

      if (typeof page.evaluate === 'function') {
        await page.evaluate(() => {
          if (window.__wpJarvisCallObserverAttached) return true;
          if (typeof window.require !== 'function') return false;
          const col = window.require('WAWebCallCollection');
          if (!col || typeof col.on !== 'function') return false;
          window.__wpJarvisCallObserverAttached = true;

          let lastNotifiedCallId = null;
          const handleModel = (model) => {
            const attrs = model && model.attributes ? model.attributes : model;
            if (!attrs || typeof attrs !== 'object' || !attrs.id) {
              if (lastNotifiedCallId) {
                const endedId = lastNotifiedCallId;
                lastNotifiedCallId = null;
                if (typeof window.__wpJarvisOnWaCallEnded === 'function') {
                  window.__wpJarvisOnWaCallEnded(endedId);
                }
              }
              return;
            }
            if (attrs.outgoing) return;
            const callId = String(attrs.id);
            lastNotifiedCallId = callId;
            if (typeof window.__wpJarvisOnWaIncomingCall === 'function') {
              window.__wpJarvisOnWaIncomingCall({
                id: callId,
                peerJid: attrs.peerJid || '',
                from: attrs.peerJid || '',
                outgoing: Boolean(attrs.outgoing),
                fromMe: Boolean(attrs.outgoing),
                isVideo: Boolean(attrs.isVideo),
                isGroup: Boolean(attrs.isGroup),
                isCallLink: Boolean(attrs.isCallLink),
                isEventLink: Boolean(attrs.isEventLink),
              });
            }
          };

          col.on('change:activeCall', (arg0, arg1) => {
            const nextModel = arg0 && arg0 !== col ? arg0 : arg1 !== undefined ? arg1 : col.activeCall;
            handleModel(nextModel);
          });
          if (col.activeCall) {
            handleModel(col.activeCall);
          }
          return true;
        });
      }
    } catch {
      // Best-effort observer attachment; whatsapp-web.js `call` event acts as secondary source
    }
  }

  client.on('qr', (qr) => {
    handlers.onQr?.(qr);
  });

  client.on('ready', async () => {
    await ensureHookInjected();
    await ensureIncomingCallObserver();
    handlers.onReady?.();
  });

  client.on('auth_failure', (message) => {
    handlers.onAuthFailure?.(message);
  });

  client.on('disconnected', (reason) => {
    handlers.onDisconnected?.(reason);
  });

  client.on('call', (rawCall) => {
    enqueueIncomingCall(rawCall);
  });

  // Listen to `message_create` rather than `message` so both customer messages (fromMe: false)
  // and owner replies sent from their phone (fromMe: true) are observed in arrival order.
  let messageQueue = Promise.resolve();
  client.on('message_create', (rawMsg) => {
    messageQueue = messageQueue
      .then(() => normalizeIncomingMessage(rawMsg, client, ownerChatId))
      .then((normalized) => handlers.onMessage?.(normalized))
      .catch((err) => {
        if (handlers.onError) {
          handlers.onError(err);
        } else {
          console.error('[wp-jarvis] Error handling incoming WhatsApp message:', err);
        }
      });
  });

  return {
    async initialize() {
      const maxAttempts = 3;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await client.initialize();
          await ensureHookInjected();
          await ensureIncomingCallObserver();
          return;
        } catch (err) {
          const isMainFrameRace = /Requesting main frame too early/i.test(err?.message || '');
          if (!isMainFrameRace || attempt === maxAttempts) {
            throw err;
          }
          await client.destroy().catch(() => {});
          await new Promise((r) => setTimeout(r, 400));
        }
      }
    },

    ensureIncomingCallObserver,

    async destroy() {
      await client.destroy();
    },

    getClient() {
      return client;
    },

    getPage() {
      return client.pupPage || null;
    },

    async getChatById(chatId) {
      const resolved = resolveChatId(chatId);
      if (!resolved) return null;
      return client.getChatById(resolved);
    },

    async sendMessage(chatId, text, options = {}) {
      const resolved = resolveChatId(chatId);
      if (!resolved) {
        throw new Error('Cannot sendMessage: invalid chatId');
      }
      // Explicitly disable sendSeen unless a non-customer caller opts in, ensuring
      // whatsapp-web.js never marks customer chats read by default.
      const sent = await client.sendMessage(resolved, text, {
        ...options,
        sendSeen: options.sendSeen === true,
      });
      return {
        id: extractSerializedId(sent?.id),
      };
    },

    async fetchChatHistory(chatId, limit = 20) {
      const resolved = resolveChatId(chatId);
      if (!resolved) return [];
      const chat = await client.getChatById(resolved);
      if (!chat) return [];

      const messages = await chat.fetchMessages({ limit });
      return (messages || []).map(normalizeHistoryMessage);
    },

    async searchContacts(query) {
      const trimmed = String(query || '').trim();
      if (!trimmed) return [];

      const queryLower = lowerTr(trimmed);
      const querySimple = trimmed.toLowerCase();
      const rawDigits = trimmed.replace(/\D/g, '');
      const normDigits = normalizePhone(trimmed);

      const [contacts, chats] = await Promise.all([
        typeof client.getContacts === 'function' ? client.getContacts().catch(() => []) : [],
        typeof client.getChats === 'function' ? client.getChats().catch(() => []) : [],
      ]);

      const lidSet = new Set();
      for (const c of contacts || []) {
        const rawId = extractSerializedId(c.id);
        if (!c.isGroup && !c.isMe && isUserChatId(rawId) && rawId.endsWith('@lid')) {
          lidSet.add(rawId);
        }
      }
      for (const ch of chats || []) {
        const rawId = extractSerializedId(ch.id);
        if (!ch.isGroup && isUserChatId(rawId) && rawId.endsWith('@lid')) {
          lidSet.add(rawId);
        }
      }

      const lidMap = await resolveLidsBatch(client, lidSet);

      const byChatId = new Map();

      for (const c of contacts || []) {
        const rawId = extractSerializedId(c.id);
        if (c.isGroup || c.isMe || !isUserChatId(rawId)) continue;
        const displayName = (c.name || c.pushname || c.shortName || '').trim();
        mergeSearchEntry(byChatId, {
          rawId,
          phoneHint: c.number || c.id?.user || rawId,
          aliases: [c.name, c.pushname, c.shortName],
          displayName,
          lidMap,
        });
      }

      for (const ch of chats || []) {
        const rawId = extractSerializedId(ch.id);
        if (ch.isGroup || !isUserChatId(rawId)) continue;
        const chatName = (ch.name || '').trim();
        mergeSearchEntry(byChatId, {
          rawId,
          phoneHint: ch.id?.user || rawId,
          aliases: [chatName],
          displayName: chatName,
          lidMap,
        });
      }

      const matches = [];
      for (const entry of byChatId.values()) {
        const nameMatch = entry._aliases.some((alias) => {
          const aTr = lowerTr(alias);
          const aEn = String(alias).toLowerCase();
          return aTr.includes(queryLower) || aEn.includes(querySimple);
        });
        const phoneMatch =
          (rawDigits.length >= 3 && entry.phone.includes(rawDigits)) ||
          (normDigits.length >= 3 && entry.phone.includes(normDigits));

        if (nameMatch || phoneMatch) {
          matches.push({
            name: entry.name,
            phone: entry.phone,
            chatId: entry.chatId,
          });
        }
      }

      return matches;
    },

    async listRecentChats(limit = 15) {
      const cappedLimit =
        Number.isFinite(Number(limit)) && Number(limit) > 0
          ? Math.min(Math.floor(Number(limit)), 50)
          : 15;
      const chats = typeof client.getChats === 'function' ? await client.getChats().catch(() => []) : [];
      const userChats = (chats || []).filter((ch) => {
        const rawId = stripJidDeviceTag(extractSerializedId(ch.id));
        return !ch.isGroup && isUserChatId(rawId);
      });

      const lidSet = new Set();
      for (const ch of userChats) {
        const rawId = stripJidDeviceTag(extractSerializedId(ch.id));
        if (rawId.endsWith('@lid')) lidSet.add(rawId);
      }
      const lidMap = await resolveLidsBatch(client, lidSet);

      const mapped = userChats.map((ch) => {
        const rawId = stripJidDeviceTag(extractSerializedId(ch.id));
        const lidEntry = rawId.endsWith('@lid') ? lidMap.get(rawId) : null;
        const chatId = lidEntry?.chatId || rawId;
        const phone = lidEntry?.phone || (chatId.endsWith('@lid') ? '' : normalizePhone(chatId));
        const lastMsg = ch.lastMessage ? normalizeHistoryMessage(ch.lastMessage) : null;
        const timestamp = Number(lastMsg?.timestamp ?? ch.timestamp ?? 0) || 0;
        const unreadCount = Number(ch.unreadCount || 0) || 0;
        const timestampIso = formatTimestampToIstanbulIso(timestamp);

        return {
          chatId,
          name: (ch.name || '').trim() || phone || chatId,
          phone,
          unreadCount,
          timestamp,
          timestampIso,
          lastMessage: lastMsg,
        };
      });

      mapped.sort((a, b) => b.timestamp - a.timestamp);
      return mapped.slice(0, cappedLimit);
    },

    async scanCustomerChats(options = {}) {
      const {
        rangeStartMs = null,
        rangeEndMs = null,
        excludeChatIds = [],
        store = null,
        nowMs = Date.now(),
        maxCandidates = 100,
        concurrency = 5,
        historyLimit = 50,
      } = options || {};

      const toMs = (ts) => {
        const n = Number(ts);
        if (!Number.isFinite(n) || n <= 0) return 0;
        return n > 1e12 ? n : n * 1000;
      };

      const excludedList = [ownerChatId, ...(Array.isArray(excludeChatIds) ? excludeChatIds : [])]
        .map((id) => stripJidDeviceTag(String(id || '').trim()))
        .filter(Boolean);

      const isExcluded = (jid) => {
        const clean = stripJidDeviceTag(jid);
        if (!clean) return true;
        const cleanPhone = clean.endsWith('@lid') ? '' : normalizePhone(clean);
        return excludedList.some((ex) => {
          if (clean === ex) return true;
          if (!clean.endsWith('@lid') && !ex.endsWith('@lid')) {
            const exPhone = normalizePhone(ex);
            return Boolean(cleanPhone && exPhone && cleanPhone === exPhone);
          }
          return false;
        });
      };

      const chats = typeof client.getChats === 'function' ? await client.getChats().catch(() => []) : [];
      const userChats = (chats || []).filter((ch) => {
        const rawId = stripJidDeviceTag(extractSerializedId(ch.id));
        return !ch.isGroup && isUserChatId(rawId);
      });

      const lidSet = new Set();
      for (const ch of userChats) {
        const rawId = stripJidDeviceTag(extractSerializedId(ch.id));
        if (rawId.endsWith('@lid')) lidSet.add(rawId);
      }
      const lidMap = await resolveLidsBatch(client, lidSet);

      let skippedByPreFilter = 0;
      let excludedThirdPartyCount = 0;
      let excludedOwnerOrExplicitCount = 0;
      let excludedOutboundOnlyCount = 0;
      const candidates = [];

      for (const ch of userChats) {
        const rawId = stripJidDeviceTag(extractSerializedId(ch.id));
        const lidEntry = rawId.endsWith('@lid') ? lidMap.get(rawId) : null;
        let chatId = lidEntry?.chatId || rawId;
        if (chatId.endsWith('@lid') && ownerChatId) {
          chatId = await resolveReverseOwnerLid(client, chatId, ownerChatId);
        }

        if (isExcluded(chatId) || (rawId !== chatId && isExcluded(rawId))) {
          excludedOwnerOrExplicitCount += 1;
          continue;
        }

        const chatState =
          store && typeof store.getChatState === 'function'
            ? store.getChatState(chatId)
            : {};

        if (
          typeof chatState?.thirdPartyOutreachUntil === 'number' &&
          nowMs < chatState.thirdPartyOutreachUntil
        ) {
          excludedThirdPartyCount += 1;
          continue;
        }

        const lastActivityMs = Math.max(
          toMs(ch.lastMessage?.timestamp ?? 0),
          toMs(ch.timestamp ?? 0),
          Number(chatState?.lastCustomerMessageAt || 0)
        );

        if (Number.isFinite(rangeStartMs) && lastActivityMs > 0 && lastActivityMs < rangeStartMs) {
          skippedByPreFilter += 1;
          continue;
        }

        const phone = lidEntry?.phone || (chatId.endsWith('@lid') ? '' : normalizePhone(chatId));
        const name = (ch.name || '').trim() || phone || chatId;
        candidates.push({
          chat: ch,
          chatId,
          phone,
          name,
          lastActivityMs,
          chatState,
        });
      }

      candidates.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
      const totalCandidates = candidates.length;
      const cap = Number.isFinite(Number(maxCandidates)) && maxCandidates > 0 ? Math.floor(maxCandidates) : 100;
      const truncated = totalCandidates > cap;
      const batch = candidates.slice(0, cap);

      const workerCount = Math.max(
        1,
        Math.min(Number.isFinite(Number(concurrency)) && concurrency > 0 ? Math.floor(concurrency) : 5, batch.length || 1)
      );
      const customers = [];
      let nextIdx = 0;

      async function runWorker() {
        while (nextIdx < batch.length) {
          const item = batch[nextIdx++];
          const msgs =
            typeof item.chat.fetchMessages === 'function'
              ? await item.chat.fetchMessages({ limit: historyLimit }).catch(() => [])
              : [];

          const allInRange = (msgs || []).filter((m) => {
            if (!m) return false;
            const ts = toMs(m.timestamp);
            if (!ts) return false;
            if (Number.isFinite(rangeStartMs) && ts < rangeStartMs) return false;
            if (Number.isFinite(rangeEndMs) && ts >= rangeEndMs) return false;
            return true;
          });

          const incoming = (msgs || []).filter((m) => m && !m.fromMe);
          const inRange = allInRange.filter((m) => !m.fromMe);

          if (inRange.length === 0) {
            if (allInRange.length > 0) {
              excludedOutboundOnlyCount += 1;
            }
            continue;
          }

          const inRangeTimes = inRange.map((m) => toMs(m.timestamp));
          const hadEarlierIncoming =
            (Number.isFinite(item.chatState?.firstSeenAt) &&
              Number.isFinite(rangeStartMs) &&
              item.chatState.firstSeenAt < rangeStartMs) ||
            incoming.some((m) => {
              const ts = toMs(m.timestamp);
              return ts > 0 && Number.isFinite(rangeStartMs) && ts < rangeStartMs;
            });
          const historyReachedLimit = (msgs || []).length >= historyLimit;
          const isNew = hadEarlierIncoming ? false : historyReachedLimit ? null : true;

          customers.push({
            chatId: item.chatId,
            phone: item.phone,
            name: item.name,
            isNew,
            messageCountInRange: inRange.length,
            firstMessageInRangeAt: Math.min(...inRangeTimes),
            lastMessageInRangeAt: Math.max(...inRangeTimes),
          });
        }
      }

      await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
      customers.sort((a, b) => b.lastMessageInRangeAt - a.lastMessageInRangeAt);

      return {
        customers,
        scannedChats: batch.length,
        totalCandidates,
        skippedByPreFilter,
        excludedCount: excludedOwnerOrExplicitCount + excludedThirdPartyCount,
        excludedThirdPartyCount,
        excludedOutboundOnlyCount,
        truncated,
      };
    },
  };
}
