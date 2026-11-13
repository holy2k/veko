/**
 * Normalizes Turkish characters into ASCII lowercase with collapsed whitespace.
 *
 * @param {string|null|undefined} text
 * @returns {string}
 */
export function normalizeTurkishText(text) {
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
