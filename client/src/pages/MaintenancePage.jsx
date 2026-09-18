import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { maintenance as maintenanceApi, equipment as equipmentApi, reference } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { PageHeader } from '../components/AppShell.jsx';
import { Badge, Button, Callout, Card, Checkbox, ConfirmDialog, DataTable, EmptyState, ErrorState, Field, Loading, Modal, Pagination, Select, Tabs, TextArea, TextInput } from '../components/ui.jsx';
import { MaintenanceLight, KeyValue, formatDate } from '../components/display.jsx';
import { useToast, errorText } from '../components/Toast.jsx';
import { useApi } from '../utils/useApi.js';
import { cx, toDateInput } from '../utils/format.js';

/**
 * Preventive maintenance: the due board, the schedules that produce it, and the record of
 * what was actually done.  One screen because a technician moves between all three in a visit.
 */
export function MaintenancePage() {
  const [params, setParams] = useSearchParams();
  const { can } = useAuth();
  const tab = params.get('tab') ?? 'due';
  const equipmentFilter = params.get('equipment') ?? '';

  const set = (patch) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (!v) next.delete(k); else next.set(k, String(v)); }
    setParams(next, { replace: true });
  };

  const due = useApi(() => maintenanceApi.dueBoard({ days: tab === 'due' ? 45 : 400, includeUpToDate: tab === 'all' ? '1' : '' }), [tab]);
  const schedules = useApi(() => maintenanceApi.schedules(equipmentFilter ? { equipmentId: equipmentFilter } : {}), [equipmentFilter, tab]);
  const records = useApi(() => maintenanceApi.records({ equipmentId: equipmentFilter || undefined, perPage: 25, page: params.get('page') ?? 1 }), [equipmentFilter, params.get('page'), tab]);
  const compliance = useApi(() => maintenanceApi.compliance({ days: 180 }), []);

  const [scheduleForm, setScheduleForm] = useState(null);
  const [complete, setComplete] = useState(null);
  const [detail, setDetail] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  return (
    <>
      <PageHeader
        eyebrow="Preventive maintenance"
        title="Maintenance programme"
        description="Schedules decide what is due; signed-off records are the proof it happened. Both feed the equipment history and the compliance figures."
        actions={can('maintenance.schedule.manage') ? <Button tone="primary" onClick={() => setScheduleForm({ intervalDays: 180, checklist: '' })}>＋ New schedule</Button> : null}
      />

      <div className="grid grid--kpi" style={{ marginBottom: 'var(--sp-4)' }}>
        {[
          { label: 'Overdue', value: compliance.data?.overdueEquipment, tone: 'bad', hint: 'needs a visit now' },
          { label: 'Due soon', value: compliance.data?.dueSoonEquipment, tone: 'warn', hint: 'inside 14 days' },
          { label: 'Up to date', value: compliance.data?.upToDateEquipment, tone: 'ok', hint: 'inside interval' },
          { label: 'No schedule', value: compliance.data?.unscheduledEquipment, tone: 'neutral', hint: 'invisible to the board' },
          { label: 'Visits on time', value: compliance.data?.onTimePercent === null ? '—' : `${compliance.data?.onTimePercent ?? 0}%`, tone: 'info', hint: `${compliance.data?.recordsOnTime ?? 0}/${compliance.data?.recordsDone ?? 0} in 180 days` },
        ].map((k) => (
          <div key={k.label} className={cx('kpi', `kpi--${k.tone}`)}>
            <p className="kpi__label">{k.label}</p><p className="kpi__value">{k.value ?? '—'}</p><p className="kpi__hint">{k.hint}</p>
          </div>
        ))}
      </div>

      <Tabs active={tab} onChange={(id) => set({ tab: id })} tabs={[
        { id: 'due', label: 'Due board' },
        { id: 'schedules', label: 'Schedules', count: schedules.data?.items?.length },
        { id: 'records', label: 'History' },
      ]} />

      <div className="tabpanel">
        {tab === 'due' || tab === 'all' ? (
          <Card pad={false} title={tab === 'all' ? 'Every scheduled item' : 'Due in the next 45 days (and anything overdue)'}>
            {due.loading && !due.data ? <Loading rows={4} /> : (
              <DataTable
                rows={due.data?.items ?? []}
                empty={<EmptyState icon="🟢" title="Nothing is due" description="Every scheduled item is inside its interval. If some equipment has no schedule, that is a gap worth closing." />}
                columns={[
                  { key: 'equipmentName', label: 'Equipment', render: (r) => (<div className="cell-main"><Link className="cell-title" to={`/equipment/${r.equipmentId}`}>{r.equipmentName}</Link><span className="cell-sub">{r.assetTag} · {r.locationName ?? 'no room recorded'}</span></div>) },
                  { key: 'pmState', label: 'Status', render: (r) => <MaintenanceLight state={r.pmState.state} label={r.pmState.label} /> },
                  { key: 'nextMaintenanceOn', label: 'Due', render: (r) => formatDate(r.nextMaintenanceOn) },
                  { key: 'lastMaintenanceOn', label: 'Last done', render: (r) => (r.lastMaintenanceOn ? formatDate(r.lastMaintenanceOn) : <span className="muted">never</span>) },
                  { key: 'nextScheduleTitle', label: 'Schedule', render: (r) => r.nextScheduleTitle ?? <Badge tone="neutral" size="sm">no schedule</Badge> },
                  { key: 'responsibleTechnicianName', label: 'Owner', render: (r) => r.responsibleTechnicianName ?? <span className="muted">unassigned</span> },
                  { key: 'actions', label: '', render: (r) => (
                    <div className="row row--tight">
                      {can('maintenance.record.write') && r.scheduleCount > 0 ? (
                        <Button size="sm" tone="primary" onClick={() => { set({ tab: 'schedules', equipment: r.equipmentId }); }}>Record PM</Button>
                      ) : null}
                      <Button size="sm" as={Link} to={`/equipment/${r.equipmentId}`} tone="ghost">Open item</Button>
                    </div>
                  ) },
                ]}
              />
            )}
            {can('meta.manage') ? <div style={{ padding: 'var(--sp-3) var(--sp-4)', borderTop: '1px solid var(--line)' }}><ReminderButton onDone={() => { due.refresh(); }} /></div> : null}
          </Card>
        ) : null}

        {tab === 'schedules' ? (
          <Card pad={false} title="Schedules" subtitle="One per inspection type per item; the earliest due date drives the board"
            actions={equipmentFilter ? <Button size="sm" tone="ghost" onClick={() => set({ equipment: '' })}>Clear equipment filter</Button> : null}>
            {schedules.loading && !schedules.data ? <Loading rows={4} /> : (
              <DataTable
                rows={schedules.data?.items ?? []}
                empty={<EmptyState icon="◷" title="No schedules yet" description="Add one per item — daily, quarterly, annual — with the checks the manufacturer manual requires." />}
                columns={[
                  { key: 'title', label: 'Schedule', render: (r) => (<div className="cell-main"><button type="button" className="cell-title linklike" onClick={() => setDetail(r)}>{r.title}</button><span className="cell-sub">{r.equipmentName} · {r.assetTag}</span></div>) },
                  { key: 'intervalDays', label: 'Interval', align: 'center', render: (r) => `${r.intervalDays} d` },
                  { key: 'lastDoneOn', label: 'Last', render: (r) => (r.lastDoneOn ? formatDate(r.lastDoneOn) : '—') },
                  { key: 'nextDueOn', label: 'Next due', render: (r) => (<span>{formatDate(r.nextDueOn)} <MaintenanceLight state={r.pmState.state} /></span>) },
                  { key: 'checklistCount', label: 'Checks', align: 'center' },
                  { key: 'timesDone', label: 'Done', align: 'center' },
                  { key: 'responsibleTechnicianName', label: 'Owner', render: (r) => r.responsibleTechnicianName ?? <span className="muted">—</span> },
                  { key: 'actions', label: '', render: (r) => (
                    <div className="row row--tight">
                      {can('maintenance.record.write') ? <PMCompleteDialog schedule={r} onDone={() => { schedules.refresh(); due.refresh(); records.refresh(); }} trigger={<Button size="sm" tone="primary">Complete</Button>} /> : null}
                      {can('maintenance.schedule.manage') ? <Button size="sm" tone="ghost" onClick={() => setScheduleForm({ ...r, checklist: (r.checklist ?? []).map((c) => c.label).join('\n') })}>Edit</Button> : null}
                      {can('meta.manage') ? <Button size="sm" tone="ghost" onClick={() => setConfirmDelete(r)}>Delete</Button> : null}
                    </div>
                  ) },
                ]}
              />
            )}
          </Card>
        ) : null}

        {tab === 'records' ? (
          <Card pad={false} title="Maintenance history" subtitle="Signed-off preventive visits, with checklist findings">
            {records.loading && !records.data ? <Loading rows={5} /> : (
              <>
                <DataTable
                  rows={records.data?.rows ?? []}
                  empty={<EmptyState icon="📄" title="No records" description="Completed visits appear here, and in each item’s history." />}
                  columns={[
                    { key: 'reference', label: 'Reference', mono: true },
                    { key: 'equipmentName', label: 'Equipment', render: (r) => (<div className="cell-main"><Link className="cell-title" to={`/equipment/${r.equipmentId ?? ''}`}>{r.equipmentName}</Link><span className="cell-sub">{r.assetTag}</span></div>) },
                    { key: 'performedOn', label: 'Performed', render: (r) => formatDate(r.performedOn) },
                    { key: 'daysLate', label: 'Late', align: 'center', render: (r) => (r.daysLate > 0 ? <Badge tone="warn" size="sm">{r.daysLate} d</Badge> : <span className="muted">on time</span>) },
                    { key: 'conditionFound', label: 'Condition', render: (r) => <Badge tone={r.conditionFound === 'pass' ? 'ok' : r.conditionFound?.includes('needs') ? 'warn' : 'neutral'}>{(r.conditionFound ?? '—').replace(/_/g, ' ')}</Badge> },
                    { key: 'findings', label: 'Findings' },
                    { key: 'performedByName', label: 'By' },
                  ]}
                />
                <Pagination pagination={records.data?.pagination} onPage={(page) => set({ page })} />
              </>
            )}
          </Card>
        ) : null}
      </div>

      <ScheduleFormModal state={scheduleForm} onClose={() => setScheduleForm(null)} onDone={() => { setScheduleForm(null); schedules.refresh(); due.refresh(); }} />
      <ScheduleDetailModal row={detail} onClose={() => setDetail(null)} onDone={() => { setDetail(null); schedules.refresh(); }} />
      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete this schedule?"
        body={confirmDelete ? `“${confirmDelete.title}” on ${confirmDelete.equipmentName}. Completed records stay in the history but lose their schedule link.` : ''}
        confirmLabel="Delete schedule"
        onCancel={() => setConfirmDelete(null)}
        busy={false}
        onConfirm={async ({ confirmText }) => {
          try { await maintenanceApi.deleteSchedule(confirmDelete.id, confirmText ?? 'superseded'); toast.success('Schedule deleted.'); setConfirmDelete(null); schedules.refresh(); due.refresh(); }
          catch (err) { toast.error(errorText(err), { detail: err.details?.fields?.reason ? 'Give a reason in the box, then try again.' : null }); }
        }}
      />
    </>
  );
}

