import { tooMany } from '../lib/errors.js';
import { config } from '../config/index.js';

/**
 * Response hardening for both the API and the served SPA.
 * `camera=(self)` is deliberate: the mobile fault-reporting flow opens the viewfinder to
 * decode an equipment QR code, and that feature must not depend on a blanket relaxation.
 */
export function securityHeaders(req, res, next) {
  const isHtml = !req.path.startsWith('/api/');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=(), usb=(), serial=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      // data: is needed for inline QR/data-URL thumbnails; blob: for the camera canvas.
      "img-src 'self' data: blob:",
      "script-src 'self'" + (config.isProd ? '' : " 'unsafe-inline'"),
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self'" + (config.isProd ? '' : ' ws: wss:'),
      "font-src 'self' data:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  if (config.isProd && !isHtml) res.setHeader('Cache-Control', 'no-store');
  next();
}

/**
 * In-memory fixed-window limiter, bucketed per (class, client).
 * Adequate for a department-scale deployment on one node.  If this is ever replicated
 * behind several processes, swap `buckets` for a shared store — the interface (a single
 * middleware factory) is the seam.
 */
const buckets = new Map();
const WINDOW = config.limits.rateWindowMs;

setInterval(() => {
  const cutoff = Date.now() - WINDOW * 2;
  for (const [key, b] of buckets) if (b.reset < cutoff) buckets.delete(key);
}, WINDOW * 2).unref();

export const clientIp = (req) =>
  (req.ip || req.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '');

function hit(key, max) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || bucket.reset <= now) {
    bucket = { count: 0, reset: now + WINDOW };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > max) return bucket;
  return null;
}

export const rateLimit = (max) => (req, _res, next) => {
  const over = hit(`${req.method === 'GET' ? 'r' : 'w'}:${max}:${clientIp(req)}`, max);
  if (over) {
    const retry = Math.ceil((over.reset - Date.now()) / 1000);
    return next(tooMany(`Too many requests. Try again in ${retry} seconds.`, retry));
  }
  return next();
};

export const globalLimit = () => rateLimit(config.limits.rateMax);
export const loginLimit = () => (req, res, next) =>
  rateLimit(config.limits.loginRateMax)(req, res, next);
export const writeLimit = () => (req, res, next) =>
  rateLimit(config.limits.writeRateMax)(req, res, next);
