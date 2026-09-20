import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { auth, publicApi } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { Button, Callout, Field, TextInput } from '../components/ui.jsx';
import { errorText } from '../components/Toast.jsx';
import { SAFETY_NOTICE } from '../utils/constants.js';

/**
 * Self-service onboarding — Reporter role only, and that is the point.
 *
 * The server refuses any role but reporter here (see user.service.selfRegister); this page
 * says so in plain language, because hiding the boundary is how people come to distrust a
 * system. Technician and admin accounts are issued by the department: that is what stops a
 * stranger from self-claiming the authority to sign equipment in and out of service.
 */
export function RegisterPage() {
  const { login, isAuthenticated, status } = useAuth();
  const navigate = useNavigate();
  const [config, setConfig] = useState(null);
  const [form, setForm] = useState({ fullName: '', email: '', department: '', password: '', confirm: '' });
  const [apiError, setApiError] = useState(null);
  const [localError, setLocalError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { publicApi.config().then(setConfig).catch(() => {}); }, []);
  useEffect(() => { setApiError(null); setLocalError(null); }, [form.fullName, form.email, form.password, form.confirm]);

  if (isAuthenticated && status === 'authenticated') return <Navigate to="/" replace />;

  const minLength = config?.passwordMinLength ?? 12;
  const set = (key) => (event) => setForm({ ...form, [key]: event.target?.value ?? event });

  const submit = async (event) => {
    event.preventDefault();
    if (form.fullName.trim().length < 2) { setLocalError('Enter your full name as the department knows you.'); return; }
    if (!/\S+@\S+\.\S+/.test(form.email)) { setLocalError('Enter a valid email address.'); return; }
    if (form.password.length < minLength) { setLocalError(`Choose a password of at least ${minLength} characters.`); return; }
    if (form.password !== form.confirm) { setLocalError('The two password fields must match.'); return; }
    setBusy(true);
    setApiError(null);
    setLocalError(null);
    try {
      await auth.register({
        fullName: form.fullName.trim(),
        email: form.email.trim(),
        department: form.department.trim() || undefined,
        password: form.password,
      });
      // Best case: go straight in. If auto-sign-in misbehaves, the login page is one click away.
      try { await login({ email: form.email.trim(), password: form.password, remember: false }); navigate('/', { replace: true }); }
      catch { navigate('/login', { replace: true }); }
    } catch (err) {
      setApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const disabled = config && config.selfRegistration === false;

  return (
    <div className="login">
      <form className="login__card" onSubmit={submit} noValidate>
        <div className="login__brand">
          <div>
            <h1 className="login__title">Create a Reporter account</h1>
            <p className="login__sub">{config?.institution ? `${config.institution} · ` : ''}{config?.department ?? 'Biomedical Engineering Department'}</p>
          </div>
        </div>

        {disabled ? (
          <Callout tone="warn" title="Registration is closed on this deployment">
            An administrator has turned self-service sign-up off (ALLOW_SELF_REGISTRATION=0). Ask the biomedical
            engineering department to create your account — <Link to="/login">back to sign in</Link>.
          </Callout>
        ) : (
          <>
            {localError ? <Callout tone="bad" title="Check the form">{localError}</Callout> : null}
            {apiError ? <Callout tone="bad" title="Could not create the account">{errorText(apiError)}</Callout> : null}

            <div className="login__form">
              <Field label="Full name" htmlFor="reg-name" required error={apiError?.errorFor?.('fullName')}>
                <TextInput id="reg-name" autoComplete="name" required value={form.fullName} onChange={set('fullName')} placeholder="As the department knows you" />
              </Field>
              <Field label="Email address" htmlFor="reg-email" required hint="Used for sign-in and for password recovery codes." error={apiError?.errorFor?.('email')}>
                <TextInput id="reg-email" type="email" autoComplete="email" inputMode="email" required value={form.email} onChange={set('email')} placeholder="you@institution.edu" />
              </Field>
              <Field label="Department / unit" htmlFor="reg-dept" hint="Optional — where you work or study.">
                <TextInput id="reg-dept" autoComplete="organization" value={form.department} onChange={set('department')} placeholder="e.g. Physiology Lab" />
              </Field>
              <Field label="Password" htmlFor="reg-password" required hint={`At least ${minLength} characters. A phrase of unrelated words works well. Do not reuse a password from elsewhere.`} error={apiError?.errorFor?.('password')}>
                <TextInput id="reg-password" type="password" autoComplete="new-password" required value={form.password} onChange={set('password')} />
              </Field>
              <Field label="Repeat password" htmlFor="reg-confirm" required error={form.confirm && form.confirm !== form.password ? 'These do not match yet.' : null}>
                <TextInput id="reg-confirm" type="password" autoComplete="new-password" required value={form.confirm} onChange={set('confirm')} />
              </Field>

              <Callout tone="info" title="What this account can do">
                Reporters file fault reports, attach photos and follow the equipment they reported. Repairs, diagnoses
                and status changes belong to technicians — those accounts are issued by the department so that only
                trained staff can claim a technical role.
              </Callout>

              <Button type="submit" size="lg" tone="primary" loading={busy} className="btn--block">
                {busy ? 'Creating account…' : 'Create account & sign in'}
              </Button>
            </div>

            <p className="form-note" style={{ textAlign: 'center', fontSize: '.78rem' }}>
              Already registered? <Link to="/login">Sign in</Link> · Trouble getting in? <Link to="/forgot-password">Recover your password</Link>
            </p>
          </>
        )}

        <p className="login__foot">{SAFETY_NOTICE}</p>
      </form>
    </div>
  );
}
