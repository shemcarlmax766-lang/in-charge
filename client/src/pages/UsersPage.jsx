import { useEffect, useState } from 'react';
import { users as usersApi } from '../api/client.js';
import { PageHeader } from '../components/AppShell.jsx';
import { Button, Callout, Card, ConfirmDialog, DataTable, EmptyState, ErrorState, Field, Loading, Modal, Pagination, SearchInput, Select, TextInput } from '../components/ui.jsx';
import { Badge, KeyValue } from '../components/display.jsx';
import { useToast, errorText } from '../components/Toast.jsx';
import { useApi } from '../utils/useApi.js';
import { formatDateTime } from '../utils/format.js';

/**
 * User administration.  Accounts are never deleted when they carry official history — they are
 * deactivated, because "who reported / repaired / verified this" must stay answerable.
 */
export function UsersPage() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('active');
  const [editing, setEditing] = useState(null);
  const [created, setCreated] = useState(null);
  const [reset, setReset] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(null);
  const list = useApi(() => usersApi.list({ q: q || undefined, status }), [q, status]);

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Users and roles"
        description="Roles decide what a person may do. The reporter role is deliberately limited: anyone can raise a fault, only a technician can diagnose one."
        actions={<Button tone="primary" onClick={() => setEditing({ roleCode: 'reporter', mustChangePassword: true })}>＋ Add user</Button>}
      />

      <div className="row" style={{ marginBottom: 'var(--sp-4)' }}>
        <div style={{ flex: '1 1 320px', maxWidth: 460 }}><SearchInput value={q} onSearch={setQ} placeholder="Search name, email or ID…" /></div>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Account status" style={{ maxWidth: 180 }}
          options={[{ value: 'active', label: 'Active' }, { value: 'disabled', label: 'Deactivated' }, { value: 'all', label: 'All accounts' }]} />
      </div>

      <Card title={`${list.data?.items?.length ?? 0} account(s)`} pad={false}>
        {list.error ? <div style={{ padding: 'var(--sp-4)' }}><ErrorState error={list.error} onRetry={list.refresh} /></div> : (
          <DataTable
            loading={list.loading && !list.data}
            rows={list.data?.items ?? []}
            empty={<EmptyState title="No accounts match" description="Try another search term, or include deactivated accounts." />}
            columns={[
              { key: 'fullName', label: 'Person', render: (u) => (
                <div className="cell-main">
                  <span className="cell-title">{u.fullName} {!u.isActive && <Badge tone="neutral" size="sm">disabled</Badge>}</span>
                  <span className="cell-sub">{u.email}{u.employeeId ? ` · ${u.employeeId}` : ''}</span>
                </div>
              ) },
              { key: 'roleLabel', label: 'Role', render: (u) => <Badge tone={u.roleCode === 'admin' ? 'bad' : u.roleCode === 'technician' ? 'info' : 'neutral'}>{u.roleLabel}</Badge> },
              { key: 'jobTitle', label: 'Job title / department', render: (u) => [u.jobTitle, u.department].filter(Boolean).join(' · ') || '—' },
              { key: 'lastLoginAt', label: 'Last sign-in', render: (u) => (u.lastLoginAt ? formatDateTime(u.lastLoginAt) : <span className="muted">never</span>) },
              { key: 'mustChangePassword', label: '', align: 'center', render: (u) => (u.mustChangePassword ? <Badge tone="warn" size="sm">must change password</Badge> : null) },
              { key: 'actions', label: '', render: (u) => (
                <div className="row row--tight">
                  <Button size="sm" tone="ghost" onClick={() => setEditing(u)}>Edit</Button>
                  <Button size="sm" tone="ghost" onClick={() => setReset(u)}>Password</Button>
                  <Button size="sm" tone="ghost" onClick={() => setConfirmRemove(u)}>{u.isActive ? 'Deactivate' : 'Activate'}</Button>
                </div>
              ) },
            ]}
          />
        )}
      </Card>

      <Callout tone="info" title="Role definitions">
        <div className="grid grid--3" style={{ marginTop: 6 }}>
          {[
            ['Administrator', 'Inventory, users, assignment, schedules, configuration, all records and reports.'],
            ['Technician / biomedical engineer', 'Owns the technical record: diagnosis, work performed, parts, costs, safety sign-off, PM.'],
            ['Student / staff reporter', 'Views equipment, reports faults with evidence, tracks their own reports. Cannot alter any official record.'],
          ].map(([role, text]) => (
            <div key={role}><p className="cell-title">{role}</p><p className="cell-sub">{text}</p></div>
          ))}
        </div>
      </Callout>

      <UserFormModal state={editing} onClose={() => setEditing(null)} onCreated={setCreated} onSaved={() => { setEditing(null); list.refresh(); }} />
      <PasswordModal state={reset} onClose={() => setReset(null)} />
      <ConfirmDialog
        open={!!confirmRemove}
        tone={confirmRemove?.isActive ? 'bad' : 'primary'}
        title={confirmRemove?.isActive ? `Deactivate ${confirmRemove.fullName}?` : `Reactivate ${confirmRemove?.fullName}?`}
        body={confirmRemove?.isActive
          ? 'They are signed out immediately and cannot sign in again. Their fault reports, assignments and repair records remain on file.'
          : 'They will be able to sign in again with their existing password.'}
        confirmLabel={confirmRemove?.isActive ? 'Deactivate account' : 'Reactivate account'}
        onCancel={() => setConfirmRemove(null)}
        onConfirm={async () => {
          try {
            await usersApi.update(confirmRemove.id, { isActive: !confirmRemove.isActive });
            setConfirmRemove(null);
            list.refresh();
          } catch (err) { toastError(err); }
        }}
      />

      <Modal open={!!created} onClose={() => setCreated(null)} title="Account created"
        description="Share this password once, over a channel you control. It is not stored anywhere in readable form and cannot be shown again."
        footer={<Button tone="primary" onClick={() => { navigator.clipboard?.writeText(created.temporaryPassword ?? ''); setCreated(null); }}>Copy and close</Button>}>
        {created?.temporaryPassword ? (
          <div className="stack">
            <p className="created-password mono">{created.temporaryPassword}</p>
            <p className="form-note">{created.user.fullName} will be required to choose their own password at first sign-in.</p>
          </div>
        ) : <p className="form-note">The account is ready; you set the password yourself, so nothing is displayed here.</p>}
      </Modal>
    </>
  );
}

