import { ISTANBUL_TZ, getIstanbulYmd, istanbulMidnightUtc } from '../utils/time.js';

export const VALID_CALL_POLICIES = ['smart', 'always', 'on_demand'];
export const VALID_RESUME_MODES = ['auto', 'ask'];
export const DEFAULT_CALL_POLICY = 'smart';
export const DEFAULT_CALL_DELAY_MINUTES = 10;
export const DEFAULT_QUIET_START = '22:00';
export const DEFAULT_QUIET_END = '09:00';
export const DEFAULT_RESUME_MODE = 'auto';

const ISTANBUL_TIME_DTF = new Intl.DateTimeFormat('en-US', {
  timeZone: ISTANBUL_TZ,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function formatTwo(n) {
  return String(n).padStart(2, '0');
}

/**
 * Parses a 24-hour `HH:MM` (or `H:MM`) clock string.
 *
 * @param {string|null|undefined} raw
 * @returns {{ hour: number, minute: number, totalMinutes: number, formatted: string } | null}
 */
export function parseHhMm(raw) {
  if (typeof raw !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return {
    hour,
    minute,
    totalMinutes: hour * 60 + minute,
    formatted: `${formatTwo(hour)}:${formatTwo(minute)}`,
  };
}

/**
 * Returns `Europe/Istanbul` date + time parts for the supplied UTC timestamp.
 *
 * @param {number} [nowMs=Date.now()]
 * @returns {{ year: number, month: number, day: number, ymd: string, hour: number, minute: number, totalMinutes: number, hhMm: string }}
 */
export function getIstanbulTimeParts(nowMs = Date.now()) {
  const { year, month, day } = getIstanbulYmd(nowMs);
  const timeParts = ISTANBUL_TIME_DTF.formatToParts(new Date(nowMs));
  const map = {};
  for (const p of timeParts) {
    map[p.type] = p.value;
  }
  let hour = Number(map.hour);
  if (hour === 24) hour = 0;
  const minute = Number(map.minute);
  return {
    year,
    month,
    day,
    ymd: `${year}-${formatTwo(month)}-${formatTwo(day)}`,
    hour,
    minute,
    totalMinutes: hour * 60 + minute,
    hhMm: `${formatTwo(hour)}:${formatTwo(minute)}`,
  };
}

/**
 * Resolves the next UTC millisecond matching `hhMm` in `Europe/Istanbul`.
 *
 * @param {string} hhMm
 * @param {number} [nowMs=Date.now()]
 * @returns {number | null}
 */
export function computeIstanbulTimeTargetMs(hhMm, nowMs = Date.now()) {
  const parsed = parseHhMm(hhMm);
  if (!parsed) return null;
  const { year, month, day } = getIstanbulTimeParts(nowMs);
  const todayTarget = istanbulMidnightUtc(year, month, day) + parsed.totalMinutes * 60_000;
  if (todayTarget >= nowMs) {
    return todayTarget;
  }
  if (nowMs - todayTarget < 60_000) {
    return nowMs + 60_000;
  }
  return istanbulMidnightUtc(year, month, day + 1) + parsed.totalMinutes * 60_000;
}

/**
 * Validates and normalizes a partial runtime settings update from `.env` or AI tools.
 *
 * @param {object} [patch={}]
 * @returns {{ ok: boolean, patch?: object, error?: string }}
 */
export function validateSettingsPatch(patch = {}) {
  if (!patch || typeof patch !== 'object') {
    return { ok: false, error: 'Ayar güncellemesi geçerli bir nesne olmalıdır.' };
  }

  const out = {};

  if ('callPolicy' in patch && patch.callPolicy !== undefined) {
    const val = String(patch.callPolicy).trim().toLowerCase();
    if (!VALID_CALL_POLICIES.includes(val)) {
      return {
        ok: false,
        error: `Geçersiz callPolicy: "${patch.callPolicy}". Desteklenenler: ${VALID_CALL_POLICIES.join(', ')}.`,
      };
    }
    out.callPolicy = val;
  }

  if ('callDelayMinutes' in patch && patch.callDelayMinutes !== undefined) {
    const num = Number(patch.callDelayMinutes);
    if (!Number.isFinite(num) || num < 0 || num > 180) {
      return {
        ok: false,
        error: 'callDelayMinutes 0 ile 180 arasında bir sayı olmalıdır.',
      };
    }
    out.callDelayMinutes = Math.round(num * 100) / 100;
  }

  if ('quietHoursEnabled' in patch && patch.quietHoursEnabled !== undefined) {
    if (typeof patch.quietHoursEnabled !== 'boolean') {
      return { ok: false, error: 'quietHoursEnabled boolean (true/false) olmalıdır.' };
    }
    out.quietHoursEnabled = patch.quietHoursEnabled;
  }

  if ('quietHoursStart' in patch && patch.quietHoursStart !== undefined) {
    const parsed = parseHhMm(String(patch.quietHoursStart));
    if (!parsed) {
      return { ok: false, error: 'quietHoursStart HH:MM (24 saat, ör. 22:00) formatında olmalıdır.' };
    }
    out.quietHoursStart = parsed.formatted;
  }

  if ('quietHoursEnd' in patch && patch.quietHoursEnd !== undefined) {
    const parsed = parseHhMm(String(patch.quietHoursEnd));
    if (!parsed) {
      return { ok: false, error: 'quietHoursEnd HH:MM (24 saat, ör. 09:00) formatında olmalıdır.' };
    }
    out.quietHoursEnd = parsed.formatted;
  }

  if ('quietHoursResumeMode' in patch && patch.quietHoursResumeMode !== undefined) {
    const val = String(patch.quietHoursResumeMode).trim().toLowerCase();
    if (!VALID_RESUME_MODES.includes(val)) {
      return {
        ok: false,
        error: `Geçersiz quietHoursResumeMode: "${patch.quietHoursResumeMode}". Desteklenenler: auto, ask.`,
      };
    }
    out.quietHoursResumeMode = val;
  }

  if ('quietHoursAllowUrgent' in patch && patch.quietHoursAllowUrgent !== undefined) {
    if (typeof patch.quietHoursAllowUrgent !== 'boolean') {
      return { ok: false, error: 'quietHoursAllowUrgent boolean (true/false) olmalıdır.' };
    }
    out.quietHoursAllowUrgent = patch.quietHoursAllowUrgent;
  }

  return { ok: true, patch: out };
}

/**
 * Resolves effective runtime call & quiet-hours settings (`store` overrides > `.env` config > fallbacks).
 * Preserves legacy `'always'` / `0m` defaults when raw unit-test configs omit `callPolicy`.
 *
 * @param {object} [config={}]
 * @param {object|null} [store=null]
 * @returns {{
 *   callPolicy: 'smart' | 'always' | 'on_demand',
 *   callDelayMinutes: number,
 *   quietHoursEnabled: boolean,
 *   quietHoursStart: string,
 *   quietHoursEnd: string,
 *   quietHoursResumeMode: 'auto' | 'ask',
 *   quietHoursAllowUrgent: boolean,
 * }}
 */
export function resolveCallSettings(config = {}, store = null) {
  const overrides = store?.getCallSettingsOverrides?.() || {};

  const rawPolicy = overrides.callPolicy ?? config?.callPolicy;
  const callPolicy = VALID_CALL_POLICIES.includes(String(rawPolicy || '').trim().toLowerCase())
    ? String(rawPolicy).trim().toLowerCase()
    : rawPolicy === undefined
      ? 'always'
      : DEFAULT_CALL_POLICY;

  const rawDelay = overrides.callDelayMinutes ?? config?.callDelayMinutes;
  const parsedDelay = Number(rawDelay);
  const callDelayMinutes =
    rawDelay !== undefined && Number.isFinite(parsedDelay) && parsedDelay >= 0
      ? parsedDelay
      : callPolicy === 'smart'
        ? DEFAULT_CALL_DELAY_MINUTES
        : 0;

  const quietHoursEnabled =
    typeof overrides.quietHoursEnabled === 'boolean'
      ? overrides.quietHoursEnabled
      : Boolean(config?.quietHoursEnabled);

  const startParsed = parseHhMm(String(overrides.quietHoursStart ?? config?.quietHoursStart ?? DEFAULT_QUIET_START));
  const endParsed = parseHhMm(String(overrides.quietHoursEnd ?? config?.quietHoursEnd ?? DEFAULT_QUIET_END));

  const rawResumeMode = overrides.quietHoursResumeMode ?? config?.quietHoursResumeMode ?? DEFAULT_RESUME_MODE;
  const quietHoursResumeMode = VALID_RESUME_MODES.includes(String(rawResumeMode).trim().toLowerCase())
    ? String(rawResumeMode).trim().toLowerCase()
    : DEFAULT_RESUME_MODE;

  const quietHoursAllowUrgent =
    typeof overrides.quietHoursAllowUrgent === 'boolean'
      ? overrides.quietHoursAllowUrgent
      : Boolean(config?.quietHoursAllowUrgent);

  return {
    callPolicy,
    callDelayMinutes,
    quietHoursEnabled,
    quietHoursStart: startParsed ? startParsed.formatted : DEFAULT_QUIET_START,
    quietHoursEnd: endParsed ? endParsed.formatted : DEFAULT_QUIET_END,
    quietHoursResumeMode,
    quietHoursAllowUrgent,
  };
}

/**
 * Checks whether `nowMs` falls inside the configured `Europe/Istanbul` quiet hours window.
 *
 * @param {object} settings
 * @param {number} [nowMs=Date.now()]
 * @returns {boolean}
 */
export function isScheduledQuietAt(settings, nowMs = Date.now()) {
  if (!settings?.quietHoursEnabled) return false;
  const start = parseHhMm(settings.quietHoursStart || DEFAULT_QUIET_START);
  const end = parseHhMm(settings.quietHoursEnd || DEFAULT_QUIET_END);
  if (!start || !end || start.totalMinutes === end.totalMinutes) return false;

  const { totalMinutes } = getIstanbulTimeParts(nowMs);
  if (start.totalMinutes > end.totalMinutes) {
    return totalMinutes >= start.totalMinutes || totalMinutes < end.totalMinutes;
  }
  return totalMinutes >= start.totalMinutes && totalMinutes < end.totalMinutes;
}

/**
 * Evaluates full quiet-hours status including manual snooze and morning `ask` confirmation gate.
 *
 * @param {object} settings
 * @param {object} [scheduleState={}]
 * @param {number} [nowMs=Date.now()]
 * @param {number} [quietQueueCount=0]
 * @returns {{
 *   isQuietNow: boolean,
 *   scheduledQuiet: boolean,
 *   snoozeActive: boolean,
 *   awaitingOwnerConfirm: boolean,
 *   shouldSendMorningPrompt: boolean,
 *   shouldDeliverPostSnoozeDigest: boolean,
 *   todayYmd: string,
 *   hhMm: string,
 * }}
 */
export function evaluateQuietStatus(settings, scheduleState = {}, nowMs = Date.now(), quietQueueCount = 0) {
  const { ymd: todayYmd, hhMm } = getIstanbulTimeParts(nowMs);
  const scheduledQuiet = isScheduledQuietAt(settings, nowMs);
  const snoozeActive =
    typeof scheduleState?.snoozedUntilMs === 'number' &&
    Number.isFinite(scheduleState.snoozedUntilMs) &&
    nowMs < scheduleState.snoozedUntilMs;

  const hasStaleMorningPromptYmd =
    typeof scheduleState?.lastMorningPromptYmd === 'string' &&
    scheduleState.lastMorningPromptYmd.trim() !== '' &&
    scheduleState.lastMorningPromptYmd.trim() !== todayYmd;

  const awaitingOwnerConfirm = Boolean(
    settings?.quietHoursEnabled &&
      settings?.quietHoursResumeMode === 'ask' &&
      !scheduledQuiet &&
      scheduleState?.awaitingOwnerConfirm === true &&
      !hasStaleMorningPromptYmd &&
      scheduleState?.resumeConfirmedYmd !== todayYmd
  );

  const isQuietNow = Boolean(
    (settings?.quietHoursEnabled && (scheduledQuiet || awaitingOwnerConfirm)) || snoozeActive
  );

  const hadQuietWork = Boolean(scheduleState?.wasQuietPendingResume) || quietQueueCount > 0;
  const shouldSendMorningPrompt = Boolean(
    settings?.quietHoursEnabled &&
      !scheduledQuiet &&
      !snoozeActive &&
      !awaitingOwnerConfirm &&
      hadQuietWork &&
      scheduleState?.lastMorningPromptYmd !== todayYmd
  );

  const shouldDeliverPostSnoozeDigest = Boolean(
    !scheduledQuiet &&
      !snoozeActive &&
      !awaitingOwnerConfirm &&
      scheduleState?.pendingSnoozeDigest === true
  );

  return {
    isQuietNow,
    scheduledQuiet,
    snoozeActive,
    awaitingOwnerConfirm,
    shouldSendMorningPrompt,
    shouldDeliverPostSnoozeDigest,
    todayYmd,
    hhMm,
  };
}

/**
 * Formats queued quiet-hours customer summaries into a consolidated Turkish digest.
 *
 * @param {Array<object>} [queueItems=[]]
 * @param {{ header?: string }} [options={}]
 * @returns {string}
 */
export function formatQuietDigestMessage(queueItems = [], { header = '🌙 Gece/Mesai dışı bekleyen mesajlar:' } = {}) {
  const items = Array.isArray(queueItems) ? queueItems : [];
  if (items.length === 0) return '';

  const priorityLabel = {
    critical: '🔴 Çok Acil',
    urgent: '🟠 Acil',
    normal: '• Normal',
  };

  const lines = [header];
  for (const item of items) {
    const label = priorityLabel[item?.priority] || priorityLabel.normal;
    const who = item?.customerName || item?.phone || item?.chatId || 'Müşteri';
    const timeStr = Number.isFinite(item?.lastAtMs) ? getIstanbulTimeParts(item.lastAtMs).hhMm : '--:--';
    const countPart = (Number(item?.messageCount) || 1) > 1 ? ` (${item.messageCount} mesaj)` : '';
    const detail = item?.summary || item?.latestMessage || '';
    lines.push(`${label} ${who}${countPart} [${timeStr}]: ${detail}`);
  }
  return lines.join('\n');
}
