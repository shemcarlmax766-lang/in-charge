import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { auth } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { Button, Callout, Field, TextInput } from '../components/ui.jsx';
import { errorText } from '../components/Toast.jsx';
import { SAFETY_NOTICE } from '../utils/constants.js';

/**
 * Two-step password recovery: ask for a code, then redeem it with a new password.
 *
 * Deliberately one page with a step state — the flow is short, and splitting it across
 * routes loses the entered email the moment someone's phone screen dims. The server answers
 * identically whether or not the address exists; on a build without a mail server the code
 * is also echoed here (labelled as demo behaviour) and written to the server's outbox.
 */
export function ForgotPasswordPage() {
  const { isAuthenticated, status } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState('ask'); // ask | code | done
  const [email, setEmail] = useState('');
  const [note, setNote] = useState(null);
  const [devOtp, setDevOtp] = useState(null);
  const [form, setForm] = useState({ code: '', newPassword: '', confirm: '' });
  const [apiError, setApiError] = useState(null);
  const [localError, setLocalError] = useState(null);
  const [busy, setBusy] = useState(false);

  if (isAuthenticated && status === 'authenticated') return <Navigate to="/" replace />;

  const ask = async (event) => {
    event.preventDefault();
    if (!/\S+@\S+\.\S+/.test(email)) { setLocalError('Enter the email address you sign in with.'); return; }
    setBusy(true);
    setApiError(null);
    setLocalError(null);
    try {
      const out = await auth.forgotPassword(email.trim());
      setNote(out?.message ?? 'If that address has an account, a code is on its way.');
      setDevOtp(out?.devOtp ?? null);
      if (out?.devOtp) setForm((f) => ({ ...f, code: out.devOtp }));
      setStep('code');
    } catch (err) {
      setApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const redeem = async (event) => {
    event.preventDefault();
    if (!/^\d{6}$/.test(form.code)) { setLocalError('Enter the six-digit code.'); return; }
    if (!form.newPassword) { setLocalError('Choose a new password.'); return; }
    if (form.newPassword !== form.confirm) { setLocalError('The two password fields must match.'); return; }
    setBusy(true);
    setApiError(null);
    setLocalError(null);
    try {
      await auth.resetPassword({ email: email.trim(), code: form.code, newPassword: form.newPassword });
      setStep('done');
    } catch (err) {
      setApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const set = (key) => (event) => {
    setForm((f) => ({ ...f, [key]: event.target.value }));
    setLocalError(null);
  };

  return (
    <div className="login">
      <div className="login__card">
        <div className="login__brand">
          <div>
            <h1 className="login__title">{step === 'done' ? 'Password reset' : 'Recover your password'}</h1>
            <p className="login__sub">A one-time code goes to the email address on the account — nobody else can read it.</p>
          </div>
        </div>

        {step === 'ask' && (
          <form onSubmit={ask} noValidate>
            <div className="login__form">
              {localError ? <Callout tone="bad">{localError}</Callout> : null}
              {apiError ? <Callout tone="bad" title="Could not start recovery">{errorText(apiError)}</Callout> : null}
              <Field label="Email address" htmlFor="fp-email" required hint="The address the department has for you — not a new one.">
                <TextInput id="fp-email" type="email" autoComplete="email" inputMode="email" required value={email} onChange={(e) => { setEmail(e.target.value); setLocalError(null); }} placeholder="you@institution.edu" />
              </Field>
              <Button type="submit" size="lg" tone="primary" loading={busy} className="btn--block">
                {busy ? 'Sending…' : 'Send me a reset code'}
              </Button>
              <p className="form-note" style={{ textAlign: 'center', fontSize: '.78rem' }}>
                <Link to="/login">Back to sign in</Link> · <Link to="/register">Need an account?</Link>
              </p>
            </div>
          </form>
        )}

        {step === 'code' && (
          <form onSubmit={redeem} noValidate>
            <div className="login__form">
              <Callout tone="info" title="Check your inbox">{note}</Callout>
              {devOtp ? (
                <Callout tone="warn" title="Demo mode — no mail server on this deployment">
                  The code is <strong>{devOtp}</strong>. On a real server it would only appear in the
                  email (and in the server's <code>data/outbox/</code>), never on this screen.
                </Callout>
              ) : null}
              {localError ? <Callout tone="bad">{localError}</Callout> : null}
              {apiError ? <Callout tone="bad" title="Could not reset the password">{errorText(apiError)}</Callout> : null}
              <Field label="Six-digit code" htmlFor="fp-code" required hint={`Comes by email; it expires and stops working after a few wrong tries.`} error={apiError?.errorFor?.('code')}>
                <TextInput id="fp-code" autoComplete="one-time-code" inputMode="numeric" maxLength={6} required value={form.code} onChange={set('code')} placeholder="000000" />
              </Field>
              <Field label="New password" htmlFor="fp-pass" required error={apiError?.errorFor?.('newPassword')}>
                <TextInput id="fp-pass" type="password" autoComplete="new-password" required value={form.newPassword} onChange={set('newPassword')} />
              </Field>
              <Field label="Repeat new password" htmlFor="fp-pass2" required error={form.confirm && form.confirm !== form.newPassword ? 'These do not match yet.' : null}>
                <TextInput id="fp-pass2" type="password" autoComplete="new-password" required value={form.confirm} onChange={set('confirm')} />
              </Field>
              <Button type="submit" size="lg" tone="primary" loading={busy} className="btn--block">
                {busy ? 'Setting your new password…' : 'Reset password'}
              </Button>
              <p className="form-note" style={{ textAlign: 'center', fontSize: '.78rem' }}>
                Code not arriving? <button type="button" className="linklike" onClick={() => { setStep('ask'); setApiError(null); }}>Start again</button>
              </p>
            </div>
          </form>
        )}

        {step === 'done' && (
          <>
            <Callout tone="ok" title="Done — every other device was signed out">
              Your new password works from this moment on; all older sessions were revoked. If you did not
              request this, tell the biomedical engineering department immediately.
            </Callout>
            <Button size="lg" tone="primary" className="btn--block" onClick={() => navigate('/login', { replace: true })}>
              Back to sign in
            </Button>
          </>
        )}

        <p className="login__foot">{SAFETY_NOTICE}</p>
      </div>
    </div>
  );
}
