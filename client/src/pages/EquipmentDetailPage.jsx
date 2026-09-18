import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { attachments, equipment as equipmentApi } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { PageHeader } from '../components/AppShell.jsx';
import { Button, Callout, EmptyState, ErrorState, Field, Loading, Modal, Select, Tabs, TextArea } from '../components/ui.jsx';
import { Badge, Card, DataTable, EquipmentStatusPill, FaultStatusPill, KeyValue, MaintenanceLight, Money, RiskBadge, SeverityPill, Timeline } from '../components/display.jsx';
import { formatDate } from '../utils/format.js';
import { FileInput } from '../components/FileInput.jsx';
import { useToast, errorText } from '../components/Toast.jsx';
import { useApi } from '../utils/useApi.js';
import { formatDateTime, formatHours, pluralise } from '../utils/format.js';
import { useCopy } from '../components/ui.jsx';
import { EQUIPMENT_STATUS, SAFETY_NOTICE } from '../utils/constants.js';

/**
 * The equipment profile — the single page that answers "what is this, is it working, who has
 * it, what has been done to it, when is service due, what is the risk".  It is also the page a
 * QR label lands on.
 */
export function EquipmentDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can, is } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState('overview');
  const [statusOpen, setStatusOpen] = useState(false);
  const [imageOpen, setImageOpen] = useState(false);
  const [imageFiles, setImageFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const copy = useCopy();

  const { data, loading, error, refresh, setData } = useApi(() => equipmentApi.get(id), [id]);
  const eq = data?.equipment;
  const perms = data?.permissions ?? {};

  if (error) return <ErrorState error={error} onRetry={refresh} />;
  if (loading && !eq) return <Loading rows={8} label="Loading the equipment record" />;

  const photo = (data.attachments ?? []).find((a) => a.kind === 'photo');
  const isDecommissioned = eq.status === 'decommissioned';

  const saveImage = async () => {
    if (!imageFiles.length) { toast.warn('Choose a photograph first.'); return; }
    setBusy(true);
    try {
      await equipmentApi.uploadImage(eq.id, imageFiles[0]);
      setImageOpen(false);
      setImageFiles([]);
      toast.success('Photograph updated.');
      refresh();
    } catch (err) { toast.error(errorText(err)); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader
        back={{ to: '/equipment', label: 'All equipment' }}
        eyebrow={eq.categoryName}
        title={eq.name}
        actions={(
          <>
            <Button as={Link} to={`/report/${eq.assetTag}`} tone="danger" disabled={isDecommissioned}>⚑ Report a fault</Button>
            {perms.canSetStatus ? <Button tone="secondary" onClick={() => setStatusOpen(true)}>Change status</Button> : null}
            {can('equipment.qr') ? <Button tone="secondary" onClick={() => setQrOpen(true)}>▣ QR label</Button> : null}
            {perms.canEdit ? <Button as={Link} to={`/equipment/${eq.id}/edit`} tone="ghost">Edit</Button> : null}
          </>
        )}
      />

      <div className="detail-head" style={{ marginBottom: 'var(--sp-5)' }}>
        <div className="grid" style={{ gap: 'var(--sp-3)' }}>
          <div className="row" style={{ gap: 8 }}>
            <EquipmentStatusPill status={eq.status} size="lg" />
            <MaintenanceLight state={eq.maintenanceState} daysUntil={eq.daysUntilPm} size="lg" />
            {eq.openFaultCount > 0 ? <Badge tone="bad" size="lg">⚑ {pluralise(eq.openFaultCount, 'open fault report')}</Badge> : null}
            {eq.isAvailable ? <Badge tone="ok" size="lg">Available for use</Badge> : null}
            {eq.criticality === 'life_support' ? <Badge tone="bad" size="lg">Life-support class</Badge> : null}
          </div>
          <p className="asset-tag" title="Asset tag — printed on the QR label">{eq.assetTag}</p>
          {!eq.isAvailable ? (
            <Callout tone="warn">
              <span className="callout__icon" aria-hidden="true">⚠</span>
              <div className="callout__main">
                <p className="callout__title">{EQUIPMENT_STATUS[eq.status]?.hint ?? 'This item is not currently available'}</p>
                <p className="callout__body">Do not put it back into teaching or clinical use without the technician sign-off recorded in this file.</p>
              </div>
            </Callout>
          ) : null}
        </div>
        <div style={{ width: 'min(100%, 300px)' }}>
          {photo ? (
            <figure style={{ margin: 0, display: 'grid', gap: 6 }}>
              <img className="eq-photo" src={attachments.viewUrl(photo.id)} alt={`${eq.name} — ${photo.filename}`} />
              <figcaption className="cell-sub">Photograph on file · {formatDate(photo.createdAt)}</figcaption>
            </figure>
          ) : (
            <div className="eq-photo--empty">
              {perms.canEdit ? <><p>No photograph on file</p><Button size="sm" tone="secondary" onClick={() => setImageOpen(true)}>Add one</Button></> : 'No photograph on file'}
            </div>
          )}
          {perms.canEdit && photo ? <Button size="sm" tone="ghost" onClick={() => setImageOpen(true)}>Replace photograph</Button> : null}
        </div>
      </div>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'faults', label: 'Faults', count: data.faults.length },
          { id: 'maintenance', label: 'Maintenance', count: (data.maintenance?.length ?? 0) + (data.schedules?.length ?? 0) },
          { id: 'repairs', label: 'Repairs', count: data.repairs?.length ?? 0 },
          { id: 'risk', label: 'Risk', count: data.risk ? `${data.risk.score}` : null },
          { id: 'files', label: 'Files & label', count: data.attachments.length },
        ]}
      />

      <div className="tabpanel">
        {tab === 'overview' ? (
          <div className="grid" style={{ gap: 'var(--sp-4)' }}>
            <Card title="Identification and ownership">
              <KeyValue
                items={[
                  ['Asset tag', <code>{eq.assetTag}</code>],
                  ['Name', eq.name],
                  ['Category', eq.categoryName],
                  ['Manufacturer', eq.manufacturer],
                  ['Model', eq.model],
                  ['Serial number', <code>{eq.serialNumber}</code>],
                  ['Department', eq.department],
                  ['Location', eq.locationLabel ?? eq.locationName],
                  ['Responsible person', eq.custodianName ?? eq.custodianNote],
                  ['Responsible technician', eq.responsibleTechnicianName],
                  ['Acquired', eq.acquiredOn ? `${formatDate(eq.acquiredOn)}${eq.ageYears ? ` (${eq.ageYears} years old)` : ''}` : null],
                  ['Warranty', eq.warrantyExpiresOn
                    ? <span>{formatDate(eq.warrantyExpiresOn)} {eq.warrantyExpiresOn < new Date().toISOString().slice(0, 10) ? <Badge tone="neutral" size="sm">expired</Badge> : <Badge tone="ok" size="sm">in warranty</Badge>} {eq.warrantyProvider ? <span className="muted"> · {eq.warrantyProvider}</span> : null}</span>
                    : null],
                  ['Criticality', eq.criticality],
                  ['Notes', eq.notes],
                ]}
              />
            </Card>

            <div className="grid grid--2">
              <Card title="At a glance">
                <KeyValue columns={1} items={[
                  ['Fault reports (all time)', eq.totalFaults],
                  ['Open now', eq.openFaultCount],
                  ['Critical open', eq.criticalFaultCount],
                  ['Repairs recorded', eq.repairCount],
                  ['Preventive visits', eq.pmRecordCount],
                  ['Average time to repair', formatHours(data.statistics?.averageRepairHours)],
                  ['Lifetime repair cost', eq.lifetimeRepairCost !== null ? <Money amount={eq.lifetimeRepairCost} /> : <span className="muted">Not shown for your role</span>],
                  ['Availability (180 d)', data.downtime?.availabilityPercent != null ? `${data.downtime.availabilityPercent}%` : '—'],
                  ['Downtime (180 d)', data.downtime ? `${data.downtime.days} days over ${pluralise(data.downtime.incidents, 'incident')}` : '—'],
                ]} />
              </Card>
              <Card title="Status trail" subtitle="How this item reached its current state">
                <Timeline items={(data.statusHistory ?? []).slice(0, 8).map((h) => ({
                  id: `${h.changedAt}-${h.toStatus}`,
                  title: h.fromStatus ? `${h.fromStatus.replace(/_/g, ' ')} → ${h.toStatus.replace(/_/g, ' ')}` : `Set to ${h.toStatus.replace(/_/g, ' ')}`,
                  detail: h.reason,
                  actor: h.changedByName,
                  meta: h.faultReference ? <Link to={`/faults/${h.faultId}`}>{h.faultReference}</Link> : null,
                  at: h.changedAt,
                  tone: h.toStatus === 'operational' ? 'ok' : h.toStatus === 'out_of_service' ? 'bad' : 'warn',
                }))} />
                {!(data.statusHistory ?? []).length ? <p className="form-note">No status changes recorded yet.</p> : null}
              </Card>
            </div>
          </div>
        ) : null}

        {tab === 'faults' ? (
          <Card title="Fault reports on this item" subtitle="Newest first — open reports are being handled" pad={false}>
            <DataTable
              rows={data.faults}
              empty={<EmptyBlock title="No fault reports recorded" text="That is either good equipment or unreported problems. Encourage reporting: a log with nothing in it helps nobody." />}
              onRowClick={(r) => navigate(`/faults/${r.id}`)}
              columns={[
                { key: 'reference', label: 'Reference', mono: true, render: (r) => <><code>{r.reference}</code><div className="cell-sub">{formatDateTime(r.createdAt)}</div></> },
                { key: 'title', label: 'Title', render: (r) => <div className="cell-main"><span className="cell-title">{r.title}</span><span className="cell-sub">{r.categoryName} · {r.reportedByName}</span></div> },
                { key: 'severity', label: 'Severity', render: (r) => <SeverityPill severity={r.severity} /> },
                { key: 'status', label: 'Status', render: (r) => <FaultStatusPill status={r.status} /> },
                { key: 'assignedToName', label: 'Assigned', render: (r) => r.assignedToName ?? <span className="muted">Unassigned</span> },
                { key: 'open', label: '', render: (r) => (OPEN.includes(r.status) ? <Badge tone="warn" size="sm">open</Badge> : null) },
              ]}
            />
          </Card>
        ) : null}

        {tab === 'maintenance' ? (
          <div className="grid" style={{ gap: 'var(--sp-4)' }}>
            <Card title="Preventive maintenance schedules" actions={perms.canConfigureMaintenance ? <Button size="sm" as={Link} to={`/maintenance?equipment=${eq.id}`}>Manage schedules</Button> : null} pad={false}>
              <DataTable
                rows={data.schedules ?? []}
                empty={<EmptyBlock title="No schedule configured" text="Without one, this item never appears on the due board — which is how equipment quietly becomes unserviceable." />}
                columns={[
                  { key: 'title', label: 'Schedule' },
                  { key: 'intervalDays', label: 'Interval', align: 'center', render: (r) => `${r.intervalDays} days` },
                  { key: 'lastDoneOn', label: 'Last done', render: (r) => formatDate(r.lastDoneOn) },
                  { key: 'nextDueOn', label: 'Next due', render: (r) => <span>{formatDate(r.nextDueOn)} <MaintenanceLight state={r.maintenanceState} /></span> },
                  { key: 'checklistCount', label: 'Checks', align: 'center' },
                  { key: 'responsibleTechnicianName', label: 'Owner', render: (r) => r.responsibleTechnicianName ?? <span className="muted">Unassigned</span> },
                ]}
              />
            </Card>
            <Card title="Maintenance history" pad={false}>
              <DataTable
                rows={data.maintenance ?? []}
                empty={<EmptyBlock title="No preventive maintenance recorded" text="First visit will appear here once a technician signs it off." />}
                columns={[
                  { key: 'reference', label: 'Reference', mono: true },
                  { key: 'performedOn', label: 'Date', render: (r) => formatDate(r.performedOn) },
                  { key: 'conditionFound', label: 'Condition', render: (r) => <Badge tone={r.conditionFound === 'pass' ? 'ok' : r.conditionFound ? 'warn' : 'neutral'}>{(r.conditionFound ?? '—').replace(/_/g, ' ')}</Badge> },
                  { key: 'findings', label: 'Findings' },
                  { key: 'durationMinutes', label: 'Time', align: 'right', render: (r) => (r.durationMinutes ? `${r.durationMinutes} min` : '—') },
                  { key: 'performedByName', label: 'By' },
                ]}
              />
            </Card>
          </div>
        ) : null}

        {tab === 'repairs' ? (
          <Card title="Repair records" subtitle="What was found, done and proven — recorded and signed by a technician" pad={false}>
            {data.repairs?.length ? (
              <div className="stack" style={{ padding: 'var(--sp-4)' }}>
                {data.repairs.map((r) => (
                  <div key={r.id} className="repair-card">
                    <div className="row row--between">
                      <div>
                        <p className="cell-title">{r.diagnosis}</p>
                        <p className="cell-sub">{r.reference} · {formatDate(r.dateRepaired)} · {r.technicianName}{r.faultReference ? <> · <Link to={`/faults/${r.faultId ?? ''}`}>{r.faultReference}</Link></> : null}</p>
                      </div>
                      <Money amount={r.totalCost} currency={r.currency} />
                    </div>
                    <KeyValue columns={2} items={[
                      ['Root cause', r.rootCause],
                      ['Repair performed', r.repairActions],
                      ['Parts replaced', r.partsReplacedSummary ?? (r.parts?.length ? r.parts.map((p) => `${p.quantity} × ${p.partName}`).join(', ') : null)],
                      ['Test results', r.testResults],
                      ['Calibration', r.calibrationPerformed ? r.calibrationDetails ?? 'performed' : null],
                      ['Safe to return to service', r.safeToReturnToService ? <Badge tone="ok">yes</Badge> : <Badge tone="bad">no</Badge>],
                    ]} />
                  </div>
                ))}
              </div>
            ) : <EmptyBlock title="No repairs recorded" text="Repairs appear here as soon as a technician files them against a fault report." />}
          </Card>
        ) : null}

        {tab === 'risk' ? (
          <Card>
            {data.risk ? <RiskPanel risk={data.risk} /> : <p className="form-note">No risk assessment available.</p>}
          </Card>
        ) : null}

        {tab === 'files' ? (
          <div className="grid grid--2">
            <Card title="Attachments" pad={false}>
              {data.attachments.length ? (
                <ul className="attach-grid" style={{ padding: 'var(--sp-4)' }}>
                  {data.attachments.map((a) => (
                    <li key={a.id} className="attach">
                      {a.mimeType.startsWith('image/')
                        ? <img className="attach__img" src={attachments.viewUrl(a.id)} alt={a.caption ?? a.filename} />
                        : <a className="attach__doc" href={attachments.viewUrl(a.id)} target="_blank" rel="noreferrer">{a.mimeType.includes('pdf') ? '📄 PDF' : '📄 file'}</a>}
                      <div className="attach__meta">
                        <span className="attach__name" title={a.filename}>{a.filename}</span>
                        <span>{a.kind.replace(/_/g, ' ')} · {formatDate(a.createdAt)} · {a.uploadedByName ?? ''}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : <EmptyBlock title="No files attached" text="Manuals, calibration certificates and photographs can be attached here." />}
            </Card>
            <Card title="QR label" subtitle="Scan-to-report identity for this item">
              <div className="qr-box">
                <img className="qr-box__img" src={equipmentApi.qrUrl(eq.id)} alt={`QR code linking to the profile of ${eq.assetTag}`} />
                <p className="qr-box__tag">{eq.assetTag}</p>
                <p className="qr-box__note">Anyone who scans this opens this equipment’s status and a fault-report form. Keep the printed tag legible; laminate for clinical areas.</p>
                <div className="row" style={{ justifyContent: 'center' }}>
                  <Button tone="secondary" size="sm" onClick={() => window.print()}>🖨 Print label</Button>
                  <Button tone="ghost" size="sm" onClick={() => { copy.copy(data?.qr?.url ?? `${window.location.origin}/e/${eq.assetTag}`); toast.success('Profile link copied.'); }}>Copy link</Button>
                </div>
              </div>
            </Card>
          </div>
        ) : null}
      </div>

      <StatusDialog open={statusOpen} onClose={() => setStatusOpen(false)} equipment={eq} onSaved={async () => { setStatusOpen(false); await refresh(); }} />

      <Modal open={imageOpen} onClose={() => setImageOpen(false)} title="Equipment photograph" description="A clear photo of the front panel helps identification and shows existing damage.">
        <FileInput label="Photograph" kind="photo" maxFiles={1} value={imageFiles} onChange={setImageFiles} />
        <p className="form-note">Photos may contain location metadata from the camera. They are only visible to people who can open this equipment record.</p>
        <div className="row row--end" style={{ marginTop: 8 }}>
          <Button tone="ghost" onClick={() => setImageOpen(false)}>Cancel</Button>
          <Button tone="primary" loading={busy} onClick={saveImage}>Save photograph</Button>
        </div>
      </Modal>

      <Modal open={qrOpen} onClose={() => setQrOpen(false)} title={`QR label · ${eq.assetTag}`} description="Print at 100% scale on adhesive stock. The code opens this item’s status and fault-report form.">
        <div className="qr-box">
          <img className="qr-box__img" src={equipmentApi.qrUrl(eq.id)} alt="QR code for this equipment" />
          <p className="qr-box__tag">{eq.assetTag}</p>
          <p className="qr-box__note">{eq.name}</p>
          <p className="qr-box__note mono">{data.qr?.url}</p>
          <div className="row" style={{ justifyContent: 'center' }}>
            <Button tone="primary" onClick={() => window.print()}>🖨 Print</Button>
            <a className="btn btn--secondary" href={equipmentApi.qrUrl(eq.id, 'svg')} download={`${eq.assetTag}-qr.svg`}>Download SVG</a>
          </div>
        </div>
      </Modal>
    </>
  );
}

const OPEN = ['reported', 'assigned', 'acknowledged', 'under_inspection', 'under_repair', 'awaiting_parts'];

function EmptyBlock({ title, text }) {
  return <div style={{ padding: 'var(--sp-4)' }}><EmptyState icon="📄" title={title} description={text} /></div>;
}

function RiskPanel({ risk }) {
  const navigate = useNavigate();
  return (
    <div className="stack">
      <div className="row row--between">
        <RiskBadge level={risk.level} score={risk.score} size="lg" />
        <Badge tone="neutral">{risk.modelVersion}</Badge>
      </div>
      <Callout tone="safety" title="Decision support, not a verdict">
        {risk.disclaimer}
      </Callout>
      <p className="form-note">
        Score <b>{risk.rawScore}/{risk.rawMax}</b> raw → <b>{risk.score}/100</b>.
        Every point below comes from a row in this department’s own history — open the record it points at to check it.
      </p>
      <div>
        {risk.factors.map((f) => (
          <div key={f.key} className="factor">
            <div className="factor__head">
              <p className="factor__label">{f.label}</p>
              <p className="factor__points">{f.points} / {f.maxPoints} points</p>
            </div>
            <div className="pbar" style={{ marginBottom: 6 }}>
              <div className="pbar__track" style={{ height: 6 }}>
                <div className={`pbar__fill ${f.points > f.maxPoints * 0.6 ? 'pbar__fill--bad' : f.points > 0 ? 'pbar__fill--warn' : 'pbar__fill--ok'}`} style={{ width: `${Math.min(100, (f.points / f.maxPoints) * 100)}%` }} />
              </div>
            </div>
            <p className="factor__basis">{f.basis}</p>
            <ul className="factor__list">{(f.contributing ?? []).map((c, i) => <li key={i}><span>{c}</span></li>)}</ul>
            {f.advice ? <p className="factor__advice">→ {f.advice}</p> : null}
          </div>
        ))}
      </div>
      {risk.escalation ? (
        <Callout tone="warn" title="Escalated to High">
          {risk.escalation.rule}. {risk.escalation.reason}
        </Callout>
      ) : null}
      <details className="factor__details">
        <summary>Inputs used</summary>
        <KeyValue columns={2} items={Object.entries(risk.inputSnapshot ?? {}).map(([k, v]) => [k.replace(/([A-Z])/g, ' $1').toLowerCase(), v ?? '—'])} />
      </details>
      <p className="chart__foot">{SAFETY_NOTICE}</p>
    </div>
  );
}

function StatusDialog({ open, onClose, equipment, onSaved }) {
  const [status, setStatus] = useState(equipment?.status ?? 'operational');
  // Reset when the dialog is reopened for a different item.
  useEffect(() => { if (open) { setStatus(equipment?.status ?? 'operational'); setReason(''); setFormError(null); } }, [open, equipment?.id, equipment?.status]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState(null);
  const needsReason = ['out_of_service', 'decommissioned'].includes(status);
  const options = useMemo(() => Object.entries(EQUIPMENT_STATUS).map(([value, meta]) => ({ value, label: meta.label })), []);

  const submit = async () => {
    setBusy(true);
    setFormError(null);
    try {
      await equipmentApi.setStatus(equipment.id, status, reason || undefined);
      await onSaved();
      toast.success(`${equipment.assetTag} is now ${EQUIPMENT_STATUS[status].label.toLowerCase()}.`);
    } catch (err) { setFormError(errorText(err)); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title="Change equipment status" description="Official status is a statement to the whole department, so it is recorded with who set it and why."
      footer={<><Button tone="ghost" onClick={onClose}>Cancel</Button><Button tone="primary" loading={busy} disabled={needsReason && !reason.trim()} onClick={submit}>Save status</Button></>}>
      <Field label="Status">
        <Select value={status} onChange={(e) => setStatus(e.target.value)} options={options} />
      </Field>
      <Field label={needsReason ? 'Reason (required)' : 'Reason (optional)'} hint={status === 'operational' ? 'Equipment with an unresolved fault report cannot be returned to service — move the report forward first.' : 'What changed, and on whose instruction?'}>
        <TextArea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      {formError ? <p className="form-error" role="alert">{formError}</p> : null}
    </Modal>
  );
}
