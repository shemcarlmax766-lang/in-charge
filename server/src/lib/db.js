import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config/index.js';

/**
 * Thin, swappable data-access layer over `node:sqlite`.
 *
 * Why a hand-rolled ~120-line adapter instead of an ORM?
 *  - zero native modules: `npm install` cannot fail on a missing prebuilt binary,
 *    which is the most common reason school-department projects die at handover;
 *  - every query in this codebase is visible SQL with bound parameters, which is
 *    easier to audit (and to index-tune) than generated query plans;
 *  - the surface services depend on is only `all/get/run/tx`, so replacing this
 *    file with a Postgres adapter is a bounded job.
 */
export class Db {
  #conn;
  #cache = new Map();
  #txDepth = 0;

  constructor(filename = config.paths.database) {
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.filename = filename;
    this.#conn = new DatabaseSync(filename, { open: true, create: true });
    this.#conn.exec('PRAGMA journal_mode = WAL');
    this.#conn.exec('PRAGMA foreign_keys = ON');
    this.#conn.exec('PRAGMA busy_timeout = 5000');
    this.#conn.exec('PRAGMA synchronous = NORMAL');
  }

  #prep(sql, params, kind) {
    let entry = this.#cache.get(sql);
    if (!entry) {
      entry = { st: this.#conn.prepare(sql), slots: countPlaceholders(sql) };
      this.#cache.set(sql, entry);
    }
    // Cheap, decisive guard: a placeholder list that does not match the bound array is a
    // silent-data-corruption bug in every framework that lacks it. SQLite binds the extra
    // parameters as NULL and shifts the rest, which reads like "no rows" and is impossible
    // to spot from the UI. Fail loudly at the call site instead.
    if (entry.slots !== null && Array.isArray(params) && params.length !== entry.slots) {
      throw new Error(
        `SQL ${kind}() parameter mismatch: ${entry.slots} placeholder(s) but ${params.length} value(s).\n` +
        `  ${sql.replace(/\s+/g, ' ').slice(0, 240)}`,
      );
    }
    return entry.st;
  }

  /** Rows as plain objects (node:sqlite returns null-prototype rows). */
  all(sql, params = []) {
    const rows = this.#prep(sql, params, 'all').all(...params);
    return rows.map((r) => ({ ...r }));
  }

  get(sql, params = []) {
    const row = this.#prep(sql, params, 'get').get(...params);
    return row === undefined ? undefined : { ...row };
  }

  /** First column of the first row — for COUNT/SUM/EXISTS style queries. */
  value(sql, params = []) {
    const row = this.get(sql, params);
    return row === undefined ? undefined : Object.values(row)[0];
  }

  run(sql, params = []) {
    const res = this.#prep(sql, params, 'run').run(...params);
    return { changes: Number(res.changes), lastInsertRowid: Number(res.lastInsertRowid) };
  }

  exec(sql) {
    this.#conn.exec(sql);
  }

  /**
   * Transaction with JOIN semantics for nesting: an inner `tx()` inside an outer one
   * does not commit early, so services can always assume atomicity.
   * BEGIN IMMEDIATE takes the write lock up front, which prevents "database is
   * locked" errors from read-to-write upgrades under concurrent reporters.
   */
  tx(fn) {
    if (this.#txDepth > 0) return fn(this);
    this.#conn.exec('BEGIN IMMEDIATE');
    this.#txDepth = 1;
    try {
      const out = fn(this);
      this.#conn.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.#conn.exec('ROLLBACK');
      } catch { /* the connection is already unwinding */ }
      throw err;
    } finally {
      this.#txDepth = 0;
    }
  }

  inTransaction() {
    return this.#txDepth > 0;
  }

  /** Migrate + seed helpers open/close their own handle; the app keeps one. */
  close() {
    this.#cache.clear();
    this.#conn.close();
  }
}

/* ------------------------------------------------------------------ *
 * Migration runner: ordered .sql files, checksum-verified, applied   *
 * one-per-transaction so a failed migration never half-applies.      *
 * ------------------------------------------------------------------ */

const HERE = path.dirname(new URL(import.meta.url).pathname);

/**
 * Number of `?` anonymous parameters in a statement, ignoring those inside string literals
 * and quoted identifiers. Returns null when the SQL contains named parameters instead, so
 * the guard stays out of the way of that style.
 */
export function countPlaceholders(sql) {
  let count = 0;
  let quote = null;
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i];
    if (quote) {
      if (c === quote) {
        if (sql[i + 1] === quote) i += 1; // doubled quote is an escaped quote
        else quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '?' && sql[i + 1] !== '?') count += 1;
    if (c === ':' || c === '@' || c === '$') return null; // named parameters: skip the check
  }
  return count;
}

export function migrate(db, dir = path.resolve(HERE, '..', 'db', 'migrations')) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL
  )`);
  const applied = new Map(
    db.all('SELECT name, checksum FROM schema_migrations').map((r) => [r.name, r.checksum]),
  );

  const run = [];
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(path.join(dir, name), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex').slice(0, 16);
    const seen = applied.get(name);
    if (seen) {
      if (seen !== checksum) {
        throw new Error(
          `Migration ${name} changed after being applied (checksum ${seen} → ${checksum}). ` +
            'Add a new migration instead of editing history.',
        );
      }
      continue;
    }
    run.push({ name, sql, checksum });
  }

  for (const { name, sql, checksum } of run) {
    db.tx(() => {
      db.exec(sql);
      db.run('INSERT INTO schema_migrations (name, checksum, applied_at) VALUES (?,?,?)', [
        name,
        checksum,
        new Date().toISOString(),
      ]);
    });
  }
  return run.map((r) => r.name);
}

let singleton = null;

/** Lazily opens (and auto-migrates) the application database. */
export function getDb() {
  if (singleton) return singleton;
  const db = new Db(config.paths.database);
  migrate(db);
  singleton = db;
  return singleton;
}

export function setDb(db) {
  singleton = db;
}

/* ------------------------------------------------------------------ *
 * Small SQL building helpers (parameterised — never string values)   *
 * ------------------------------------------------------------------ */

/** Build `IN (?,?,?)` for a non-empty array; throws on empty (callers must guard). */
export const inClause = (values) => `(${values.map(() => '?').join(',')})`;

/**
 * Race-free per-scope counter, used to mint human references such as FLT-2026-0041.
 * Must be called inside a transaction.
 */
export function nextSequence(db, key) {
  db.run('INSERT INTO id_sequences (key, last_value) VALUES (?, 0) ON CONFLICT(key) DO NOTHING', [key]);
  db.run('UPDATE id_sequences SET last_value = last_value + 1 WHERE key = ?', [key]);
  return db.value('SELECT last_value FROM id_sequences WHERE key = ?', [key]);
}
