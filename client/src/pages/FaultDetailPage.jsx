import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { attachments, faults as faultsApi, parts as partsApi, users } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { PageHeader } from '../components/AppShell.jsx';
import { Button, Callout, Checkbox, ChoiceChips, ConfirmDialog, ErrorState, Field, Loading, Modal, Select, TextArea, TextInput } from '../components/ui.jsx';
import { Badge, Card, EquipmentStatusPill, FaultStatusPill, KeyValue, MaintenanceLight, Money, SeverityPill, Timeline, formatDate } from '../components/display.jsx';
import { FileInput } from '../components/FileInput.jsx';
import { useToast, errorText } from '../components/Toast.jsx';
import { useApi } from '../utils/useApi.js';
import { cx, formatDateTime, formatDuration, formatMoney, pluralise, toDateInput } from '../utils/format.js';
import { FAULT_STATUS, SEVERITY } from '../utils/constants.js';

/**
 * One fault report: what was said, who owns it, what was found, what it cost, and what the
 * reader is allowed to do about it.  The action panel is generated from `fault.nextStatuses`
 * — the server's own answer to "what is legal from here for this person" — so the UI cannot
 * offer a move the API would refuse.
 */
export function FaultDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user, can, is } = useAuth();
  const toast = useToast();
  const { data, loading, error, refresh } = useApi(() => faultsApi.get(id), [id]);
  const [repairOpen, setRepairOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [amendOpen, setAmendOpen] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);

  if (error) return <ErrorState error={error} onRetry={refresh} />;
  if (loading && !data) return <Loading rows={9} label="Loading the fault report" />;

  const f = data.fault;
  const eq = data.equipment;
  const repair = data.repair;
  const readiness = data.readiness;
  const canWork = is('technician') && (f.assignedTo === user.id || !f.assignedTo);

  const doTransition = async (target, comment) => {
    setBusy(true);
    try {
      await faultsApi.transition(f.id, target, comment);
      toast.success(`Report moved to ${FAULT_STATUS[target]?.label ?? target}.`);
      await refresh();
    } catch (err) { toast.error(errorText(err), { detail: err.details?.missing ? `Still needed: ${err.details.missing.join(', ')}` : null }); }
    finally { setBusy(false); setConfirm(null); }
  };

  return (
    <>
      <PageHeader
        back={{ to: is('reporter') ? '/my-reports' : (can('fault.view.any') ? '/faults' : '/work'), label: 'Back to reports' }}
        eyebrow={<span>Report <code>{f.reference}</code></span>}
        title={f.title}
        actions={(
          <>
            {f.isOverdue ? <Badge tone="bad" size="lg">Past the response target</Badge> : null}
            <Button as={Link} to={`/equipment/${eq.id}`} tone="secondary">Equipment record</Button>
          </>
        )}
      />

      <div className="row" style={{ gap: 8, marginBottom: 'var(--sp-4)', flexWrap: 'wrap' }}>
        <SeverityPill severity={f.severity} size="lg" />
        <FaultStatusPill status={f.status} size="lg" />
        <EquipmentStatusPill status={eq.status} size="lg" />
        {f.diagnosisConfirmed ? <Badge tone="ok">Diagnosis recorded by a technician</Badge> : null}
        {f.repairReference ? <Badge tone="info">Repair record {f.repairReference}</Badge> : null}
        {f.attachmentCount ? <Badge tone="neutral">📎 {pluralise(f.attachmentCount, 'file')}</Badge> : null}
      </div>

      <div className="grid grid--split" style={{ alignItems: 'start' }}>
        <div className="stack">
          <WorkflowStrip current={f.status} steps={f.workflow} />

          <Card title="Reported problem" subtitle={`${formatDateTime(f.createdAt)} · by ${f.reportedByName}${f.onBehalfOf ? ` on behalf of ${f.onBehalfOf}` : ''}`}>
            <p style={{ whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>{f.description}</p>
            <KeyValue
              className="detail-specs"
              columns={3}
              items={[
                ['Observed', formatDateTime(f.observedAt)],
                ['Location', f.locationName ?? 'As recorded on the equipment'],
                ['Fault category', f.categoryName ?? '—'],
                ['Response target', f.dueAt ? <span>{formatDateTime(f.dueAt)} {f.isOverdue ? <Badge tone="bad" size="sm">{formatDuration(f.minutesOverdue)} late</Badge> : <Badge tone="ok" size="sm">within target</Badge>}</span> : '—'],
                ['Acknowledged', f.acknowledgedAt ? formatDateTime(f.acknowledgedAt) : null],
                ['Repaired', f.repairedAt ? formatDateTime(f.repairedAt) : null],
                ['Verified by', f.verifiedByName ? `${f.verifiedByName}${f.verifiedAt ? ` · ${formatDateTime(f.verifiedAt)}` : ''}` : null],
                ['Closed', f.closedAt ? formatDateTime(f.closedAt) : null],
                ['Time to repair', f.timings?.minutesToRepair ? formatDuration(f.timings.minutesToRepair) : null],
              ]}
            />
            {f.resolutionNote ? <Callout tone="ok" title="Resolution recorded">{f.resolutionNote}</Callout> : null}
            {f.status === 'repaired' && is('reporter') ? (
              <Callout tone="info" title="This is waiting for you">
                A technician says it is fixed. Try it and verify (or say what is still wrong) so the report can be closed.
              </Callout>
            ) : null}
          </Card>

          {repair ? <RepairRecordCard repair={repair} canEdit={canWork && !['closed'].includes(f.status)} onEdit={() => setRepairOpen(true)} faultId={f.id} onRefresh={refresh} />
            : canWork ? (
              <Card title="Repair record" subtitle="Nothing recorded yet">
                <p className="form-note">
                  Write what you found and what you did. The equipment is only returned to service after the record contains a
                  diagnosis, the work performed, the tests that prove it works and your safety confirmation.
                </p>
                <Button tone="primary" onClick={() => setRepairOpen(true)}>Record the repair</Button>
              </Card>
            ) : (
              <Card title="Repair record">
                <p className="form-note">No repair record yet. {is('reporter') ? 'Technicians will add this when they work on it.' : 'Assign a technician who can diagnose it.'}</p>
              </Card>
            )}

          {data.attachments.length ? (
            <Card title="Photographs and documents" subtitle="Submitted with the report and during the repair">
              <ul className="attach-grid">
                {data.attachments.map((a) => (
                  <li key={a.id} className="attach">
                    {a.mimeType.startsWith('image/')
                      ? <a href={attachments.viewUrl(a.id)} target="_blank" rel="noreferrer"><img className="attach__img" src={attachments.viewUrl(a.id)} alt={a.caption ?? a.filename} /></a>
                      : <a className="attach__doc" href={attachments.viewUrl(a.id)} target="_blank" rel="noreferrer">📄 {a.mimeType.includes('pdf') ? 'PDF' : 'file'}</a>}
                    <div className="attach__meta">
                      <span className="attach__name" title={a.filename}>{a.filename}</span>
                      <span>{a.kind.replace(/_/g, ' ')} · {formatDate(a.createdAt)} · {a.uploadedByName}</span>
                    </div>
                    {(can('attachment.view.any')) && f.isOpen ? (
                      <button type="button" className="attach__remove" onClick={async () => { await attachments.remove(a.id); toast.success('Attachment removed.'); refresh(); }}>Remove</button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <Card title="Timeline" subtitle="Every status change and note, with who made it" actions={<Button size="sm" tone="ghost" onClick={() => setNoteOpen(true)}>Add a note</Button>}>
            <Timeline items={data.timeline.map((h) => ({
              id: h.id,
              title: h.isNote
                ? <>Note {h.fromStatus ? `(${FAULT_STATUS[h.fromStatus]?.label ?? h.fromStatus})` : ''}</>
                : <>{h.fromStatus ? <>{FAULT_STATUS[h.fromStatus]?.label ?? h.fromStatus} → </> : 'Reported '}<FaultStatusPill status={h.toStatus} size="sm" /></>,
              detail: h.comment,
              actor: h.changedByName ?? 'system',
              at: h.changedAt,
              tone: h.toStatus === 'repaired' || h.toStatus === 'verified' ? 'ok' : h.toStatus === 'closed' ? 'neutral' : h.isNote ? 'info' : null,
            }))} />
          </Card>
        </div>

        <div className="stack">
          <Card title="Take the next step">
            <div className="stack" style={{ gap: 'var(--sp-3)' }}>
              {!f.assignedTo && can('fault.assign') ? (
                <Button tone="primary" className="btn--block" onClick={() => setAssignOpen(true)}>Assign a technician…</Button>
              ) : null}
              {f.assignedTo && can('fault.assign') ? (
                <Button tone="secondary" className="btn--block" onClick={() => setAssignOpen(true)}>Reassign (currently {f.assignedToName})</Button>
              ) : null}
              {f.nextStatuses?.length ? (
                <div className="stack" style={{ gap: 8 }}>
                  <p className="field__label">Move this report to</p>
                  {f.nextStatuses.map((s) => (
                    <Button
                      key={s.value}
                      className="btn--block"
                      tone={s.value === 'closed' ? 'danger' : s.value === 'repaired' || s.value === 'verified' ? 'primary' : 'secondary'}
                      disabled={s.value === 'repaired' && readiness && !readiness.canMarkRepaired}
                      onClick={() => (s.value === 'repaired' || s.value === 'closed' || s.value === 'verified'
                        ? setConfirm({ target: s.value })
                        : setConfirm({ target: s.value }))}
                    >
                      {s.label}
                    </Button>
                  ))}
                </div>
              ) : <p className="form-note">No further moves are available to you from <b>{FAULT_STATUS[f.status]?.label}</b>{f.isOpen ? ', but the report is still open.' : '.'}</p>}

              {f.nextStatuses?.some((s) => s.value === 'repaired') === false && canWork && !readiness?.canMarkRepaired && f.isOpen ? (
                <p className="form-note">“Repaired” unlocks once the repair record has {readiness?.missing?.filter((m) => m !== 'repairRecord').map((m) => MISSING_LABEL[m] ?? m).join(', ').toLowerCase()}.</p>
              ) : null}

              {canWork ? <Button tone="secondary" className="btn--block" onClick={() => setRepairOpen(true)}>{repair ? 'Update repair record' : 'Record the repair'}</Button> : null}
              {canWork || is('admin') ? <Button tone="ghost" className="btn--block" onClick={() => setEvidenceOpen(true)}>Attach evidence</Button> : null}
              {f.status === 'reported' && (f.reportedBy === user.id || is('admin')) ? (
                <Button tone="ghost" className="btn--block" onClick={() => setAmendOpen(true)}>Amend my report</Button>
              ) : null}
              {f.canReopen ? <Button tone="danger" className="btn--block" onClick={() => setConfirm({ target: 'reopen' })}>Reopen this fault…</Button> : null}
            </div>

            {f.reportedBy === user.id && f.status !== 'reported' ? (
              <p className="form-note" style={{ marginTop: 10 }}>Once work starts, a report cannot be edited by its author — add a note instead so the original wording stays on file.</p>
            ) : null}
          </Card>

          <Card title="Equipment">
            <div className="stack" style={{ gap: 10 }}>
              <div>
                <Link to={`/equipment/${eq.id}`} className="cell-title">{eq.name}</Link>
                <p className="cell-sub"><code>{eq.assetTag}</code>{eq.locationName ? ` · ${eq.locationName}` : ''}</p>
              </div>
              <div className="row row--tight" style={{ flexWrap: 'wrap' }}>
                <EquipmentStatusPill status={eq.status} />
                {eq.nextMaintenanceOn ? <MaintenanceLight state={eq.maintenanceState} daysUntil={eq.daysUntilPm} /> : null}
              </div>
              <KeyValue columns={1} items={[
                ['Serial', <code>{eq.serialNumber}</code>],
                ['Responsible technician', f.assignedToName ?? eq.responsibleTechnicianName],
                ['Reported from', eq.locationLabel ?? eq.locationName],
              ]} />
            </div>
          </Card>

          <Callout tone="safety" title="Accountability">
            Reported by {f.reportedByName} · handled by {f.assignedToName ?? 'nobody yet'}
            {f.verifiedByName ? ` · verified by ${f.verifiedByName}` : ''}. Every change on this page is recorded with a name and a
            timestamp, and a diagnosis can only ever be written by a technician.
          </Callout>
        </div>
      </div>

      <TransitionConfirm
        state={confirm}
        fault={f}
        readiness={readiness}
        busy={busy}
        onClose={() => setConfirm(null)}
        onConfirm={(comment) => doTransition(confirm.target === 'reopen' ? null : confirm.target, comment)}
        onReopen={async (comment) => {
          setBusy(true);
          try { await faultsApi.reopen(f.id, comment, 'Reopened from the fault record'); toast.success('Fault reopened.'); await refresh(); }
          catch (err) { toast.error(errorText(err)); } finally { setBusy(false); setConfirm(null); }
        }}
      />

      <AssignDialog open={assignOpen} onClose={() => setAssignOpen(false)} fault={f} onDone={async () => { setAssignOpen(false); await refresh(); }} />
      <NoteDialog open={noteOpen} onClose={() => setNoteOpen(false)} fault={f} onDone={async () => { setNoteOpen(false); await refresh(); }} />
      <EvidenceDialog open={evidenceOpen} onClose={() => setEvidenceOpen(false)} fault={f} repair={repair} onDone={async () => { setEvidenceOpen(false); await refresh(); }} />
      <AmendDialog open={amendOpen} onClose={() => setAmendOpen(false)} fault={f} vocab={data.vocab} onDone={async () => { setAmendOpen(false); await refresh(); }} categories={undefined} />
      <RepairRecordModal open={repairOpen} onClose={() => setRepairOpen(false)} fault={f} record={repair} onDone={async () => { setRepairOpen(false); await refresh(); }} />
    </>
  );
}

const MISSING_LABEL = {
  repairRecord: 'the repair record itself', diagnosis: 'a diagnosis', rootCause: 'a root cause',
  repairActions: 'what was done', testResults: 'the test results', dateRepaired: 'the date repaired',
  safetyCheckConfirmed: 'your safety confirmation', safeToReturnToService: 'the return-to-service decision',
};

function WorkflowStrip({ current, steps }) {
  return (
    <div className="workflow" role="list" aria-label={`Workflow position: ${FAULT_STATUS[current]?.label}`}>
      {(steps ?? []).map((s, i) => (
        <div key={s.value} style={{ display: 'contents' }}>
          <div className={cx('workflow__step', s.reached && 'workflow__step--done', s.current && 'workflow__step--current')} role="listitem"
            aria-current={s.current ? 'step' : undefined}>
            <span className="workflow__dot" aria-hidden="true">{s.current ? '●' : s.reached ? '✓' : s.step ?? i + 1}</span>
            <span className="workflow__label">{s.label}</span>
          </div>
          {i < steps.length - 1 ? <span className="workflow__line" aria-hidden="true" /> : null}
        </div>
      ))}
    </div>
  );
}

function RepairRecordCard({ repair, canEdit, onEdit, faultId, onRefresh }) {
  const toast = useToast();
  const removePhoto = async (attachmentId) => {
    try { await attachments.remove(attachmentId); toast.success('Removed.'); onRefresh(); } catch (err) { toast.error(errorText(err)); }
  };
  const evidence = (repair.attachments ?? []).filter((a) => a.kind !== 'document');
  return (
    <Card
      title="Repair record"
      subtitle={`${repair.reference} · ${repair.technicianName}${repair.technicianTitle ? `, ${repair.technicianTitle}` : ''} · ${formatDate(repair.dateRepaired)}`}
      actions={canEdit ? <Button size="sm" tone="secondary" onClick={onEdit}>Edit record</Button> : null}
    >
      <KeyValue columns={1} items={[
        ['Diagnosis', repair.diagnosis],
        ['Root cause', repair.rootCause],
        ['Troubleshooting', repair.troubleshooting],
        ['Repair performed', repair.repairActions],
        ['Test results', repair.testResults],
        ['Calibration', repair.calibrationPerformed ? repair.calibrationDetails ?? 'Performed' : 'Not performed'],
        ['Parts replaced', repair.partsReplacedSummary],
      ]} />

      {repair.parts?.length ? (
        <table className="table table--inner" >
          <thead><tr><th>Part</th><th>Number</th><th className="is-center">Qty</th><th className="is-right">Unit</th><th className="is-right">Line</th></tr></thead>
          <tbody>
            {repair.parts.map((p) => (
              <tr key={p.id}>
                <td>{p.partName}{p.recovered ? <Badge size="sm" tone="neutral"> old part kept</Badge> : null}</td>
                <td><code>{p.partNumber ?? '—'}</code></td>
                <td className="is-center">{p.quantity}</td>
                <td className="is-right"><Money amount={p.unitCost} currency={repair.currency} /></td>
                <td className="is-right"><Money amount={p.lineCost} currency={repair.currency} /></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4}>Parts {formatMoney(repair.partsCost, repair.currency)} · Labour {formatMoney(repair.labourCost, repair.currency)}{Number(repair.otherCost) ? ` · Other ${formatMoney(repair.otherCost, repair.currency)}` : ''}</td>
              <td className="is-right"><b>{formatMoney(repair.totalCost, repair.currency)}</b></td>
            </tr>
          </tfoot>
        </table>
      ) : null}

      <div className="row" style={{ marginTop: 10 }}>
        {repair.safetyCheckConfirmed
          ? <Badge tone="ok">✓ Electrical safety check confirmed</Badge>
          : <Badge tone="bad">Safety check not yet confirmed</Badge>}
        {repair.safeToReturnToService
          ? <Badge tone="ok">Technician: safe to return to service</Badge>
          : <Badge tone="bad">Technician: NOT safe to return to service</Badge>}
      </div>
      {!repair.safeToReturnToService ? (
        <Callout tone="bad" title="This unit is not cleared for use" >
          The technician who worked on it has recorded that it must not go back into service. Keep it out of use until a further
          repair is recorded — this system cannot override that judgement.
        </Callout>
      ) : null}

      {evidence.length ? (
        <ul className="attach-grid" style={{ marginTop: 10 }}>
          {evidence.map((a) => (
            <li key={a.id} className="attach">
              {a.mimeType.startsWith('image/') ? <img className="attach__img" src={attachments.viewUrl(a.id)} alt={a.caption ?? a.filename} /> : <a className="attach__doc" href={attachments.viewUrl(a.id)} target="_blank" rel="noreferrer">📄 {a.filename}</a>}
              <div className="attach__meta"><span className="attach__name">{a.kind.replace(/_/g, ' ')}</span><span>{a.caption ?? a.filename}</span></div>
              {canEdit ? <button type="button" className="attach__remove" onClick={() => removePhoto(a.id)}>Remove</button> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

/* ------------------------------------------------------------------ dialogs -- */

function TransitionConfirm({ state, fault, readiness, busy, onClose, onConfirm, onReopen }) {
  const [comment, setComment] = useState('');
  useEffect(() => { if (state) setComment(''); }, [state]);
  if (!state) return null;
  const target = state.target;
  const needsComment = target === 'reopen' || ['closed', 'awaiting_parts', 'under_repair'].includes(target);
  const label = target === 'reopen' ? 'reopen' : FAULT_STATUS[target]?.label?.toLowerCase();
  return (
    <Modal
      open
      onClose={onClose}
      title={target === 'reopen' ? 'Reopen this fault report?' : `Move to ${FAULT_STATUS[target]?.label}?`}
      description={target === 'reopen'
        ? 'Reopening is an administrator action: it changes a finished record, so the reason is written into the timeline.'
        : 'This is recorded in the audit trail with your name and the time.'}
      footer={(
        <>
          <Button tone="ghost" onClick={onClose}>Cancel</Button>
          <Button tone={target === 'closed' || target === 'reopen' ? 'danger' : 'primary'} loading={busy}
            disabled={needsComment && comment.trim().length < 3}
            onClick={() => (target === 'reopen' ? onReopen(comment.trim()) : onConfirm(comment.trim() || undefined))}>
            {target === 'reopen' ? 'Reopen the fault' : `Move to ${FAULT_STATUS[target]?.label}`}
          </Button>
        </>
      )}
    >
      {target === 'repaired' && readiness && !readiness.canMarkRepaired ? (
        <Callout tone="warn" title="Not yet">
          The repair record is missing: {readiness.missing.filter((m) => m !== 'repairRecord').map((m) => MISSING_LABEL[m] ?? m).join(', ') || 'the record itself'}.
        </Callout>
      ) : null}
      {target === 'repaired' ? (
        <Callout tone="info" title="Returning this item to service">
          Marking it repaired sets the equipment back to <b>Operational</b>. By confirming this you are stating the equipment has been
          tested and is fit for the department to use.
        </Callout>
      ) : null}
      {target === 'verified' ? (
        <p className="form-note">Verification says someone has checked the fix in real use{fault.reportedBy ? ` — the reporter (${fault.reportedByName}) is usually the right person, and a technician's own verification is also recorded as such` : ''}.</p>
      ) : null}
      <Field label={needsComment ? 'Comment (required)' : 'Comment (optional)'}
        hint={target === 'closed' ? 'What was the outcome? This becomes the resolution note on the record.' : 'Anything the next person should know.'}>
        <TextArea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} autoFocus
          placeholder={target === 'closed' ? 'Verified in use with the lab supervisor; documented in the history.' : target === 'awaiting_parts' ? 'Part ordered from the supplier; expected in 5 working days.' : 'Optional note'} />
      </Field>
    </Modal>
  );
}

function AssignDialog({ open, onClose, fault, onDone }) {
  const toast = useToast();
  const [techId, setTechId] = useState(fault.assignedTo ?? '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const list = useApi(() => users.list({ status: 'active' }), [open]);
  const candidates = (list.data?.items ?? []).filter((u) => ['technician', 'admin'].includes(u.roleCode));

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      await faultsApi.assign(fault.id, Number(techId), note || undefined);
      toast.success('Assigned.');
      onDone();
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={() => !busy && onClose()} title="Assign a technician" description="Assignment is who is responsible for the next step, not blame for the fault."
      footer={<><Button tone="ghost" onClick={onClose}>Cancel</Button><Button tone="primary" disabled={!techId} loading={busy} onClick={submit}>Assign</Button></>}>
      {error ? <Callout tone="bad">{error}</Callout> : null}
      <Field label="Technician" required hint="Only technicians and administrators can be assigned repair work.">
        <Select value={techId} onChange={(e) => setTechId(e.target.value)} placeholder="Choose a technician…"
          options={candidates.map((u) => ({ value: u.id, label: `${u.fullName} — ${u.jobTitle ?? u.roleLabel}` }))} />
      </Field>
      <Field label="Note to the technician"><TextArea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Available this afternoon; the spare probe is in the store." /></Field>
    </Modal>
  );
}

function NoteDialog({ open, onClose, fault, onDone }) {
  const toast = useToast();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async () => {
    setBusy(true); setError(null);
    try { await faultsApi.note(fault.id, comment.trim()); toast.success('Note added to the timeline.'); setComment(''); onDone(); }
    catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={() => !busy && onClose()} title="Add to the timeline" description="A note never changes the status — it adds context that the next person will need."
      footer={<><Button tone="ghost" onClick={onClose}>Cancel</Button><Button tone="primary" disabled={comment.trim().length < 3} loading={busy} onClick={submit}>Add note</Button></>}>
      <Field label="Note" error={error}><TextArea rows={4} value={comment} onChange={(e) => setComment(e.target.value)} autoFocus placeholder="It also happens on a different mains socket, so it is not the room wiring." /></Field>
    </Modal>
  );
}

function EvidenceDialog({ open, onClose, fault, repair, onDone }) {
  const toast = useToast();
  const [files, setFiles] = useState([]);
  const [kind, setKind] = useState(repair ? 'after_photo' : 'photo');
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      if (repair) await faultsApi.uploadRepairPhotos(fault.id, files, kind, caption || undefined);
      else await faultsApi.attach(fault.id, files, kind === 'after_photo' || kind === 'before_photo' ? 'photo' : 'document', caption || undefined);
      toast.success(pluralise(files.length, 'file') + ' attached.');
      setFiles([]);
      onDone();
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={() => !busy && onClose()} title="Attach evidence" description="Photos of the fault, the board before and after, or a signed test sheet."
      footer={<><Button tone="ghost" onClick={onClose}>Cancel</Button><Button tone="primary" disabled={!files.length} loading={busy} onClick={submit}>Attach {files.length ? pluralise(files.length, 'file') : ''}</Button></>}>
      {error ? <Callout tone="bad">{error}</Callout> : null}
      <Field label="What is it?">
        <Select value={kind} onChange={(e) => setKind(e.target.value)} options={[
          { value: 'photo', label: 'Photo of the fault' },
          { value: 'before_photo', label: 'Before the repair' },
          { value: 'after_photo', label: 'After the repair' },
          { value: 'document', label: 'Document (test sheet, PDF)' },
        ]} />
      </Field>
      <FileInput label="Files" kind={kind === 'document' ? 'document' : 'photo'} accept={kind === 'document' ? 'image/*,application/pdf' : 'image/*'} value={files} onChange={setFiles} />
      <Field label="Caption"><TextInput value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="e.g. Corrosion at the mains inlet, before cleaning" /></Field>
    </Modal>
  );
}

function AmendDialog({ open, onClose, fault, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({ title: fault.title, description: fault.description, severity: fault.severity });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});
  useEffect(() => { if (open) setForm({ title: fault.title, description: fault.description, severity: fault.severity }); }, [open, fault.id]);
  const submit = async () => {
    setBusy(true); setErrors({});
    try { await faultsApi.update(fault.id, form); toast.success('Report updated.'); onDone(); }
    catch (err) { setErrors(err.fieldErrors ?? {}); toast.error(errorText(err)); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={() => !busy && onClose()} title="Amend your report" description="Allowed only while nobody has started work on it. The original wording stays in the timeline."
      footer={<><Button tone="ghost" onClick={onClose}>Cancel</Button><Button tone="primary" loading={busy} onClick={submit}>Save changes</Button></>}>
      <Field label="Short summary" error={errors.title?.join?.(' ')}><TextInput value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
      <Field label="What you observed" error={errors.description?.join?.(' ')}><TextArea rows={5} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
      <Field label="Severity" error={errors.severity?.join?.(' ')}>
        <ChoiceChips name="severity" value={form.severity} onChange={(v) => setForm({ ...form, severity: v })} options={Object.entries(SEVERITY).map(([value, m]) => ({ value, label: m.label, tone: m.tone }))} />
      </Field>
    </Modal>
  );
}

/* --------------------------------------------------------- repair record --- */

const EMPTY_REPAIR = {
  diagnosis: '', rootCause: '', troubleshooting: '', repairActions: '', testResults: '',
  calibrationPerformed: false, calibrationDetails: '', labourCost: '', otherCost: '',
  dateRepaired: toDateInput(new Date()), notes: '', safetyCheckConfirmed: false, safeToReturnToService: true, parts: [],
};

function RepairRecordModal({ open, onClose, fault, record, onDone }) {
  const toast = useToast();
  const catalogue = useApi(() => partsApi.list({}), [open]);
  const [form, setForm] = useState(EMPTY_REPAIR);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [showParts, setShowParts] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(record ? {
      diagnosis: record.diagnosis ?? '', rootCause: record.rootCause ?? '', troubleshooting: record.troubleshooting ?? '',
      repairActions: record.repairActions ?? '', testResults: record.testResults ?? '',
      calibrationPerformed: !!record.calibrationPerformed, calibrationDetails: record.calibrationDetails ?? '',
      labourCost: record.labourCost ?? '', otherCost: record.otherCost ?? '', dateRepaired: toDateInput(record.dateRepaired),
      notes: record.notes ?? '', safetyCheckConfirmed: !!record.safetyCheckConfirmed, safeToReturnToService: record.safeToReturnToService !== false,
      parts: (record.parts ?? []).map((p) => ({ partId: p.partId, partName: p.partName, partNumber: p.partNumber, quantity: p.quantity, unitCost: p.unitCost, recovered: !!p.recovered })),
    } : EMPTY_REPAIR);
    setErrors({});
    setShowParts(Boolean(record?.parts?.length));
  }, [open, record]);

  const set = (patch) => { setForm((f) => ({ ...f, ...patch })); setErrors((e) => { const n = { ...e }; for (const k of Object.keys(patch)) delete n[k]; return n; }); };

  const partsCost = useMemo(() => form.parts.reduce((n, p) => n + (Number(p.quantity) || 0) * (Number(p.unitCost) || 0), 0), [form.parts]);
  const total = Math.round((partsCost + (Number(form.labourCost) || 0) + (Number(form.otherCost) || 0)) * 100) / 100;

  const save = async ({ signOff = false } = {}) => {
    setBusy(true); setErrors({});
    const payload = {
      ...form,
      parts: form.parts.map((p) => ({ ...p, quantity: Number(p.quantity) || 1, unitCost: Number(p.unitCost) || 0 })),
      labourCost: Number(form.labourCost) || 0,
      otherCost: Number(form.otherCost) || 0,
      calibrationPerformed: !!form.calibrationPerformed,
      safetyCheckConfirmed: !!form.safetyCheckConfirmed,
      safeToReturnToService: !!form.safeToReturnToService,
    };
    if (signOff) { payload.safetyCheckConfirmed = true; }
    try {
      const saved = await faultsApi.saveRepair(fault.id, payload);
      toast.success(signOff ? 'Repair record saved and signed off.' : 'Repair record saved as a draft.');
      if (saved?.record) onDone();
      else onDone();
    } catch (err) {
      const mapped = {};
      for (const [k, v] of Object.entries(err.fieldErrors ?? {})) mapped[k] = Array.isArray(v) ? v.join(' ') : String(v);
      setErrors(mapped);
      toast.error(errorText(err));
    } finally { setBusy(false); }
  };

  const complete = form.diagnosis.trim().length >= 5 && form.rootCause.trim().length >= 5 && form.repairActions.trim().length >= 5
    && form.testResults.trim().length >= 5 && form.safetyCheckConfirmed;

  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      size="lg"
      title="Repair record"
      description={`For ${fault.reference} · ${fault.equipmentName}. Everything here becomes part of the permanent equipment history.`}
      footer={(
        <>
          <span className="row" style={{ marginRight: 'auto', gap: 6 }}>
            <Badge tone={complete ? 'ok' : 'warn'}>{complete ? 'Ready to sign off' : 'Draft — incomplete'}</Badge>
            {form.parts.length ? <Badge tone="neutral">Parts {formatMoney(partsCost)} · Total {formatMoney(total)}</Badge> : null}
          </span>
          <Button tone="ghost" onClick={onClose} disabled={busy}>Close</Button>
          <Button tone="secondary" loading={busy} onClick={() => save({ signOff: false })}>Save draft</Button>
          <Button tone="primary" loading={busy} disabled={!complete} onClick={() => save({ signOff: true })}>Save &amp; sign off</Button>
        </>
      )}
    >
      <div className="form-grid form-grid--2">
        <Field label="Fault diagnosis" required error={errors.diagnosis} hint="What was actually wrong, as you found it.">
          <TextArea rows={3} value={form.diagnosis} onChange={(e) => set({ diagnosis: e.target.value })} placeholder="e.g. Intermittent break in the patient-lead cable at the strain relief" />
        </Field>
        <Field label="Root cause" required error={errors.rootCause} hint="Why it happened — this is what stops it happening again.">
          <TextArea rows={3} value={form.rootCause} onChange={(e) => set({ rootCause: e.target.value })} placeholder="e.g. Cable repeatedly wrapped tightly around the unit during storage" />
        </Field>
        <Field label="Troubleshooting performed" error={errors.troubleshooting}>
          <TextArea rows={3} value={form.troubleshooting} onChange={(e) => set({ troubleshooting: e.target.value })} placeholder="Tests, measurements and what they ruled out." />
        </Field>
        <Field label="Repair performed" required error={errors.repairActions}>
          <TextArea rows={3} value={form.repairActions} onChange={(e) => set({ repairActions: e.target.value })} placeholder="What you replaced, adjusted, cleaned or re-soldered." />
        </Field>
        <Field label="Test results" required={false} error={errors.testResults} hint="Required before the equipment can be marked repaired. Include real readings, not “works”." >
          <TextArea rows={3} value={form.testResults} onChange={(e) => set({ testResults: e.target.value })} placeholder="e.g. Earth bond 0.11 Ω; leakage 22 µA; 12-lead trace stable over a 2 h wiggle test." />
        </Field>
        <div className="stack" style={{ gap: 'var(--sp-3)' }}>
          <Field label="Date repaired" error={errors.dateRepaired}><TextInput type="date" value={form.dateRepaired} onChange={(e) => set({ dateRepaired: e.target.value })} max={toDateInput(new Date())} /></Field>
          <Field label="Currency"><TextInput value={record?.currency ?? 'USD'} onChange={(e) => set({ currency: e.target.value })} maxLength={3} /></Field>
        </div>
      </div>

      <div className="stack">
        <p className="form-section__title">Parts and costs</p>
        <PartsEditor parts={form.parts} onChange={(parts) => set({ parts })} catalogue={catalogue.data?.items ?? []} open={showParts} onToggle={setShowParts} errors={errors} />
        <div className="form-grid form-grid--2">
          <Field label="Labour cost" error={errors.labourCost} hint="Internal charge or contracted rate. Leave blank if none."><TextInput type="number" min="0" step="0.01" value={form.labourCost} onChange={(e) => set({ labourCost: e.target.value })} /></Field>
          <Field label="Other cost (callout, shipping)" error={errors.otherCost}><TextInput type="number" min="0" step="0.01" value={form.otherCost} onChange={(e) => set({ otherCost: e.target.value })} /></Field>
        </div>
        {form.parts.length || Number(form.labourCost) || Number(form.otherCost) ? (
          <p className="form-note">Total recorded cost: <b>{formatMoney(total, form.currency)}</b> (parts {formatMoney(partsCost)} + labour {formatMoney(Number(form.labourCost) || 0)} + other {formatMoney(Number(form.otherCost) || 0)}). The total is calculated by the server from the part lines.</p>
        ) : null}
      </div>

      <div className="stack">
        <p className="form-section__title">Calibration</p>
        <Checkbox label="Calibration or verification was performed" hint="Leave unchecked if this repair did not touch measurement accuracy." checked={form.calibrationPerformed} onChange={(v) => set({ calibrationPerformed: v })} />
        {form.calibrationPerformed ? (
          <Field label="Calibration details" required error={errors.calibrationDetails} hint="Reference used, deviation measured, and whether a certificate was issued.">
            <TextArea rows={2} value={form.calibrationDetails} onChange={(e) => set({ calibrationDetails: e.target.value })} placeholder="Verified against a calibrated NIBP simulator; deviation ≤2 mmHg across 50–250 mmHg. PM label updated." />
          </Field>
        ) : null}
      </div>

      <div className="stack">
        <p className="form-section__title">Return to service — your professional judgement</p>
        <Checkbox
          label="I have completed the required safety checks on this equipment"
          hint="Required to mark a fault repaired. Record the readings in Test results above."
          checked={form.safetyCheckConfirmed}
          onChange={(v) => set({ safetyCheckConfirmed: v })}
        />
        <Checkbox
          label="This equipment is safe to return to service"
          hint="Uncheck to quarantine it: the fault cannot then be marked repaired, and the item stays out of use."
          checked={form.safeToReturnToService}
          onChange={(v) => set({ safeToReturnToService: v })}
        />
        {!form.safeToReturnToService ? (
          <Callout tone="bad" title="Quarantining this item">
            While this box is unchecked the equipment cannot be returned to service from this report. Use “Awaiting parts”, keep it
            Under Repair, or set it Out of Service with a reason so users know not to touch it.
          </Callout>
        ) : null}
        <Field label="Additional notes" error={errors.notes}>
          <TextArea rows={2} value={form.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="Anything the department or the next technician should know." />
        </Field>
      </div>
    </Modal>
  );
}

function PartsEditor({ parts, onChange, catalogue, open, onToggle, errors }) {
  const add = () => onChange([...parts, { partId: '', partName: '', partNumber: '', quantity: 1, unitCost: '', recovered: false }]);
  const update = (index, patch) => onChange(parts.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  const removeAt = (index) => onChange(parts.filter((_, i) => i !== index));

  const chooseCatalogue = (index, value) => {
    const item = catalogue.find((c) => String(c.id) === String(value));
    update(index, item ? { partId: item.id, partName: item.name, partNumber: item.code, unitCost: item.unitCost } : { partId: '' });
  };

  return (
    <div className="parts-editor">
      <div className="row row--between">
        <p className="form-note">Add each part fitted. Parts not in the catalogue can be typed — they are still recorded on the line.</p>
        <Button size="sm" tone="ghost" onClick={onToggle}>{open ? 'Hide' : 'Show'} part lines</Button>
      </div>
      {open ? (
        <div className="stack" style={{ gap: 'var(--sp-2)' }}>
          {parts.map((p, i) => (
            <div key={i} className="part-line">
              <Select aria-label={`Catalogue part ${i + 1}`} value={p.partId ?? ''} onChange={(e) => chooseCatalogue(i, e.target.value)}
                placeholder="From catalogue…" options={[{ value: '', label: 'Not in catalogue / typed' }, ...catalogue.map((c) => ({ value: c.id, label: `${c.name} (${c.code})` }))]} />
              <TextInput aria-label={`Part name ${i + 1}`} value={p.partName} onChange={(e) => update(i, { partName: e.target.value })} placeholder="Part name" />
              <TextInput aria-label={`Quantity ${i + 1}`} type="number" min="1" className="part-line--qty" value={p.quantity} onChange={(e) => update(i, { quantity: e.target.value })} />
              <TextInput aria-label={`Unit cost ${i + 1}`} type="number" min="0" step="0.01" className="part-line--cost" value={p.unitCost} onChange={(e) => update(i, { unitCost: e.target.value })} placeholder="Unit cost" />
              <span className="part-line--line">{formatMoney((Number(p.quantity) || 0) * (Number(p.unitCost) || 0))}</span>
              <button type="button" className="iconbtn iconbtn--bad" aria-label={`Remove part line ${i + 1}`} onClick={() => removeAt(i)}>✕</button>
            </div>
          ))}
          <div className="row">
            <Button size="sm" tone="secondary" onClick={add}>＋ Add part</Button>
            {parts.length ? <Checkbox label="Keep removed parts for warranty" hint="Marks the old part as recovered rather than thrown away." checked={parts.some((p) => p.recovered)} onChange={(v) => onChange(parts.map((p) => ({ ...p, recovered: v })))} /> : null}
          </div>
        </div>
      ) : null}
      {errors.parts ? <p className="form-error" role="alert">{typeof errors.parts === 'string' ? errors.parts : errors.parts.join(' ')}</p> : null}
    </div>
  );
}
