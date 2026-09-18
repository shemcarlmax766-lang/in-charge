import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { auth } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { PageHeader } from '../components/AppShell.jsx';
import { Badge, Button, Callout, Card, Checkbox, ConfirmDialog, Field, KeyValue, Loading, Tabs, TextInput } from '../components/ui.jsx';
import { useToast, errorText } from '../components/Toast.jsx';
import { useApi } from '../utils/useApi.js';
import { formatDateTime, relativeTime } from '../utils/format.js';
import { cx } from '../utils/format.js';

/** Profile, password and sessions. The forced-change path lands here after an admin reset. */
export function ProfilePage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'account';
  const { user, refresh, logout } = useAuth();
  const forced = params.get('forced') === '1';
  const set = (patch) => { const next = new URLSearchParams(params); for (const [k, v] of Object.entries(patch)) { if (!v) next.delete(k); else next.set(k, String(v)); } setParams(next, { replace: true }); };
  const sessions = useApi(() => (tab === 'sessions' ? auth.sessions() : Promise.resolve({ items: [] })), [tab]);

  return (
    <>
      <PageHeader eyebrow="Your account" title={user?.fullName ?? 'Profile'}
        description={user ? `${user.roleLabel}${user.jobTitle ? ` · ${user.jobTitle}` : ''}${user.department ? ` · ${user.department}` : ''}` : ''} />

      {forced ? <Callout tone="warn" title="Choose your own password first">An administrator set this account’s password. Pick one only you know — the temporary one is now invalid on every device.</Callout> : null}

      <Tabs active={tab} onChange={(id) => set({ tab: id })} tabs={[
        { id: 'account', label: 'Account' },
        { id: 'security', label: 'Password' },
        { id: 'sessions', label: 'Devices', count: sessions.data?.items?.length },
        { id: 'capabilities', label: 'What I can do' },
      ]} />

      <div className="tabpanel">
        {tab === 'account' ? (
          <Card title="Your details" subtitle="Held by the department administrator; ask them to correct anything wrong here.">
            <KeyValue columns={2} items={[
              ['Name', user?.fullName],
              ['Email (sign-in)', user?.email],
              ['Staff / student ID', user?.employeeId],
              ['Role', user?.roleLabel],
              ['Job title', user?.jobTitle],
              ['Department', user?.department],
              ['Phone', user?.phone],
              ['Last sign-in', user?.lastLoginAt ? formatDateTime(user.lastLoginAt) : '—'],
            ]} />
          </Card>
        ) : null}
        {tab === 'security' ? <PasswordPanel forced={forced} onDone={refresh} onSignedOut={logout} /> : null}
        {tab === 'sessions' ? (
          <Card title="Signed-in devices" subtitle="Signing out of a device revokes that session immediately — a lost phone can be cut off without changing the password."
            actions={<Button size="sm" tone="secondary" onClick={async () => { await auth.revokeAll(); await logout(); window.location.href = '/login'; }}>Sign out everywhere</Button>} pad={false}>
            {sessions.loading && !sessions.data ? <Loading rows={3} /> : (
              <ul>
                {(sessions.data?.items ?? []).map((s) => (
                  <li key={s.id} className="listrow">
                    <div className="listrow__main">
                      <span className="listrow__title">{s.userAgent ? shortAgent(s.userAgent) : 'Unknown device'}{s.current ? ' · this device' : ''}</span>
                      <span className="listrow__sub">IP {s.ip ?? '—'} · last seen {relativeTime(s.lastSeenAt)} · expires {formatDateTime(s.expiresAt)}</span>
                    </div>
                    <div className="listrow__side">
                      {s.current ? <Badge tone="ok" size="sm">current</Badge> : (
                        <Button size="sm" tone="ghost" onClick={async () => { await auth.revokeSession(s.id); sessions.refresh(); }}>Revoke</Button>
                      )}
                    </div>
                  </li>
                ))}
                {!(sessions.data?.items ?? []).length ? <li style={{ padding: 'var(--sp-4)' }}><p className="form-note">No other sessions.</p></li> : null}
              </ul>
            )}
          </Card>
        ) : null}
        {tab === 'capabilities' ? (
          <Card title="Your permissions" subtitle="Read from the server; the same checks are enforced on every request, so this is a description, not a grant.">
            <div className="capgrid">
              {(user?.capabilities ?? []).map((c) => (
                <code key={c} className="cap">{c}</code>
              ))}
            </div>
            <p className="form-note" style={{ marginTop: 12 }}>
              If something is missing that you need for your job, that is a role configuration question for the administrator — not
              something this screen can change.
            </p>
          </Card>
        ) : null}
      </div>
    </>
  );
}

