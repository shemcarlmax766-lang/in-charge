import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config/index.js';

const scryptAsync = promisify(scrypt);

/**
 * Password storage: scrypt (memory-hard, in the Node standard library — no native build).
 * Stored as `scrypt$N$r$p$salt$hash`, so cost parameters can be raised later and old
 * hashes still verify and are transparently upgraded on next login.
 */
export async function hashPassword(plain, params = config.auth.scrypt) {
  if (typeof plain !== 'string' || plain.length === 0) throw new Error('password required');
  const salt = randomBytes(16);
  const derived = await scryptAsync(normalize(plain), salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 256 * 1024 * 1024,
  });
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64'), derived.toString('base64')].join('$');
}

/** Unicode-normalised so visually identical passwords behave identically. */
const normalize = (s) => s.normalize('NFKC');

export async function verifyPassword(plain, stored) {
  if (typeof plain !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(normalize(plain), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: 256 * 1024 * 1024,
  });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** True when the stored hash used weaker parameters than the current policy. */
export function needsRehash(stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  const { N, r, p } = config.auth.scrypt;
  return Number(parts[1]) !== N || Number(parts[2]) !== r || Number(parts[3]) !== p;
}

const COMMON = new Set([
  'password', 'password1', 'password123', 'passw0rd', 'qwerty', 'qwertyuiop', '12345678',
  '123456789', '1234567890', 'letmein', 'welcome', 'welcome1', 'admin', 'administrator',
  'abc123456', 'iloveyou', 'monkey', 'dragon', 'sunshine', 'princess', 'football', 'baseball',
  'changeme', 'default', 'guest', 'school', 'hospital', 'biomedical', 'engineering',
]);

/**
 * Password policy.  Length beats character-class gymnastics for resistance and is far
 * friendlier to type on a phone in a lab, so the department policy is: long, at least three
 * character families, not a common password, not the user's own name/email.
 * @returns {string[]} human-readable problems (empty ⇒ acceptable)
 */
export function passwordProblems(plain, { fullName = '', email = '' } = {}) {
  const problems = [];
  const pwd = String(plain ?? '');
  const min = config.auth.minPasswordLength;
  if (pwd.length < min) problems.push(`Use at least ${min} characters`);
  if (pwd.length > 200) problems.push('Password is too long (200 characters max)');

  const families = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(pwd)).length;
  if (families < 3) problems.push('Mix lower-case, upper-case, digits or symbols (any three)');

  const lower = pwd.toLowerCase();
  if (COMMON.has(lower)) problems.push('That password is too common to be allowed');
  for (const banned of [fullName, email.split('@')[0]]) {
    const b = String(banned ?? '').trim().toLowerCase();
    if (b.length >= 4 && lower.includes(b)) problems.push('Do not reuse your name or username');
  }
  if (/(.)\1{3,}/.test(pwd)) problems.push('Avoid four or more repeated characters');
  return problems;
}
