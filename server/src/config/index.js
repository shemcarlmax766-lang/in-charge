import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// <root>/server/src/config/index.js → repository root is three levels up.
export const ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * Minimal .env loader (no dependency).  Real process environment always wins over
 * the file, so container/systemd configuration is never silently overridden.
 */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted = /^(['"])([\s\S]*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, ''); // strip trailing comment
    out[key] = value;
  }
  return out;
}

const fileEnv = loadDotEnv(path.join(ROOT, '.env'));

const env = { ...fileEnv, ...process.env };

const bool = (v, dflt) => (v === undefined ? dflt : /^(1|true|yes|on)$/i.test(String(v).trim()));
const int = (v, dflt) => {
  if (v === undefined || v === '' || v === null) return dflt;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
};
const str = (v, dflt) => (v === undefined || v === '' ? dflt : String(v));

const nodeEnv = str(env.NODE_ENV, 'development');
const isProd = nodeEnv === 'production';
const isTest = nodeEnv === 'test';

/**
 * Central configuration.  Every value that an operator could reasonably want to
 * change lives here and nowhere else — no credentials, no limits and no URLs are
 * hard-coded in feature code.
 */
export const config = {
  env: nodeEnv,
  isProd,
  isTest,
  root: ROOT,

  server: {
    host: str(env.HOST, '0.0.0.0'),
    port: int(env.PORT, 4000),
    // Public origin used to build the absolute URL encoded in QR labels.
    baseUrl: str(env.PUBLIC_BASE_URL, ''),
    trustProxy: bool(env.TRUST_PROXY, isProd),
    bodyLimit: str(env.BODY_LIMIT, '1mb'),
  },

  paths: {
    data: str(env.DATA_DIR, path.join(ROOT, 'data')),
    get database() {
      return str(env.DATABASE_PATH, path.join(this.data, 'bmems.sqlite'));
    },
    get uploads() {
      return str(env.UPLOAD_DIR, path.join(this.data, 'uploads'));
    },
    clientDist: path.join(ROOT, 'client', 'dist'),
  },

  auth: {
    sessionTtlHours: int(env.SESSION_TTL_HOURS, 12),
    rememberMeTtlHours: int(env.SESSION_REMEMBER_TTL_HOURS, 24 * 14),
    maxFailedAttempts: int(env.MAX_FAILED_LOGIN_ATTEMPTS, 6),
    lockoutMinutes: int(env.LOGIN_LOCKOUT_MINUTES, 15),
    minPasswordLength: int(env.MIN_PASSWORD_LENGTH, 12),
    // scrypt cost parameters — raise them if the server has headroom.
    scrypt: { N: int(env.SCRYPT_N, 16384), r: 8, p: 1, keylen: 64 },
  },

  uploads: {
    maxFiles: int(env.MAX_UPLOAD_FILES, 5),
    maxFileBytes: int(env.MAX_UPLOAD_MB, 8) * 1024 * 1024,
    // Extension allow-list *and* magic-byte sniffing must both agree.
    allowedMime: (env.UPLOAD_ALLOWED_MIME || 'image/jpeg,image/png,image/webp,image/gif,application/pdf')
      .split(',').map((s) => s.trim()).filter(Boolean),
    allowedExt: (env.UPLOAD_ALLOWED_EXT || '.jpg,.jpeg,.png,.webp,.gif,.pdf,.txt,.csv,.docx')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  },

  limits: {
    rateWindowMs: int(env.RATE_WINDOW_MS, 60_000),
    rateMax: int(env.RATE_MAX, isTest ? 100_000 : 300),
    loginRateMax: int(env.LOGIN_RATE_MAX, isTest ? 100_000 : 12),
    writeRateMax: int(env.WRITE_RATE_MAX, isTest ? 100_000 : 60),
    listPageSize: int(env.LIST_PAGE_SIZE, 25),
    maxPageSize: int(env.MAX_PAGE_SIZE, 100),
  },

  demo: {
    // Seed password.  If unset, the seeder generates a strong random one and prints it.
    password: str(env.SEED_PASSWORD, ''),
    force: bool(env.SEED_DEMO_DATA, true),
  },

  // Notification channels other than in-app are opt-in; the dispatcher records a
  // `skipped` delivery with the reason so the trail stays honest.
  notify: {
    email: bool(env.ENABLE_EMAIL_NOTIFY, false),
    sms: bool(env.ENABLE_SMS_NOTIFY, false),
    push: bool(env.ENABLE_PUSH_NOTIFY, false),
  },
};

/** Fail fast on nonsensical configuration rather than at first request. */
export function assertConfig() {
  const problems = [];
  if (config.uploads.maxFileBytes <= 0) problems.push('MAX_UPLOAD_MB must be > 0');
  if (config.auth.minPasswordLength < 8) problems.push('MIN_PASSWORD_LENGTH must be >= 8');
  if (config.auth.sessionTtlHours <= 0) problems.push('SESSION_TTL_HOURS must be > 0');
  if (isProd && !config.server.baseUrl) {
    problems.push('PUBLIC_BASE_URL is required in production (it is embedded in QR labels)');
  }
  if (problems.length) {
    throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
}
