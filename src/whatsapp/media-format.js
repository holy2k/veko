function parseDurationSeconds(rawDuration) {
  if (rawDuration === undefined || rawDuration === null || rawDuration === '') {
    return null;
  }
  const num = Number(rawDuration);
  if (!Number.isFinite(num) || num < 0) {
    return null;
  }
  return Math.round(num);
}

function isLikelyBase64Blob(text) {
  return text.length >= 80 && !/\s/.test(text) && /^[A-Za-z0-9+/]+={0,2}$/.test(text);
}

function buildMediaLabel(type, msg) {
  const durationSec = parseDurationSeconds(
    msg.duration ?? msg._data?.duration ?? msg.rawData?.duration
  );
  const filename = String(
    msg.filename ?? msg._data?.filename ?? msg.rawData?.filename ?? ''
  ).trim();

  switch (type) {
    case 'ptt':
    case 'audio':
      return durationSec !== null ? `[Sesli mesaj, ${durationSec} sn]` : '[Sesli mesaj]';
    case 'image':
      return '[Fotoğraf]';
    case 'video':
      return durationSec !== null ? `[Video, ${durationSec} sn]` : '[Video]';
    case 'document':
      return filename ? `[Dosya: ${filename}]` : '[Dosya]';
    case 'sticker':
      return '[Çıkartma]';
    case 'location':
      return '[Konum]';
    case 'vcard':
    case 'multi_vcard':
      return '[Kişi kartı]';
    case 'revoked':
      return '[Silinen mesaj]';
    case 'call_log':
      return '[Arama kaydı]';
    default:
      return null;
  }
}

/**
 * Formats a WhatsApp message into a lightweight Turkish placeholder label plus optional caption/body
 * without downloading media payloads.
 *
 * @param {object|null|undefined} msg
 * @returns {string}
 */
export function formatMessageBody(msg) {
  if (!msg || typeof msg !== 'object') return '';

  const type = msg.type || 'chat';
  const rawBody = msg.body ?? msg.caption ?? '';
  const trimmedBody = typeof rawBody === 'string' ? rawBody.trim() : String(rawBody).trim();

  if (type === 'chat') {
    return trimmedBody;
  }

  const label = buildMediaLabel(type, msg);
  if (!label) {
    return isLikelyBase64Blob(trimmedBody) ? '' : trimmedBody;
  }

  const rawFallbackCaption = msg.caption ?? msg.description ?? msg._data?.caption ?? '';
  const trimmedFallbackCaption =
    typeof rawFallbackCaption === 'string'
      ? rawFallbackCaption.trim()
      : String(rawFallbackCaption).trim();

  const candidateCaption =
    trimmedBody && !isLikelyBase64Blob(trimmedBody) ? trimmedBody : trimmedFallbackCaption;
  const safeCaption = isLikelyBase64Blob(candidateCaption) ? '' : candidateCaption;

  return safeCaption ? `${label} ${safeCaption}` : label;
}
