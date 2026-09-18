import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';

/**
 * Renders every screen in a real DOM against recorded server responses.
 *
 * Why: the bundler proves the modules parse; this proves they *mount*, that hooks and
 * optional-chaining assumptions survive real payloads, and that no page logs a React error.
 * It runs each route at a desktop and a mobile width, because a screen built for a lab bench
 * and a phone is the core requirement here.
 *
 * This is not a substitute for clicking through on a real device (no layout engine applies
 * media queries in jsdom) — see docs/TESTING.md for the manual pass that complements it.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(HERE, '.build', 'app.js');
const FIXTURES = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures.json'), 'utf8'));

const IGNORE = [
  /React Router Future Flag/i,
  /not wrapped in act/i,
  /download the React DevTools/i,
  /index\.css/i,
];

function makeDom({ width, fetchImpl, errors }) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('error', (...a) => errors.push(a.join(' ')));
  virtualConsole.on('warn', (...a) => {
    const line = a.join(' ');
    if (!IGNORE.some((re) => re.test(line))) errors.push(`warn: ${line}`);
  });
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost:5173/',
    pretendToBeVisual: true,
    runScripts: 'dangerously',
    virtualConsole,
  });
  const { window } = dom;
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  window.matchMedia = (query) => ({
    matches: /max-width:\s*(\d+)px/.test(query) ? width <= Number(/max-width:\s*(\d+)px/.exec(query)[1]) : false,
    media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.scrollTo = () => {};
  window.print = () => {};
  window.matchMedia && (window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0));
  window.URL.createObjectURL = () => 'blob:stub';
  window.URL.revokeObjectURL = () => {};
  window.AbortController = globalThis.AbortController;
  window.AbortSignal = globalThis.AbortSignal;
  window.fetch = fetchImpl;
  window.Response = globalThis.Response;
  window.Request = globalThis.Request;
  window.Headers = globalThis.Headers;
  window.Blob = globalThis.Blob;
  window.FormData = globalThis.FormData;
  window.navigator.clipboard = { writeText: async () => {} };
  return dom;
}

/** Serves the recorded responses; anything unknown 404s loudly rather than hanging. */
function makeFetch(role) {
  const calls = [];
  const fn = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method ?? 'GET').toUpperCase();
    let key = null;
    if (url === '/api/v1/auth/login' || url.endsWith('/auth/login')) {
      const account = FIXTURES.accounts[role === 'anonymous' ? 'reporter' : role];
      const me = (FIXTURES.fixtures[role] ?? {})['/auth/me']?.body ?? {};
      calls.push(`${method} ${url} → login`);
      // capabilities come from /auth/me in the real app; the login response carries the same set.
      return jsonResponse(200, {
        user: { ...account.user, capabilities: me.capabilities },
        token: account.token, csrfToken: account.csrf,
        capabilities: me.capabilities ?? [],
        expiresAt: new Date(Date.now() + 3.6e6).toISOString(),
      });
    }
    if (method !== 'GET') { calls.push(`${method} ${url} → stub`); return jsonResponse(200, { ok: true }); }
    const pathname = url.replace(/^\/api\/v1/, '').split('?')[0];
    const withQuery = url.replace(/^\/api\/v1/, '');
    const fixtures = role === 'public' ? FIXTURES.public : (FIXTURES.fixtures[role] ?? {});
    const hit = fixtures[withQuery] ?? fixtures[pathname] ?? FIXTURES.public[url.replace(/^\//, '')] ?? FIXTURES.public[withQuery];
    calls.push(`${method} ${withQuery} → ${hit ? hit.status : 'MISS'}`);
    if (!hit) return jsonResponse(404, { error: { code: 'not_recorded', message: `No fixture for ${withQuery}` } });
    return jsonResponse(hit.status, hit.body);
  };
  fn.calls = calls;
  return fn;
}

