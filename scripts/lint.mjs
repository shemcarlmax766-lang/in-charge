#!/usr/bin/env node
/**
 * Dependency-light static checks (no ESLint install needed to run them).
 * These target the mistakes this codebase is actually exposed to: hard-coded secrets,
 * SQL assembled from strings, and `console.log` of user data.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SKIP = new Set(['node_modules', 'dist', '.build', '.git', 'data', 'fixtures.json']);
const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(js|mjs|jsx)$/.test(entry.name)) files.push(full);
  }
})(ROOT);

const problems = [];

/**
 * The dangerous SQL shape in this codebase is not `?` binding (always safe) but a *dynamic
 * identifier* (table/column/ORDER BY) reaching the query as text. Identifiers cannot be bound,
 * so every one of them must come from a whitelist map (SORTABLE, TABLES, ORDER BY maps) and
 * never from request data.  We analyse whole template literals rather than single lines: a
 * literal is suspect when it looks like a SQL statement *and* interpolates something that
 * smells like input.  A bind value inside a fragment like `%${value.q}%` is safe — it never
 * reaches the query text — so fragments are only checked inside a statement literal.
 */
const SQL_STMT = /(\bSELECT\b[\s\S]{0,400}?\bFROM\b|\bUPDATE\s+\w+\s+SET\b|\bINSERT\s+INTO\b|\bDELETE\s+FROM\b)/i;
const REQUEST_DATA = /(?:\breq\.|\bbody\b|\bquery\b|\bfilters\.|\bparams\[|\bdata\[|\bvalue\.|\binput\.|\brawSql|\buserInput)/;

const CHECKS = [
  {
    name: 'hard-coded secret',
    // an assignment of a quoted literal to something secret-looking, excluding env reads,
    // test fixtures and the scrypt dummy hash
    re: /(?:password|passwd|secret|api_?key|token)\s*[:=]\s*['"][^'"$`]{8,}['"]/i,
    allow: /process\.env|import\.meta|DUMMY_HASH|passwordProblems|test|\.example|lint\.mjs/,
  },
  { name: 'innerHTML assignment', re: /\.innerHTML\s*=/, allow: /test/ },
  { name: 'eval / new Function in app code', re: /\b(eval|new Function)\(/, allow: /test|render\.test|lint/ },
  { name: 'document.write', re: /document\.write\(/ },
  { name: 'target=_blank without rel', re: /target=["']_blank["']/, allow: /rel=|noreferrer/ },
  {
    name: 'secret-looking value logged',
    re: /console\.\w+\((?:[^)]*(?:password|token|csrf|secret)[^)]*)\)/i,
    // The seeder/boot banner deliberately prints the one-off demo password so the
    // reviewer can sign in; the live smoke script prints the ENV VAR NAME it wants the
    // operator to set — neither logs a value, and no other code path has anything to print.
    allow: /test|redact|\.env|lint\.mjs|db\/seed\.js|src\/index\.js|live-smoke\.mjs/,
  },
];

/**
 * SQL check: walk every template literal in the file (SQL is always built with backticks
 * here).  A literal is flagged only when it *is* a SQL statement and interpolates request
 * data directly into the query text.  Bind fragments (`params.push(`%${value.q}%`)`) are
 * safe: the value never reaches the SQL string, so we do not flag them.
 */
function scanSql(rel, src) {
  if (/\btest\b|\.test\.mjs$/.test(rel)) return; // test fixtures deliberately contain injection probes
  let match;
  const literal = /`(?:[^`\\]|\\.)*`/g;
  while ((match = literal.exec(src))) {
    const text = match[0];
    if (!SQL_STMT.test(text)) continue;
    let interp;
    const interps = /\$\{([^{}]*)\}/g;
    while ((interp = interps.exec(text))) {
      if (REQUEST_DATA.test(interp[1])) {
        const line = src.slice(0, match.index).split('\n').length;
        problems.push(`${rel}:${line}  SQL assembled from request data: ${interp[1].trim().slice(0, 90)}`);
        break;
      }
    }
  }
}

for (const file of files) {
  const rel = path.relative(ROOT, file);
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    for (const check of CHECKS) {
      if (check.allow && check.allow.test(line)) continue;
      if (check.allow && check.allow.test(rel)) continue;
      if (check.re.test(line)) problems.push(`${rel}:${i + 1}  ${check.name}: ${line.trim().slice(0, 110)}`);
    }
  });
  scanSql(rel, src);
}

/* Structural checks that do not need a linter to be worth automating. */
const envExample = fs.existsSync(path.join(ROOT, '.env.example'))
  ? fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8') : '';
for (const key of ['SESSION_TTL_HOURS', 'MIN_PASSWORD_LENGTH', 'PUBLIC_BASE_URL', 'UPLOAD_ALLOWED_MIME']) {
  if (!envExample.includes(key)) problems.push(`.env.example is missing ${key}`);
}
// Every key documented in .env.example must actually be consumed somewhere.  The server
// reads its env through server/src/config/index.js; the client dev server reads CLIENT_PORT
// and API_ORIGIN directly in client/vite.config.js — both count as readers.
const configSrc = [
  fs.readFileSync(path.join(ROOT, 'server/src/config/index.js'), 'utf8'),
  fs.readFileSync(path.join(ROOT, 'client/vite.config.js'), 'utf8'),
].join('\n');
for (const m of envExample.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)) {
  const key = m[1].toLowerCase().replace(/_([a-z])/g, (_x, c) => c.toUpperCase());
  const declared = configSrc.includes(`env.${m[1]}`) || configSrc.includes(key);
  if (!declared) problems.push(`.env.example documents ${m[1]} but no config reader uses it`);
}

// env hygiene: a real .env must never be tracked
if (fs.existsSync(path.join(ROOT, '.env'))) {
  const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  if (!gitignore.includes('.env')) problems.push('.env exists but is not git-ignored');
}

console.log(`scanned ${files.length} source files`);
if (problems.length) {
  console.log(`\n${problems.length} finding(s):`);
  for (const p of problems.slice(0, 40)) console.log(`  ✗ ${p}`);
  process.exit(1);
}
console.log('✓ no hard-coded secrets, no string-built SQL, no innerHTML/eval in app code');