function ReminderButton({ onDone }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <form className="row row--between" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      try { const r = await maintenanceApi.reminders(); toast.success(`${r.sent} reminder(s) sent; ${r.skipped} already sent recently.`); onDone(); }
      catch (err) { toast.error(errorText(err)); } finally { setBusy(false); }
    }}>
      <p className="form-note">Reminder sweep — notifies owners of overdue and soon-due items. Idempotent: nothing is re-sent within 7 days.</p>
      <Button size="sm" tone="secondary" loading={busy} type="submit">Run reminder sweep</Button>
    </form>
  );
}

function PMCompleteDialog({ schedule, onDone }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});
  const [form, setForm] = useState(null);
  const detail = useApi(() => (open ? maintenanceApi.schedule(schedule.id) : Promise.resolve(null)), [open, schedule.id]);
  const target = detail.data;

  useEffect(() => {
    if (!open) return;
    setForm({
      performedOn: toDateInput(new Date()),
      durationMinutes: '',
      downtimeMinutes: '',
      findings: '',
      actionsTaken: '',
      conditionFound: '',
      markAsMissed: false,
      checklist: (target?.checklist ?? []).map((c) => ({ itemId: c.id, label: c.label, outcome: 'pass', note: '' })),
    });
  }, [open, target?.checklist]);

  const submit = async () => {
    setBusy(true); setErrors({});
    try {
      await maintenanceApi.complete(target?.id ?? schedule.id, {
        performedOn: form.performedOn,
        durationMinutes: form.durationMinutes === '' ? undefined : Number(form.durationMinutes),
        downtimeMinutes: form.downtimeMinutes === '' ? undefined : Number(form.downtimeMinutes),
        findings: form.findings || undefined,
        actionsTaken: form.actionsTaken || undefined,
        conditionFound: form.conditionFound || undefined,
        markAsMissed: form.markAsMissed,
        checklistResults: form.checklist.map((c) => ({ itemId: c.itemId, label: c.label, outcome: c.outcome, note: c.note || undefined })),
      });
      toast.success(form.markAsMissed ? 'Missed visit recorded — the item stays overdue, as it should.' : 'Maintenance signed off; the next due date has moved forward.');
      setOpen(false);
      onDone();
    } catch (err) {
      const mapped = {};
      for (const [k, v] of Object.entries(err.fieldErrors ?? {})) mapped[k] = Array.isArray(v) ? v.join(' ') : String(v);
      setErrors(mapped);
      toast.error(errorText(err));
    } finally { setBusy(false); }
  };

  const failedCount = form?.checklist.filter((c) => c.outcome === 'fail').length ?? 0;

  return (
    <>
      <Button size="sm" tone="primary" onClick={() => setOpen(true)}>Complete</Button>
      <Modal
        open={open}
        onClose={() => !busy && setOpen(false)}
        size="lg"
        title={`Complete “${target?.title ?? schedule.title ?? 'maintenance'}”`}
        description={target ? `${target.equipmentName} · ${target.assetTag} · every ${target.intervalDays} days` : ''}
        footer={(
          <>
            <Button tone="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button tone="primary" loading={busy} onClick={submit}>{form?.markAsMissed ? 'Record missed visit' : 'Sign off maintenance'}</Button>
          </>
        )}
      >
        {!form ? <Loading rows={4} /> : (
          <div className="stack">
            <div className="form-grid form-grid--2">
              <Field label="Date performed" required error={errors.performedOn}><TextInput type="date" max={toDateInput(new Date())} value={form.performedOn} onChange={(e) => setForm({ ...form, performedOn: e.target.value })} /></Field>
              <Field label="Time spent (minutes)" error={errors.durationMinutes}><TextInput type="number" min="0" value={form.durationMinutes} onChange={(e) => setForm({ ...form, durationMinutes: e.target.value })} placeholder="e.g. 45" /></Field>
              <Field label="Equipment downtime (minutes)" error={errors.downtimeMinutes} hint="How long it was unavailable to the department."><TextInput type="number" min="0" value={form.downtimeMinutes} onChange={(e) => setForm({ ...form, downtimeMinutes: e.target.value })} /></Field>
              <Field label="Condition found" error={errors.conditionFound} hint="Left blank, a clean pass is recorded; a failed check sets “needs attention”.">
                <Select value={form.conditionFound} onChange={(e) => setForm({ ...form, conditionFound: e.target.value })} placeholder="Auto from the checklist"
                  options={['pass', 'pass_with_notes', 'needs_attention', 'needs_repair', 'replaced'].map((v) => ({ value: v, label: v.replace(/_/g, ' ') }))} />
              </Field>
            </div>

            {form.checklist.length ? (
              <div className="stack">
                <p className="form-section__title">Checklist ({form.checklist.length})</p>
                <ul className="checklist">
                  {form.checklist.map((c, i) => (
                    <li key={c.itemId ?? i} className={cx('checklist__item', c.outcome === 'fail' && 'checklist__item--fail')}>
                      <div className="checklist__label">
                        <input id={`cl-${i}`} type="checkbox" className="sr-only" checked={c.outcome === 'pass'} onChange={(e) => setForm({ ...form, checklist: form.checklist.map((x, j) => (j === i ? { ...x, outcome: e.target.checked ? 'pass' : 'fail' } : x)) })} />
                        <label htmlFor={`cl-${i}`} className="checklist__toggle" title="Pass">✓ {c.label}</label>
                      </div>
                      <div className="row row--tight">
                        <select className="input input--sm" value={c.outcome} onChange={(e) => setForm({ ...form, checklist: form.checklist.map((x, j) => (j === i ? { ...x, outcome: e.target.value } : x)) })} aria-label={`Outcome for ${c.label}`}>
                          <option value="pass">Pass</option><option value="fail">Fail</option><option value="na">N/A</option>
                        </select>
                      </div>
                      <TextInput className="input--sm" placeholder="Note (required reading for the next visit)" value={c.note} aria-label={`Note for ${c.label}`}
                        onChange={(e) => setForm({ ...form, checklist: form.checklist.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)) })} />
                    </li>
                  ))}
                </ul>
              </div>
            ) : <Callout tone="info">This schedule has no checklist items. Consider adding the manual’s checks so the next technician has something to work against.</Callout>}

            {failedCount > 0 ? (
              <Callout tone="warn" title={`${failedCount} check(s) failed`}>
                This visit will be recorded as <b>needs attention</b> and the department is notified. Preventive maintenance does not open
                a repair job: raise a <Link to="/faults/new">fault report</Link> so the work is tracked, assigned and costed.
              </Callout>
            ) : null}

            <div className="form-grid form-grid--2">
              <Field label="Findings" error={errors.findings}><TextArea rows={3} value={form.findings} onChange={(e) => setForm({ ...form, findings: e.target.value })} placeholder="What you measured and saw, including anything marginal." /></Field>
              <Field label="Actions taken" error={errors.actionsTaken}><TextArea rows={3} value={form.actionsTaken} onChange={(e) => setForm({ ...form, actionsTaken: e.target.value })} placeholder="Consumables renewed, cleaning, adjustments, labels updated." /></Field>
            </div>

            <Checkbox
              label="This visit could not be carried out (record it as missed)"
              hint="Honest bookkeeping: the item stays overdue and the compliance figure reflects the miss, rather than the date silently moving forward."
              checked={form.markAsMissed}
              onChange={(v) => setForm({ ...form, markAsMissed: v })}
            />
            {form.markAsMissed ? <Field label="Why not?" required error={errors.findings}><TextInput value={form.findings} onChange={(e) => setForm({ ...form, findings: e.target.value })} placeholder="e.g. Room booked for OSCEs all week" /></Field> : null}
          </div>
        )}
      </Modal>
    </>
  );
}

