#!/usr/bin/env node
/**
 * Destructive helper for development: removes the SQLite file and the uploads tree, then
 * re-applies the schema.  Refuses to run against production unless FORCE=1 is set, because
 * a department's real fault history is not something a script should be able to drop by
 * accident.
 */
import fs from 'node:fs';
import { config } from '../config/index.js';

const force = process.env.FORCE === '1';
if (config.isProd && !force) {
  console.error('Refusing to reset a production database. Set FORCE=1 if you really mean it.');
  process.exit(1);
}
for (const suffix of ['', '-wal', '-shm']) {
  const file = config.paths.database + suffix;
  if (fs.existsSync(file)) { fs.unlinkSync(file); console.log(`removed ${file}`); }
}
if (fs.existsSync(config.paths.uploads) && force) {
  fs.rmSync(config.paths.uploads, { recursive: true, force: true });
  console.log(`removed ${config.paths.uploads}`);
}
const { getDb } = await import('../lib/db.js');
const db = getDb();
console.log(`schema re-applied — ${db.value("SELECT COUNT(*) FROM sqlite_master WHERE type='table'")} tables`);
db.close();
