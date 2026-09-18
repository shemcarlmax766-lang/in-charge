import fs from 'node:fs';
import multer from 'multer';
import { config } from '../config/index.js';
import { AppError, badRequest } from '../lib/errors.js';

/** Express error plumbing: consistent JSON shape, no stack or internals in responses. */

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` } });
}

// eslint-disable-next-line no-unused-vars -- Express identifies error middleware by arity
export function errorHandler(err, req, res, next) {
  let e = err;

  if (err instanceof multer.MulterError) {
    e = err.code === 'LIMIT_FILE_SIZE'
      ? badRequest(`Each file must be at most ${Math.round(config.uploads.maxFileBytes / 1024 / 1024)} MB`)
      : badRequest(`Upload rejected (${err.code})`);
  }

  if (e instanceof SyntaxError && 'body' in e) e = badRequest('Request body is not valid JSON');
  if (!(e instanceof AppError)) {
    // Unplanned failure: log it fully, tell the client only that it failed.
    console.error(`[unhandled] ${req.method} ${req.originalUrl}`, e);
    e = new AppError(500, 'internal_error', 'The request could not be completed. The problem has been logged.');
  }

  if (res.headersSent) return next(e);
  const body = e.toBody ? e.toBody() : { error: { code: e.code, message: e.message } };
  if (config.env === 'development' && e.status >= 500) body.error.stack = e.stack;
  if (e.status === 429 && e.details?.retryAfterSeconds) {
    res.setHeader('Retry-After', String(e.details.retryAfterSeconds));
  }
  return res.status(e.status).json(body);
}

/** Wraps async route handlers so rejections reach the error handler. */
export const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Multipart uploads are buffered in memory (max 8 MB × 5 files by policy) so the bytes can
 * be content-sniffed *before* anything touches disk.  Spilling to a temp file first would
 * mean writing unvalidated content, which is exactly what a virus-scanning-free
 * departmental server must not do.
 */
export const collectFiles = (field = 'files', maxFiles = config.uploads.maxFiles) => {
  const mw = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: config.uploads.maxFileBytes,
      files: maxFiles,
      fields: 40,
      fieldSize: 64 * 1024,
      // Prevent zip-bomb style archive bombs from being buffered at all.
    },
    fileFilter: (_req, file, cb) => {
      const ext = (file.originalname.match(/\.[A-Za-z0-9]+$/) || [''])[0].toLowerCase();
      if (!config.uploads.allowedExt.includes(ext)) {
        return cb(badRequest(`File type "${ext || 'unknown'}" is not allowed`), false);
      }
      return cb(null, true);
    },
  }).array(field, maxFiles);
  return (req, res, next) => mw(req, res, (err) => (err ? next(err) : next()));
};

export function cleanupUploads(files) {
  for (const f of files ?? []) {
    if (f?.path) { try { fs.unlinkSync(f.path); } catch { /* ignore */ } }
  }
}