let toastHolder = null;
function toastError(err) { toastHolder?.error(errorText(err)); }

function UserFormModal({ state, onClose, onSaved, onCreated }) {
  const toast = useToast();
  useEffect(() => { toastHolder = toast; }, [toast]);
  const [form, setForm] = useState({});
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const isEdit = Boolean(state?.id);

  useEffect(() => {
    if (!state) return;
    setForm({
      fullName: state.fullName ?? '', email: state.email ?? '', roleCode: state.roleCode ?? 'reporter',
      employeeId: state.employeeId ?? '', jobTitle: state.jobTitle ?? '', department: state.department ?? 'Biomedical Engineering',
      phone: state.phone ?? '', password: '', mustChangePassword: state.mustChangePassword ?? true,
    });
    setErrors({});
  }, [state]);

  const submit = async () => {
    setBusy(true); setErrors({});
    const payload = Object.fromEntries(Object.entries(form).filter(([, v]) => v !== '' && v !== null && !(v === false && isEdit)));
    try {
      if (isEdit) { await usersApi.update(state.id, payload); onSaved(); }
      else { const res = await usersApi.create(payload); onCreated(res); onClose(); }
      toast.success(isEdit ? 'Account updated.' : 'Account created.');
    } catch (err) {
      const mapped = {};
      for (const [k, v] of Object.entries(err.fieldErrors ?? {})) mapped[k] = Array.isArray(v) ? v.join(' ') : String(v);
      setErrors(mapped);
      toast.error(errorText(err));
    } finally { setBusy(false); }
  };

  if (!state) return null;
  return (
    <Modal open onClose={onClose} title={isEdit ? `Edit ${state.fullName}` : 'Add a user'}
      description="Email is the sign-in name. Leave the password blank to generate one that must be changed at first sign-in."
      footer={<><Button tone="ghost" onClick={onClose}>Cancel</Button><Button tone="primary" loading={busy} onClick={submit}>{isEdit ? 'Save account' : 'Create account'}</Button></>}>
      <div className="form-grid form-grid--2">
        <Field label="Full name" required error={errors.fullName}><TextInput value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} /></Field>
        <Field label="Email" required error={errors.email}><TextInput type="email" autoComplete="off" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        <Field label="Role" required error={errors.roleCode}>
          <Select value={form.roleCode} onChange={(e) => setForm({ ...form, roleCode: e.target.value })}
            options={[{ value: 'admin', label: 'Administrator' }, { value: 'technician', label: 'Technician / biomedical engineer' }, { value: 'reporter', label: 'Student / staff reporter' }]} />
        </Field>
        <Field label="Staff / student ID" error={errors.employeeId}><TextInput value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })} /></Field>
        <Field label="Job title" error={errors.jobTitle}><TextInput value={form.jobTitle} onChange={(e) => setForm({ ...form, jobTitle: e.target.value })} /></Field>
        <Field label="Department" error={errors.department}><TextInput value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} /></Field>
        <Field label="Phone" error={errors.phone} hint="Used only if SMS notifications are enabled later."><TextInput value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
        {!isEdit ? <Field label="Initial password" error={errors.password} hint="At least 12 characters, three character families. Blank = generated."><TextInput type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field> : null}
      </div>
      {!isEdit ? <label className="check"><input type="checkbox" checked={form.mustChangePassword} onChange={(e) => setForm({ ...form, mustChangePassword: e.target.checked })} /><span className="check__box" aria-hidden="true" /><span className="check__text"><span className="check__label">Require a password change at first sign-in</span></span></label> : null}
    </Modal>
  );
}

