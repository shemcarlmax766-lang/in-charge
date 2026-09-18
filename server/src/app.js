import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config/index.js';
import { getDb } from './lib/db.js';
import { apiRouter } from './routes/index.js';
import { authenticate, csrfGuard } from './middleware/auth.js';
import { globalLimit, securityHeaders } from './middleware/security.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { badRequest } from './lib/errors.js';

const ALLOWED_WRITE_TYPES = [/^application\/json\b/i, /^multipart\/form-data\b/i, /^application\/x-www-form-urlencoded\b/i, ''];

/**
 * Express 5 application, built by a factory so tests boot the real app (same middleware
 * order, same guards) against a throwaway database.
 */
/**
 * @param {object} opts
 * @param {boolean} [opts.serveClient] serve the built SPA from client/dist (off in tests)
 * The database handle comes from `lib/db.js#getDb()`; tests install their own with `setDb()`.
 */
export function createApp({ serveClient = true } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  if (config.server.trustProxy) app.set('trust proxy', 1);

  app.use(securityHeaders);
  if (config.server.nativeOrigins.length) {
    // CORS for native app shells ONLY, and only for explicitly listed origins. Web deployments
    // leave NATIVE_ORIGINS unset and this middleware is not even mounted. Bearer auth + the CSRF
    // exemption for bearer requests keep the security model identical for these clients.
    const allowed = new Set(config.server.nativeOrigins);
    app.use('/api', (req, res, next) => {
      const origin = req.headers.origin;
      if (origin && allowed.has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-bm-csrf, accept');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
        res.setHeader('Access-Control-Max-Age', '600');
        if (req.method === 'OPTIONS') return res.status(204).end();
      }
      return next();
    });
  }
  app.use((req, res, next) => {
    // Only reject when a body is actually present, so a bare POST stays valid.
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.headers['content-type'] !== undefined
      && !ALLOWED_WRITE_TYPES.some((t) => (t instanceof RegExp ? t.test(req.headers['content-type']) : req.headers['content-type'] === t))) {
      return next(badRequest(`Unsupported Content-Type “${req.headers['content-type']}”. Use application/json or multipart/form-data.`));
    }
    return next();
  });
  app.use(express.json({ limit: config.server.bodyLimit }));
  app.use(express.urlencoded({ extended: false, limit: '200kb' }));

  app.get('/api/health', (req, res) => {
    const database = getDb();
    const counts = database.get(
      `SELECT (SELECT COUNT(*) FROM equipment) AS equipment,
              (SELECT COUNT(*) FROM fault_reports) AS faults,
              (SELECT COUNT(*) FROM fault_reports WHERE status IN ('reported','assigned','acknowledged','under_inspection','under_repair','awaiting_parts')) AS open_faults,
              (SELECT COUNT(*) FROM users WHERE is_active = 1) AS users`,
    );
    res.json({
      status: 'ok',
      service: 'BEM-FRS API',
      time: new Date().toISOString(),
      environment: config.env,
      counts,
    });
  });

  app.use('/api/v1', globalLimit(), authenticate, csrfGuard, apiRouter());

  if (serveClient && fs.existsSync(config.paths.clientDist)) {
    // Cache policy has to distinguish content-hashed files from the rest: Vite emits immutable
    // /assets/*.<hash>.js chunks, but index.html, the manifest, icons and sw.js are NOT hashed —
    // serving those with 1y/immutable pins a stale shell over every future deploy.
    const assetsDir = path.join(config.paths.clientDist, 'assets');
    app.use('/assets', express.static(assetsDir, {
      index: false,
      maxAge: config.isProd ? '1y' : 0,
      immutable: config.isProd,
    }));
    app.use(express.static(config.paths.clientDist, { index: false, maxAge: 0 }));
    // SPA deep links (including QR targets such as /e/BMU-ECG-0007) resolve to the shell.
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
      if (req.path.startsWith('/assets/')) return next(); // missing chunk → 404, not shell HTML
      const index = path.join(config.paths.clientDist, 'index.html');
      if (!fs.existsSync(index)) return next();
      return res.type('html').set('Cache-Control', 'no-cache').sendFile(index);
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
