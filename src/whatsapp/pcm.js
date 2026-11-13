function clampInt16(value) {
  const rounded = Math.round(value);
  if (rounded > 32767) return 32767;
  if (rounded < -32768) return -32768;
  return rounded;
}

/**
 * Decodes a base64 PCM16 (little-endian) string into an Int16Array.
 * Truncates any trailing odd byte cleanly instead of throwing RangeError.
 *
 * @param {string} b64
 * @returns {Int16Array}
 */
export function base64ToInt16Safely(b64) {
  if (!b64 || typeof b64 !== 'string') {
    return new Int16Array(0);
  }
  const buf = Buffer.from(b64, 'base64');
  const evenBytes = buf.length - (buf.length % 2);
  if (evenBytes <= 0) {
    return new Int16Array(0);
  }
  const sampleCount = evenBytes >>> 1;
  const out = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    out[i] = buf.readInt16LE(i * 2);
  }
  return out;
}

/**
 * Encodes an Int16Array (or numeric sample sequence) into base64 little-endian PCM16.
 *
 * @param {Int16Array | number[]} samples
 * @returns {string}
 */
export function int16ToBase64(samples) {
  if (!samples || !samples.length) {
    return '';
  }
  const int16 =
    samples instanceof Int16Array
      ? samples
      : Int16Array.from(samples, (v) => clampInt16(Number(v) || 0));
  return Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength).toString('base64');
}

/**
 * Linearly resamples mono 16-bit PCM audio between sample rates with Int16 clamping.
 *
 * @param {Int16Array | number[]} input
 * @param {number} fromRate
 * @param {number} toRate
 * @returns {Int16Array}
 */
export function resamplePcm16(input, fromRate, toRate) {
  if (!input || !input.length) {
    return new Int16Array(0);
  }
  if (
    !Number.isFinite(fromRate) ||
    !Number.isFinite(toRate) ||
    fromRate <= 0 ||
    toRate <= 0
  ) {
    throw new RangeError(`Invalid sample rates for resamplePcm16: ${fromRate} -> ${toRate}`);
  }

  const inLen = input.length;
  if (fromRate === toRate) {
    const copy = new Int16Array(inLen);
    for (let i = 0; i < inLen; i++) {
      copy[i] = clampInt16(input[i]);
    }
    return copy;
  }

  const outLen = Math.max(1, Math.round((inLen * toRate) / fromRate));
  const out = new Int16Array(outLen);
  const step = fromRate / toRate;

  for (let i = 0; i < outLen; i++) {
    const pos = i * step;
    const idx = Math.floor(pos);
    if (idx >= inLen - 1) {
      out[i] = clampInt16(input[inLen - 1]);
    } else {
      const frac = pos - idx;
      const s0 = input[idx];
      const s1 = input[idx + 1];
      out[i] = clampInt16(s0 + (s1 - s0) * frac);
    }
  }

  return out;
}
