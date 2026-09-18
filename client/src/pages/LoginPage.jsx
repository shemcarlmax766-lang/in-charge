import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { auth, publicApi } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { Button, Callout, Checkbox, Field, TextInput } from '../components/ui.jsx';
import { errorText } from '../components/Toast.jsx';
import { SAFETY_NOTICE } from '../utils/constants.js';

/**
 * Sign-in.  Deliberately plain and fast: this screen is used on a shared lab computer and on
 * a phone standing in a corridor.  No password is remembered in storage; the session lives in
 * an httpOnly cookie (see docs/SECURITY.md).
 */
export function LoginPage() {
  const { login, isAuthenticated, status, notice } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState({ email: '', password: '', remember: false });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [config, setConfig] = useState(null);
  const [capsHint, setCapsHint] = useState(false);

  useEffect(() => { publicApi.config().then(setConfig).catch(() => {}); }, []);
  useEffect(() => { setError(null); }, [form.email, form.password]);

  const redirectTo = useMemo(() => location.state?.from ?? '/', [location.state]);
  if (isAuthenticated && status === 'authenticated') return <Navigate to={redirectTo} replace />;

  const submit = async (event) => {
    event.preventDefault();
    if (!form.email.trim() || !form.password) { setError('Enter both your email address and password.'); return; }
    setBusy(true);
    setError(null);
    try {
      await login(form);
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login__card" onSubmit={submit} noValidate>
        <div className="login__brand">
          <span className="login__mark" aria-hidden="true">
            <svg viewBox="0 0 32 32" width="26" height="26"><path d="M3 17h5l2.4-7 3.3 13.4L17 13l2 4h10" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </span>
          <div>
            <h1 className="login__title">Equipment Maintenance &amp; Fault Reporting</h1>
            <p className="login__sub">{config?.institution ? `${config.institution} · ` : ''}{config?.department ?? 'Biomedical Engineering Department'}</p>
          </div>
        </div>

        {notice ? <Callout tone="warn">{notice}</Callout> : null}
        {error ? <Callout tone="bad" title="Could not sign you in">{error}</Callout> : null}

        <div className="login__form">
          <Field label="Email address" htmlFor="login-email" required error={!form.email && error && !/password/i.test(error) ? 'Enter your email address' : null}>
            <TextInput
              id="login-email"
              type="email"
              autoComplete="username"
              inputMode="email"
              enterKeyHint="next"
              required
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              placeholder="you@institution.edu"
            />
          </Field>

          <Field
            label="Password"
            htmlFor="login-password"
            required
            hint={capsHint ? 'Caps Lock appears to be on.' : 'Sessions end automatically after 12 hours of inactivity.'}
          >
            <TextInput
              id="login-password"
              type="password"
              autoComplete="current-password"
              enterKeyHint="go"
              required
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              onKeyUp={(e) => setCapsHint(e.getModifierState?.('CapsLock') === true)}
            />
          </Field>

          <Checkbox
            label="Keep me signed in on this device"
            hint="Only use this on a computer that nobody else can reach."
            checked={form.remember}
            onChange={(v) => setForm({ ...form, remember: v })}
          />

          <Button type="submit" size="lg" tone="primary" loading={busy} className="btn--block">
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </div>

        <p className="form-note" style={{ textAlign: 'center', fontSize: '.78rem' }}>
          Forgotten password? Ask the department administrator to reset it — self-service reset
          needs the email integration that is not enabled on this deployment.
        </p>

        <p className="login__foot">{SAFETY_NOTICE}</p>
      </form>
    </div>
  );
}