function ScheduleFormModal({ state, onClose, onDone }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});
  const picklists = useApi(() => reference.picklists(), []);
  const vocab = useApi(() => maintenanceApi.vocabulary(), []);
  const [form, setForm] = useState({});

  useEffect(() => {
    if (!state) return;
    setForm({
      id: state.id,
      equipmentId: state.equipmentId ?? state.equipment_id ?? '',
      title: state.title ?? 'Annual full service',
      intervalDays: state.intervalDays ?? 180,
      responsibleTechnicianId: state.responsibleTechnicianId ?? '',
      nextDueOn: toDateInput(state.nextDueOn) || '',
      lastDoneOn: toDateInput(state.lastDoneOn) || '',
      notes: state.notes ?? '',
      checklist: Array.isArray(state.checklist) ? state.checklist.map((c) => (typeof c === 'string' ? c : c.label)).join('\n')
        : (state.checklist ?? defaultChecklist(state.title, vocab.data?.checklistTemplates)).join('\n'),
    });
    setErrors({});
  }, [state, vocab.data]);

  const submit = async () => {
    setBusy(true); setErrors({});
    const payload = {
      equipmentId: Number(form.equipmentId),
      title: form.title.trim(),
      intervalDays: Number(form.intervalDays),
      responsibleTechnicianId: form.responsibleTechnicianId ? Number(form.responsibleTechnicianId) : undefined,
      nextDueOn: form.nextDueOn || undefined,
      lastDoneOn: form.lastDoneOn || undefined,
      notes: form.notes || undefined,
      checklist: form.checklist.split('\n').map((s) => s.trim()).filter(Boolean),
    };
    try {
      if (form.id) await maintenanceApi.updateSchedule(form.id, payload);
      else await maintenanceApi.createSchedule(payload);
      toast.success(form.id ? 'Schedule updated.' : 'Schedule created and added to the due board.');
      onDone();
    } catch (err) {
      const mapped = {};
      for (const [k, v] of Object.entries(err.fieldErrors ?? {})) mapped[k] = Array.isArray(v) ? v.join(' ') : String(v);
      setErrors(mapped);
      toast.error(errorText(err));
    } finally { setBusy(false); }
  };

  const applyTemplate = (title) => {
    const key = title.toLowerCase().split(' ')[0];
    const tpl = (vocab.data?.checklistTemplates ?? []).find((t) => t.interval === key);
    setForm((f) => ({ ...f, title, ...(tpl ? { checklist: tpl.items.join('\n') } : {}) }));
  };

  return (
    <Modal open={!!state} onClose={() => !busy && onClose()} size="lg"
      title={state?.id ? 'Edit maintenance schedule' : 'New maintenance schedule'}
      description="Interval + checklist + owner. The equipment’s next-due date follows the earliest active schedule."
      footer={<><Button tone="ghost" onClick={onClose}>Cancel</Button><Button tone="primary" loading={busy} onClick={submit}>{state?.id ? 'Save schedule' : 'Create schedule'}</Button></>}>
      <div className="form-grid form-grid--2">
        <Field label="Equipment" required error={errors.equipmentId}>
          {!state?.id
            ? <EquipmentChooser value={form.equipmentId} onChange={(v) => setForm({ ...form, equipmentId: v })} />
            : <p className="form-note">{state.equipmentName} · <code>{state.assetTag}</code></p>}
        </Field>
        <Field label="Schedule title" required error={errors.title} hint="Matching a template name (Monthly, Quarterly, Annual…) pre-fills a checklist you can edit.">
          <TextInput value={form.title ?? ''} onChange={(e) => applyTemplate(e.target.value)} placeholder="Annual full service" />
        </Field>
        <Field label="Interval (days)" required error={errors.intervalDays}>
          <TextInput type="number" min="1" max="3650" value={form.intervalDays ?? ''} onChange={(e) => setForm({ ...form, intervalDays: e.target.value })} />
        </Field>
        <Field label="Next due" error={errors.nextDueOn} hint="Blank = interval from today or from the last done date.">
          <TextInput type="date" value={form.nextDueOn ?? ''} onChange={(e) => setForm({ ...form, nextDueOn: e.target.value })} />
        </Field>
        <Field label="Last performed" error={errors.lastDoneOn}><TextInput type="date" value={form.lastDoneOn ?? ''} onChange={(e) => setForm({ ...form, lastDoneOn: e.target.value })} /></Field>
        <Field label="Responsible technician" error={errors.responsibleTechnicianId}>
          <Select value={form.responsibleTechnicianId ?? ''} onChange={(e) => setForm({ ...form, responsibleTechnicianId: e.target.value })} placeholder="From the equipment record"
            options={(picklists.data?.technicians ?? []).map((t) => ({ value: t.id, label: t.fullName }))} />
        </Field>
      </div>
      <Field label="Checklist (one item per line)" error={errors.checklist} hint="These become individual rows, so each result can be recorded per visit.">
        <TextArea rows={7} value={form.checklist ?? ''} onChange={(e) => setForm({ ...form, checklist: e.target.value })} />
      </Field>
      <Field label="Notes" error={errors.notes}><TextArea rows={2} value={form.notes ?? ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
    </Modal>
  );
}

