import { createHash, randomBytes, randomInt } from 'node:crypto';

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Opaque session / reset tokens. 256 bits of entropy, base64url-safe alphabet. */
export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

/** Only the hash of a token is persisted, so a database leak cannot replay sessions. */
export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function csrfToken() {
  return randomToken(24);
}

const WORDS = 'harbor valve probe cable sensor module circuit filter gauge relay scope clamp'.split(' ');

/**
 * Password for auto-created accounts.  Deliberately pronounceable-ish but random;
 * returned once to the admin and never stored in plaintext (must_change_password=1).
 */
export function generatePassword(wordCount = 3) {
  const words = Array.from({ length: wordCount }, () => WORDS[randomInt(WORDS.length)]);
  const tail = randomInt(1000, 10000);
  const cap = words.map((w, i) => (i === 1 ? w[0].toUpperCase() + w.slice(1) : w)).join('-');
  return `${cap}${tail}`;
}

/** Equipment asset tag / QR short code, e.g. BMU-ECG-0007 */
export function assetTag(categoryCode, sequence) {
  const code = String(categoryCode || 'GEN').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'GEN';
  return `BMU-${code}-${String(sequence).padStart(4, '0')}`;
}

/** Human reference, e.g. FLT-2026-0041 */
export function reference(prefix, year, sequence) {
  return `${prefix}-${year}-${String(sequence).padStart(4, '0')}`;
}
