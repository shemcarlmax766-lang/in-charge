import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { nowIso } from '../lib/time.js';

/**
 * Outbound mail transport — the adapter `docs/INTEGRATIONS.md` promised.
 *
 * Two channels, chosen by configuration only (no credentials in code):
 *  - SMTP via nodemailer, when SMTP_HOST is set. Failures are *returned*, never thrown:
 *    a dead relay must not fail the business request that triggered the mail.
 *  - an outbox file under `<DATA_DIR>/outbox/`, when no SMTP host is configured. The mail
 *    becomes a real artifact you can open — honest for demos and a drop-in for campus relays
 *    that only accept local submissions.
 *
 * Every send reports what it did, so the caller can persist that status in its own ledger.
 */

let transporter = null;

export function mailConfigured() {
  return Boolean(config.mail.host);
}

const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms).unref()),
]);

function slugAddress(email) {
  return String(email).replace(/[^a-z0-9.]+/gi, '_').slice(0, 64);
}

/** @returns {Promise<{status:'sent'|'failed', channel:'smtp'|'outbox', detail:string}>} */
export async function sendMail({ to, subject, text }) {
  const envelope = { from: config.mail.from, to, subject, text };

  if (mailConfigured()) {
    try {
      const mod = await import('nodemailer');
      const nodemailer = mod.default ?? mod;
      transporter ??= nodemailer.createTransport({
        host: config.mail.host,
        port: config.mail.port,
        secure: config.mail.secure,
        ...(config.mail.user ? { auth: { user: config.mail.user, pass: config.mail.pass } } : {}),
      });
      const info = await withTimeout(transporter.sendMail(envelope), config.mail.timeoutMs, 'SMTP send');
      return { status: 'sent', channel: 'smtp', detail: `accepted for delivery (${info.messageId ?? 'no message id'})` };
    } catch (err) {
      return { status: 'failed', channel: 'smtp', detail: String(err?.message ?? err).slice(0, 300) };
    }
  }

  try {
    const dir = path.join(config.paths.data, 'outbox');
    fs.mkdirSync(dir, { recursive: true });
    const file = `${new Date().toISOString().replace(/[:.]/g, '-')}-${slugAddress(to)}.txt`;
    fs.writeFileSync(
      path.join(dir, file),
      [
        `Date: ${nowIso()}`,
        `From: ${config.mail.from}`,
        `To: ${to}`,
        `Subject: ${subject}`,
        '',
        text,
        '',
        '— written by the BEM-FRS outbox adapter (SMTP_HOST is not set on this deployment).',
      ].join('\n'),
      'utf8',
    );
    console.log(`[mail] outbox → data/outbox/${file}  (“${subject}” → ${to})`);
    return { status: 'sent', channel: 'outbox', detail: `data/outbox/${file}` };
  } catch (err) {
    return { status: 'failed', channel: 'outbox', detail: String(err?.message ?? err).slice(0, 300) };
  }
}