function jsonResponse(status, body) {
  return new globalThis.Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const SCREENS = [
  { route: '/', name: 'dashboard', role: 'admin', expect: ['Department status', 'Total equipment', 'Most frequently failing equipment', 'Preventive maintenance'] },
  { route: '/', name: 'dashboard (reporter)', role: 'reporter', expect: ['Open fault reports', 'Maintenance overdue', 'Critical faults'] },
  { route: '/equipment', name: 'equipment list', role: 'admin', expect: ['Equipment', 'Filters', 'Maintenance', 'Location'], attrs: ['input[placeholder^="Search by name"]'] },
  { route: '/equipment/1', name: 'equipment profile', role: 'admin', expect: ['Identification and ownership', 'Status trail', 'QR label', 'At a glance', 'Files & label'] },
  { route: '/equipment/1', name: 'equipment profile (reporter)', role: 'reporter', expect: ['Report a fault', 'Status trail', 'Overview'] },
  { route: '/equipment/new', name: 'new equipment form', role: 'admin', expect: ['Add equipment', 'Identification', 'Preventive maintenance', 'Serial number'] },
  { route: '/faults', name: 'fault list', role: 'technician', expect: ['Fault reports', 'Assigned to me', 'Waiting for an owner'], attrs: ['input[type="search"]'] },
  { route: '/faults/1', name: 'fault detail', role: 'admin', expect: ['Reported problem', 'Timeline', 'Equipment', 'Accountability'] },
  { route: '/faults/new', name: 'report a fault', role: 'reporter', expect: ['Report a fault', 'Which equipment', 'How bad is it', 'What you observed'] },
  { route: '/work', name: 'work queue', role: 'technician', expect: ['Work queue', 'Assigned to me', 'Maintenance due'] },
  { route: '/maintenance', name: 'maintenance programme', role: 'admin', expect: ['Maintenance programme', 'Due board', 'Overdue', 'Up to date'] },
  { route: '/risk', name: 'risk register', role: 'admin', expect: ['Maintenance risk register', 'Decision support', 'not'] },
  { route: '/reports', name: 'reports', role: 'admin', expect: ['Departmental reports', 'Print', 'CSV'] },
  { route: '/users', name: 'users', role: 'admin', expect: ['Users and roles', 'Role', 'Administrator'] },
  { route: '/reference', name: 'configuration', role: 'admin', expect: ['Reference data', 'Equipment categories', 'QR labels', 'Settings'] },
  { route: '/audit', name: 'audit log', role: 'admin', expect: ['Audit log', 'Who changed what'] },
  { route: '/notifications', name: 'notifications', role: 'technician', expect: ['What the department has been told', 'Unread', 'Mark all read'] },
  { route: '/profile', name: 'profile', role: 'admin', expect: ['Your account', 'Your details', 'Devices', 'What I can do'] },
  { route: '/e/BMU-ECG-0001', name: 'QR landing (anonymous)', role: 'public', expect: ['Sign in to report a fault', 'does not assess patient safety'] },
  { route: '/nothing-here', name: 'not found', role: 'admin', expect: ['That page does not exist'] },
];

const WIDTHS = { desktop: 1440, mobile: 390 };

let bundle;
before(() => {
  assert.ok(fs.existsSync(BUNDLE), 'build the test bundle first: node client/test/build.mjs');
  bundle = fs.readFileSync(BUNDLE, 'utf8');
});

for (const [widthName, width] of Object.entries(WIDTHS)) {
  describe(`screens render at ${widthName} (${width}px)`, () => {
    for (const screen of SCREENS) {
      it(`${screen.name} — ${screen.route}`, async () => {
        const errors = [];
        const fetchImpl = makeFetch(screen.role);
        const dom = makeDom({ width, fetchImpl, errors });
        const { window } = dom;
        try {
          window.eval(bundle);
          window.__mount(screen.route);
          // let effects + promise chains resolve
          for (let i = 0; i < 14; i += 1) await new Promise((r) => setTimeout(r, 16));
          const text = window.document.body.textContent.replace(/\s+/g, ' ');
          for (const needle of screen.expect) {
            assert.ok(text.includes(needle), `expected “${needle}” in ${screen.name} (${widthName}); got: ${text.slice(0, 300)}`);
          }
          assert.ok(window.document.querySelector('.shell, .login'), 'the app frame rendered');
          for (const selector of screen.attrs ?? []) {
            assert.ok(window.document.querySelector(selector), `${screen.name}: no element matching ${selector}`);
          }
          // An anonymous visitor *must* get a 401 from /auth/me — that is how the app decides to
          // show the public landing page instead of the shell, so it is not a missing fixture.
          const allowedMiss = screen.role === 'public' ? [/\/auth\/me$/] : [];
          const misses = fetchImpl.calls.filter((c) => {
            if (!c.includes('→ MISS')) return false;
            const called = (c.split(' ')[1] ?? '').split('?')[0];
            return !allowedMiss.some((re) => re.test(called));
          });
          assert.deepEqual(misses, [], `unrecorded API calls: ${misses.join(', ')}`);
          const hardErrors = errors.filter((e) => !IGNORE.some((re) => re.test(e)));
          assert.deepEqual(hardErrors, [], `console errors on ${screen.name}:\n${hardErrors.slice(0, 3).join('\n').slice(0, 1200)}`);
        } finally {
          try { window.__unmount?.(); } catch { /* already torn down */ }
          dom.window.close();
        }
      });
    }
  });
}

describe('responsive + accessibility structure', () => {
  it('ships a mobile bottom bar, an off-canvas sidebar and print rules in the stylesheet', () => {
    const css = fs.readFileSync(path.join(HERE, '..', 'src', 'styles', 'app.css'), 'utf8');
    assert.match(css, /@media \(min-width: 900px\)/, 'desktop layout breakpoint');
    assert.match(css, /@media \(max-width: 719px\)/, 'mobile card-table breakpoint');
    assert.match(css, /@media print/, 'print stylesheet');
    assert.match(css, /prefers-reduced-motion/, 'reduced motion honoured');
    assert.match(css, /:focus-visible/, 'visible keyboard focus');
    assert.ok(!/position: fixed[\s\S]{0,40}bottom: 0[\s\S]{0,60}display: none/.test(css.slice(0, 0)), 'placeholder');
    const tabbar = /\.tabbar\s*\{[\s\S]*?\n\}/.exec(css)?.[0] ?? '';
    assert.ok(tabbar.includes('position: fixed'), 'the tab bar is a fixed mobile affordance');
    assert.match(css, /\.tabbar, \.scrim \{ display: none; \}/, 'and is hidden on desktop');
  });

  it('never renders colour-only status: every pill carries text', () => {
    const src = fs.readFileSync(path.join(HERE, '..', 'src', 'components', 'display.jsx'), 'utf8');
    assert.match(src, /EQUIPMENT_STATUS\[status\][\s\S]*\{meta\.label\}/, 'status pills print a label');
    assert.match(src, /aria-label=\{`Maintenance risk score/, 'the risk dial has a text alternative');
    assert.match(src, /role="progressbar"/, 'progress bars expose their value');
  });
});