function EquipmentChooser({ value, onChange }) {
  const [q, setQ] = useState('');
  const res = useApi(() => equipmentApi.list({ q: q || undefined, perPage: 8 }), [q]);
  return (
    <div className="stack">
      <TextInput placeholder="Search equipment to attach this schedule to…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search equipment" />
      <ul className="chips">
        {(res.data?.items ?? []).map((e) => (
          <li key={e.id}><button type="button" className={cx('chip', value === e.id && 'chip--active')} onClick={() => onChange(e.id)}><span className="chip__label">{e.name}</span><span className="chip__hint">{e.assetTag}</span></button></li>
        ))}
      </ul>
    </div>
  );
}

const defaultChecklist = (title, templates = []) => {
  const key = String(title ?? '').toLowerCase().split(' ')[0];
  return templates.find((t) => t.interval === key)?.items ?? [];
};

function ScheduleDetailModal({ row, onClose, onDone }) {
  const detail = useApi(() => (row ? maintenanceApi.schedule(row.id) : Promise.resolve(null)), [row?.id]);
  return (
    <Modal open={!!row} onClose={onClose} size="lg" title={row ? `${row.title} · ${row.equipmentName}` : ''} description="Definition, recent visits and the state of the clock."
      footer={<><Button tone="ghost" onClick={onClose}>Close</Button></>}>
      {detail.loading ? <Loading rows={4} /> : detail.data && (
        <div className="stack">
          <KeyValue columns={3} items={[
            ['Interval', `${detail.data.intervalDays} days`],
            ['Next due', <span>{formatDate(detail.data.nextDueOn)} <MaintenanceLight state={detail.data.pmState.state} /></span>],
            ['Last done', formatDate(detail.data.lastDoneOn)],
            ['Owner', detail.data.responsibleTechnicianName ?? 'Unassigned'],
            ['Times completed', detail.data.recentRecords?.length ?? 0],
            ['Notes', detail.data.notes],
          ]} />
          <div>
            <p className="form-section__title">Checklist</p>
            <ol className="steps">
              {(detail.data.checklist ?? []).map((c) => <li key={c.id}>{c.label}{c.requiresEvidence ? <Badge size="sm" tone="neutral"> evidence required</Badge> : null}</li>)}
            </ol>
          </div>
          <div>
            <p className="form-section__title">Recent visits</p>
            <DataTable dense rows={detail.data.recentRecords ?? []} columns={[
              { key: 'performedOn', label: 'Date', render: (r) => formatDate(r.performedOn) },
              { key: 'dueOn', label: 'Was due', render: (r) => formatDate(r.dueOn) },
              { key: 'daysLate', label: 'Late', align: 'center', render: (r) => (r.daysLate > 0 ? <Badge tone="warn" size="sm">{r.daysLate} d</Badge> : '—') },
              { key: 'conditionFound', label: 'Condition', render: (r) => <Badge tone={r.conditionFound === 'pass' ? 'ok' : 'warn'}>{(r.conditionFound ?? '—').replace(/_/g, ' ')}</Badge> },
              { key: 'findings', label: 'Findings' },
            ]} empty={<p className="form-note">No visits recorded against this schedule yet.</p>} />
          </div>
        </div>
      )}
    </Modal>
  );
}
