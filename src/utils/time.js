export const ISTANBUL_TZ = 'Europe/Istanbul';
export const ISTANBUL_OFFSET_MS = 3 * 3600_000;

const WEEKDAY_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const ISTANBUL_DTF = new Intl.DateTimeFormat('en-US', {
  timeZone: ISTANBUL_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
});

export function getIstanbulYmd(ms) {
  const parts = ISTANBUL_DTF.formatToParts(new Date(ms));
  const map = {};
  for (const p of parts) {
    map[p.type] = p.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    dow: WEEKDAY_MAP[map.weekday] ?? 0,
  };
}

export function istanbulMidnightUtc(year, month, day) {
  return Date.UTC(year, month - 1, day, 0, 0, 0) - ISTANBUL_OFFSET_MS;
}

export function toIstanbulIso(utcMs) {
  if (!Number.isFinite(utcMs) || utcMs <= 0) return '';
  return new Date(utcMs + ISTANBUL_OFFSET_MS).toISOString().replace('Z', '+03:00');
}

export function formatTimestampToIstanbulIso(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  const ms = n > 1e12 ? n : n * 1000;
  return toIstanbulIso(ms);
}

function parseYmdDate(raw) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw || '').trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

export function resolveIstanbulPeriodRange(
  { period = 'this_month', startDate, endDate, fromDate, toDate } = {},
  nowMs = Date.now()
) {
  const normalizedPeriod = String(period || 'this_month').trim().toLowerCase();
  const { year, month, day, dow } = getIstanbulYmd(nowMs);
  const tomorrowMidnight = istanbulMidnightUtc(year, month, day + 1);

  switch (normalizedPeriod) {
    case 'today':
      return {
        ok: true,
        period: 'today',
        rangeStartMs: istanbulMidnightUtc(year, month, day),
        rangeEndMs: tomorrowMidnight,
      };
    case 'yesterday':
      return {
        ok: true,
        period: 'yesterday',
        rangeStartMs: istanbulMidnightUtc(year, month, day - 1),
        rangeEndMs: istanbulMidnightUtc(year, month, day),
      };
    case 'this_week': {
      const mondayOffset = (dow + 6) % 7;
      return {
        ok: true,
        period: 'this_week',
        rangeStartMs: istanbulMidnightUtc(year, month, day - mondayOffset),
        rangeEndMs: tomorrowMidnight,
      };
    }
    case 'this_month':
      return {
        ok: true,
        period: 'this_month',
        rangeStartMs: istanbulMidnightUtc(year, month, 1),
        rangeEndMs: istanbulMidnightUtc(year, month + 1, 1),
      };
    case 'last_month':
      return {
        ok: true,
        period: 'last_month',
        rangeStartMs: istanbulMidnightUtc(year, month - 1, 1),
        rangeEndMs: istanbulMidnightUtc(year, month, 1),
      };
    case 'last_7_days':
      return {
        ok: true,
        period: 'last_7_days',
        rangeStartMs: istanbulMidnightUtc(year, month, day - 6),
        rangeEndMs: tomorrowMidnight,
      };
    case 'last_30_days':
      return {
        ok: true,
        period: 'last_30_days',
        rangeStartMs: istanbulMidnightUtc(year, month, day - 29),
        rangeEndMs: tomorrowMidnight,
      };
    case 'custom': {
      const from = parseYmdDate(startDate || fromDate);
      const to = parseYmdDate(endDate || toDate);
      if (!from || !to) {
        return {
          ok: false,
          error: 'custom dönemi için geçerli startDate ve endDate (YYYY-MM-DD) gereklidir.',
        };
      }
      const startMs = istanbulMidnightUtc(from.year, from.month, from.day);
      const endMs = istanbulMidnightUtc(to.year, to.month, to.day + 1);
      if (startMs >= endMs) {
        return {
          ok: false,
          error: 'Başlangıç tarihi bitiş tarihinden sonra olamaz.',
        };
      }
      return {
        ok: true,
        period: 'custom',
        rangeStartMs: startMs,
        rangeEndMs: endMs,
      };
    }
    default:
      return {
        ok: false,
        error: `Geçersiz period değeri: ${normalizedPeriod}. Desteklenenler: today, yesterday, this_week, this_month, last_month, last_7_days, last_30_days, custom.`,
      };
  }
}