function PasswordModal({ state, onClose }) {
  const toast = useToast();
  const [form, setForm] = useState({ newPassword: '', mustChange: true, revokeSessions: true });
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});
  useEffect(() => { if (state) { setForm({ newPassword: '', mustChange: true, revokeSessions: true }); setResult(null); setErrors({}); } }, [state]);
  if (!state) return null;
  const submit = async () => {
    setBusy(true); setErrors({});
    try {
      const res = await usersApi.resetPassword(state.id, { newPassword: form.newPassword || undefined, mustChange: form.mustChange, revokeSessions: form.revokeSessions });
      setResult(res);
    } catch (err) {
      const mapped = {};
      for (const [k, v] of Object.entries(err.fieldErrors ?? {})) mapped[k] = Array.isArray(v) ? v.join(' ') : String(v);
      setErrors(mapped);
      toast.error(errorText(err));
    } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Reset password for ${state.fullName}`}
      description="A reset signs the person out of every device, which is what you want when a laptop is lost or someone leaves."
      footer={<>{!result ? <><Button tone="ghost" onClick={onClose}>Cancel</Button><Button tone="primary" loading={busy} onClick={submit}>Reset password</Button></> : <Button tone="primary" onClick={onClose}>Done</Button>}</>}>
      {result ? (
        <div className="stack">
          <p className="created-password mono">{result.temporaryPassword}</p>
          <p className="form-note">Give this to {state.email} now — it is not retrievable afterwards. {result.sessionsRevoked ? ` ${result.sessionsRevoked} session(s) were revoked.` : ''}</p>
        </div>
      ) : (
        <div className="stack">
          <Field label="New password" error={errors.password} hint="Leave blank to have a strong one generated.">
            <TextInput type="password" autoComplete="new-password" value={form.newPassword} onChange={(e) => setForm({ ...form, newPassword: e.target.value })} />
          </Field>
          <label className="check"><input type="checkbox" checked={form.mustChange} onChange={(e) => setForm({ ...form, mustChange: e.target.checked })} /><span className="check__box" aria-hidden="true" /><span className="check__label">Require a change at next sign-in</span></label>
          <label className="check"><input type="checkbox" checked={form.revokeSessions} onChange={(e) => setForm({ ...form, revokeSessions: e.target.checked })} /><span className="check__box" aria-hidden="true" /><span className="check__label">Sign them out of all devices</span></label>
        </div>
      )}
    </Modal>
  );
}
