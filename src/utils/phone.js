/**
 * Normalizes a phone number to standard international digit format.
 * Specifically converts Turkish domestic formats (05XX, 5XX) to 905XX.
 * Strips WhatsApp JID domain suffixes (@c.us, @s.whatsapp.net) and device tags (:0).
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizePhone(raw) {
  if (!raw) return '';
  const str = String(raw).trim();
  const userPart = str.split('@')[0].split(':')[0];
  let digits = userPart.replace(/\D/g, '');

  if (digits.startsWith('05') && digits.length === 11) {
    digits = '90' + digits.slice(1);
  } else if (digits.startsWith('5') && digits.length === 10) {
    digits = '90' + digits;
  }

  return digits;
}

/**
 * Converts a phone number or raw JID into a normalized WhatsApp user JID (<digits>@c.us).
 * Returns empty string if the phone cannot be normalized.
 *
 * @param {string} phone
 * @returns {string}
 */
export function toWhatsAppId(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return '';
  return `${normalized}@c.us`;
}

export function stripJidDeviceTag(jid) {
  const trimmed = String(jid || '').trim();
  const atIdx = trimmed.indexOf('@');
  if (atIdx === -1) return trimmed;
  const userPart = trimmed.slice(0, atIdx).split(':')[0];
  const domain = trimmed.slice(atIdx + 1).toLowerCase();
  return `${userPart}@${domain}`;
}

/**
 * Checks whether two phone numbers or JIDs refer to the exact same normalized phone.
 * Returns false if either input is empty or invalid.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function phonesMatch(a, b) {
  const normA = normalizePhone(a);
  const normB = normalizePhone(b);
  if (!normA || !normB) return false;
  return normA === normB;
}