function shortAgent(ua) {
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return [browser, os].filter(Boolean).join(' · ') || 'Unknown device';
}

function PasswordPanel({ forced, onDone }) {
  const toast = useToast();
  const policy = useApi(() => auth.policy(), []);
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [checks, setChecks] = useState([]);
  const [confirmOut, setConfirmOut] = useState(false);

  useEffect(() => {
    if (!form.next) { setChecks([]); return; }
    let alive = true;
    const t = setTimeout(() => {
      import('../api/client.js').then(({ api }) => api.get(`/users/password-strength?candidate=${encodeURIComponent(form.next)}`))
        .then((r) => { if (alive) setChecks(r.problems ?? []); })
        .catch(() => {});
    }, 350);
    return () => { alive = false; clearTimeout(t); };
  }, [form.next]);

  const submit = async (event) => {
    event.preventDefault();
    if (form.next !== form.confirm) { setErrors({ confirm: 'The two entries do not match.' }); return; }
    setBusy(true); setErrors({});
    try {
      await auth.changePassword(form.current, form.next);
      toast.success('Password changed. Other devices were signed out.');
      setForm({ current: '', next: '', confirm: '' });
      onDone();
    } catch (err) {
      const mapped = {};
      for (const [k, v] of Object.entries(err.fieldErrors ?? {})) mapped[k] = Array.isArray(v) ? v.join(' ') : String(v);
      setErrors(mapped);
      toast.error(errorText(err));
    } finally { setBusy(false); }
  };

  const min = policy.data?.minPasswordLength ?? 12;

  return (
    <>
      <Card title="Change password" subtitle={`At least ${min} characters, mixing three of: lower case, upper case, digits, symbols.`}>
        <form className="form-grid" onSubmit={submit} noValidate>
          <Field label="Current password" required error={errors.currentPassword}>
            <TextInput type="password" autoComplete="current-password" value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} />
          </Field>
          <Field label="New password" required error={errors.newPassword} hint={checks.length ? undefined : form.next ? 'Looks good.' : undefined}>
            <TextInput type="password" autoComplete="new-password" value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} />
          </Field>
          {checks.length ? <ul className="pwcheck">{checks.map((c) => <li key={c}>{c}</li>)}</ul> : form.next ? <ul className="pwcheck"><li className="ok">Meets the policy</li></ul> : null}
          <Field label="Repeat the new password" required error={errors.confirm}>
            <TextInput type="password" autoComplete="new-password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
          </Field>
          <div className="row row--end">
            <Button tone="primary" type="submit" loading={busy} disabled={!form.current || !form.next}>{forced ? 'Set my password' : 'Change password'}</Button>
            <Button tone="ghost" type="button" onClick={() => setConfirmOut(true)}>Sign out everywhere</Button>
          </div>
        </form>
      </Card>
      <Callout tone="info" title="Why there is no “forgotten password” link">
        Password reset by email needs the email integration, which is not enabled on this deployment. Until it is, the department
        administrator resets it for you — one conversation, and the audit trail records who did it.
      </Callout>
      <ConfirmDialog open={confirmOut} title="Sign out of every device?" body="You will be returned to the sign-in screen. This cannot be undone from the browser."
        confirmLabel="Sign out everywhere" onCancel={() => setConfirmOut(false)}
        onConfirm={async () => { await auth.revokeAll(); window.location.href = '/login'; }} />
    </>
  );
}
