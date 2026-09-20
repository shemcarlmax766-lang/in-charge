import fs from 'node:fs';
import path from 'node:path';
import { config, assertConfig } from './config/index.js';
import { ensureUploadDirs } from './lib/files.js';
import { getDb } from './lib/db.js';
import { createApp } from './app.js';
import { seedIfEmpty } from './db/seed.js';

/** Process entry: configuration → storage → schema → (first-run demo data) → listen. */

async function main() {
  assertConfig();
  ensureUploadDirs();
  const db = getDb(); // opens the file and applies pending migrations

  const users = db.value('SELECT COUNT(*) FROM users') ?? 0;
  if (users === 0 && config.demo.force && !config.isTest) {
    const result = await seedIfEmpty(db, { demoPassword: config.demo.password });
    if (result.seeded) printSeedSummary(result);
  } else if (users === 0) {
    console.warn('⚠  Database is empty. Run `npm run seed` to create demo data, or register users directly.');
  }

  const app = createApp();
  const server = app.listen(config.server.port, config.server.host, () => {
    const shown = config.server.baseUrl || `http://localhost:${config.server.port}`;
    console.log(`\n  BEM-FRS API  •  ${config.env}  •  ${shown}/api/v1`);
    console.log(`  database: ${config.paths.database}`);
    console.log(`  uploads:  ${config.paths.uploads}\n`);
  });

  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    console.log(`\n${signal} received — closing connections.`);
    server.close(() => {
      try { db.close(); } catch { /* already closed */ }
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
  });
}

function printSeedSummary(result) {
  const rule = '─'.repeat(68);
  console.log(`\n${rule}\n  DEMO DATA INSTALLED — every name, serial number and event below is\n  FICTIONAL sample data for evaluation, not a real department.\n${rule}`);
  console.log(`  ${result.counts.users} users · ${result.counts.equipment} equipment · ${result.counts.faults} fault reports · ${result.counts.repairs} repairs · ${result.counts.maintenance} PM records`);
  console.log(`\n  Sign in with any of these accounts (password: ${result.passwordShown ? 'as configured' : 'generated'}):`);
  for (const a of result.accounts) console.log(`    ${a.role.padEnd(11)} ${a.email.padEnd(34)} ${a.password}`);
  if (result.credentialsFile) console.log(`\n  Credentials also written to ${path.relative(config.root, result.credentialsFile)} (git-ignored).`);
  console.log('  Change these passwords before real use; see docs/SECURITY.md.\n');
}

main().catch((err) => {
  console.error('\nFailed to start server:\n', err?.message ?? err);
  if (err?.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
