#!/usr/bin/env node
import { config } from '../config/index.js';
import { getDb } from '../lib/db.js';
import { migrate } from '../lib/db.js';
import { ensureUploadDirs } from '../lib/files.js';

ensureUploadDirs();
const db = getDb();
const applied = migrate(db);
const rows = db.all('SELECT name, applied_at FROM schema_migrations ORDER BY name');
console.log(`database: ${config.paths.database}`);
console.log(applied.length ? `applied ${applied.length} migration(s): ${applied.join(', ')}` : 'schema is up to date');
for (const r of rows) console.log(`  ✓ ${r.name}  (${r.applied_at})`);
console.log(`tables: ${db.value("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}`);
db.close();
