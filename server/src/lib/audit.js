import { getDb } from './db.js';
import { nowIso } from './time.js';

const REDACT = new Set(['password', 'password_hash', 'current_password', 'new_password', 'token', 'csrf_token']);

const scrub = (obj) => {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = REDACT.has(k.toLowerCase()) ? '[redacted]' : v;
  return out;
};

const json = (v) => (v === undefined || v === null ? null : JSON.stringify(scrub(v)));

/**
 * Append-only audit trail.  Written inside the caller's transaction so an action and its
 * audit row commit or vanish together — a log that can disagree with the data is worse
 * than no log.  Credentials are scrubbed before serialisation.
 */
export function audit({ actor, action, entityType, entityId = null, entityRef = null, summary, before, after, req }) {
  const db = getDb();
  db.run(
    `INSERT INTO audit_logs
       (actor_id, actor_role, action, entity_type, entity_id, entity_ref, summary,
        before_json, after_json, ip, user_agent, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      actor?.id ?? null,
      actor?.roleCode ?? null,
      action,
      entityType,
      entityId,
      entityRef,
      summary ?? null,
      json(before),
      json(after),
      req?.ip ?? null,
      req?.get?.('user-agent')?.slice(0, 250) ?? null,
      nowIso(),
    ],
  );
}

/** Diff helper for update audit rows. */
export function changedFields(before, after, keys) {
  const out = {};
  for (const k of keys) {
    if (JSON.stringify(before?.[k] ?? null) !== JSON.stringify(after?.[k] ?? null)) {
      out[k] = { from: before?.[k] ?? null, to: after?.[k] ?? null };
    }
  }
  return out;
}
