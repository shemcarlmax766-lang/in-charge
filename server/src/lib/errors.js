/**
 * Typed application errors.  Anything thrown that is not an AppError is treated as a
 * bug: the message is logged and a generic 500 is returned, so internal details never
 * reach the browser.
 */
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }

  toBody() {
    const body = { error: { code: this.code, message: this.message } };
    if (this.details) body.error.details = this.details;
    return body;
  }
}

export const badRequest = (message, details) => new AppError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Authentication required', details) =>
  new AppError(401, 'unauthorized', message, details);
export const forbidden = (message = 'Your role is not permitted to perform this action', details) =>
  new AppError(403, 'forbidden', message, details);
export const notFound = (message = 'Not found') => new AppError(404, 'not_found', message);
export const conflict = (message, details) => new AppError(409, 'conflict', message, details);
export const unprocessable = (message, fieldErrors) =>
  new AppError(422, 'validation_failed', message, { fields: fieldErrors });
export const tooMany = (message = 'Too many requests', retryAfterSec = 60) =>
  new AppError(429, 'rate_limited', message, { retryAfterSeconds: retryAfterSec });
