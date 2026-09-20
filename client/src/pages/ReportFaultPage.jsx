import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { equipment as equipmentApi, faults as faultsApi, reference } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { PageHeader } from '../components/AppShell.jsx';
import { Button, Callout, ChoiceChips, Field, Loading, Modal, Select, TextArea, TextInput } from '../components/ui.jsx';
import { Badge, Card, EquipmentStatusPill, MaintenanceLight } from '../components/display.jsx';
import { FileInput } from '../components/FileInput.jsx';
import { QrScanner } from '../components/QrScanner.jsx';
import { useToast, errorText } from '../components/Toast.jsx';
import { useApi } from '../utils/useApi.js';
import { SEVERITY } from '../utils/constants.js';
import { toDateTimeLocal } from '../utils/format.js';

/**
 * Fault reporting (Phase 4) — designed for a phone in a lab, in a hurry.
 * One screen, six decisions, no jargon, and a confirmation that tells the reporter what
 * happens next and how to find this report later.  Everything that can be derived
 * (location, equipment) is derived; everything that must be a human judgement is asked.
 */
export function ReportFaultPage() {
  const { tag } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { user, is } = useAuth();
  const [picked, setPicked] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [errors, setErrors] = useState({});
  const [form, setForm] = useState({
    categoryCode: '', severity: 'medium', title: '', description: '',
    observedAt: toDateTimeLocal(new Date()), locationId: '', onBehalfOf: '', photos: [],
  });

  const vocab = useApi(() => faultsApi.vocabulary(), []);
  const picklists = useApi(() => reference.picklists(), []);

  useEffect(() => {
    if (!tag) return;
    equipmentApi.get(tag)
      .then((r) => { setPicked(r.equipment); setForm((f) => ({ ...f, locationId: f.locationId || r.equipment.locationId || '' })); })
      .catch((err) => toast.error(errorText(err)));
  }, [tag, toast]);

  const set = (patch) => { setForm((f) => ({ ...f, ...patch })); setErrors((e) => { const n = { ...e }; for (const k of Object.keys(patch)) delete n[k]; return n; }); };

  const validate = () => {
    const p = {};
    if (!picked) p.equipment = 'Choose which equipment is faulty.';
    if (!form.categoryCode) p.categoryCode = 'Pick the closest category — “Unknown / other” is a valid answer.';
    if (!form.title.trim() || form.title.trim().length < 4) p.title = 'Give it a short summary a technician will recognise (at least 4 characters).';
    if (form.description.trim().length < 10) p.description = 'Describe what you see in a little more detail — what happens, when, and how often.';
    if (form.description.length > 4000) p.description = 'Please keep the description under 4000 characters.';
    return p;
  };

  const submit = async (event) => {
    event.preventDefault();
    const problems = validate();
    if (Object.keys(problems).length) {
      setErrors(problems);
      const el = document.querySelector('.field--error input, .field--error textarea, .field--error select');
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el?.focus();
      return;
    }
    const fd = new FormData();
    fd.append('equipmentId', String(picked.id));
    fd.append('categoryCode', form.categoryCode);
    fd.append('severity', form.severity);
    fd.append('title', form.title.trim());
    fd.append('description', form.description.trim());
    if (form.observedAt) fd.append('observedAt', new Date(form.observedAt).toISOString().slice(0, 19) + 'Z');
    if (form.locationId) fd.append('locationId', String(form.locationId));
    if (form.onBehalfOf.trim()) fd.append('onBehalfOf', form.onBehalfOf.trim());
    for (const file of form.photos) fd.append('files', file);

    setSubmitting(true);
    try {
      const created = await faultsApi.create(fd);
      setResult(created);
      toast.success(`Fault ${created.fault.reference} filed.`);
    } catch (err) {
      setErrors(mapErrors(err));
      toast.error(errorText(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (result) {
    const f = result.fault;
    return (
      <div className="stack" style={{ maxWidth: 640, marginInline: 'auto' }}>
        <div className="report-summary">
          <p className="page-head__eyebrow" style={{ margin: 0 }}>Report received</p>
          <h1 style={{ fontSize: '1.2rem' }}>Thank you — this is now in the workshop queue</h1>
          <p className="report-summary__ref">{f.reference}</p>
          <p className="form-note">
            <b>{result.equipment.name}</b> ({result.equipment.assetTag}) is recorded as <EquipmentStatusPill status={result.equipment.status} size="sm" />.
            Keep it switched off and, if it is unsafe rather than merely faulty, tell the department desk as well.
          </p>
        </div>

        <Card title="What happens next">
          <ol className="steps">
            <li>An administrator or the responsible technician is told {f.severity === 'critical' ? 'immediately — a critical report reaches the whole technical team at once' : 'within the response target'}.</li>
            <li>A technician inspects it. You will get a notification when the status changes.</li>
            {f.dueAt ? <li>The department aims to respond by <b>{new Date(f.dueAt).toLocaleString()}</b> for a {f.severity} report.</li> : null}
            <li>When it is fixed you will be asked to confirm it works before the report is closed — that last check matters, because you are the person who uses it.</li>
          </ol>
        </Card>

        <div className="row">
          <Button as={Link} to={`/faults/${f.id}`} tone="primary">Track this report</Button>
          <Button as={Link} to="/my-reports" tone="secondary">All my reports</Button>
          <Button tone="ghost" onClick={() => { setResult(null); setForm({ ...form, title: '', description: '', photos: [], categoryCode: '', severity: 'medium' }); setPicked(null); navigate('/faults/new', { replace: true }); }}>
            Report another fault
          </Button>
        </div>
        <Callout tone="safety">
          This system records faults and maintenance for the department. It does not assess whether equipment is safe for a patient or a
          practical session — that judgement stays with the technician and the department.
        </Callout>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        back={{ to: picked ? `/equipment/${picked.id}` : '/equipment', label: picked ? 'Back to the equipment' : 'All equipment' }}
        eyebrow="Fault report"
        title={picked ? `Report a fault · ${picked.name}` : 'Report a fault'}
        description="A written report is what stops a fault being forgotten. Say what you see, not what you think is broken — that part is the technician's job."
        actions={<Button tone="secondary" icon="▣" onClick={() => setScanOpen(true)}>Scan label</Button>}
      />

      <form className="report-form" onSubmit={submit} noValidate>
        <Card title="1 · Which equipment" required>
          {picked ? (
            <div className="row row--between">
              <div>
                <p className="cell-title">{picked.name}</p>
                <p className="cell-sub">{picked.assetTag}{picked.locationLabel ? ` · ${picked.locationLabel}` : ''}</p>
                <div className="row row--tight" style={{ marginTop: 6 }}>
                  <EquipmentStatusPill status={picked.status} />
                  <MaintenanceLight state={picked.maintenanceState} daysUntil={picked.daysUntilPm} />
                  {picked.openFaultCount > 0 ? <Badge tone="warn">Already {picked.openFaultCount} open report{picked.openFaultCount > 1 ? 's' : ''}</Badge> : null}
                </div>
              </div>
              <div className="row row--tight">
                <Button size="sm" tone="ghost" onClick={() => setPickerOpen(true)}>Change</Button>
              </div>
            </div>
          ) : (
            <div className="row">
              <Button tone="primary" onClick={() => setPickerOpen(true)}>Choose equipment…</Button>
              <Button tone="secondary" onClick={() => setScanOpen(true)}>Scan the QR label</Button>
              {errors.equipment ? <p className="form-error" role="alert">{errors.equipment}</p> : null}
            </div>
          )}
          {picked?.openFaultCount > 0 ? (
            <Callout tone="warn" title="There is already an open report on this item">
              Someone has already reported a problem ({picked.openFaultReference}). If yours is the same issue, please add to that
              report instead of creating a duplicate — {`<`}a duplicate splits the technician's attention{`>`}. Only continue if this
              is a different or worse problem.
            </Callout>
          ) : null}
        </Card>

        <Card title="2 · What kind of problem" required>
          <ChoiceChips
            name="categoryCode"
            ariaLabel="Fault category"
            value={form.categoryCode}
            onChange={(v) => set({ categoryCode: v })}
            size="lg"
            options={(vocab.data?.categories ?? []).map((c) => ({ value: c.code, label: c.name, hint: c.description }))}
          />
          {vocab.loading ? <Loading rows={2} label="Loading categories" /> : null}
          {errors.categoryCode ? <p className="form-error" role="alert">{errors.categoryCode}</p> : null}
          <p className="form-note">If nothing fits, choose <b>Unknown / other</b>. Guessing a category is worse than not knowing one.</p>
        </Card>

        <Card title="3 · How bad is it" required subtitle="Choose by how it affects use — you are not being asked to judge the technical cause.">
          <ChoiceChips
            name="severity"
            ariaLabel="Severity"
            value={form.severity}
            onChange={(v) => set({ severity: v })}
            size="lg"
            options={Object.entries(SEVERITY).map(([value, meta]) => ({ value, label: meta.label, hint: meta.hint, tone: meta.tone }))}
          />
          {form.severity === 'critical' ? (
            <Callout tone="bad" title="Critical means stop using it now">
              Use this only when the equipment is unsafe or a safety function has failed. A critical report pages the technical team
              immediately. If anyone could be harmed by using it, also tell the department desk in person.
            </Callout>
          ) : null}
        </Card>

        <Card title="4 · What you observed" required>
          <div className="form-grid">
            <Field label="Short summary" required error={errors.title} hint="One line the workshop board will show.">
              <TextInput value={form.title} onChange={(e) => set({ title: e.target.value })} maxLength={160} placeholder="e.g. Left channel has no trace with known-good electrodes" />
            </Field>
            <Field label="What happens, when, and how often" required error={errors.description}
              hint="Include what you already checked (cable seated? other electrodes? another socket?) and whether it is intermittent or constant."
              counter={{ text: `${form.description.length}/4000`, over: form.description.length > 4000 }}>
              <TextArea rows={6} value={form.description} onChange={(e) => set({ description: e.target.value })}
                placeholder="The unit powers on and the display works, but after about two minutes all channels flatline and it needs a power cycle. Happened three times in this morning's class." />
            </Field>
            <div className="form-grid form-grid--2">
              <Field label="When did you first notice it" error={errors.observedAt} hint="Defaults to now.">
                <TextInput type="datetime-local" value={form.observedAt} onChange={(e) => set({ observedAt: e.target.value })} max={toDateTimeLocal(new Date())} />
              </Field>
              <Field label="Location" error={errors.locationId} hint="Prefilled from the equipment record; change it if it has moved.">
                <Select value={form.locationId} onChange={(e) => set({ locationId: e.target.value })} placeholder="Same as the record"
                  options={(picklists.data?.locations ?? []).map((l) => ({ value: l.id, label: l.name }))} />
              </Field>
            </div>
            {is('technician') || is('admin') ? (
              <Field label="Reporting on behalf of" error={errors.onBehalfOf} hint="Optional — a student or a ward, when you are logging it for them.">
                <TextInput value={form.onBehalfOf} onChange={(e) => set({ onBehalfOf: e.target.value })} placeholder="e.g. Year 2 physiology group" />
              </Field>
            ) : null}
          </div>
        </Card>

        <Card title="5 · Photographs (strongly recommended)" subtitle="A photo of a display, error code or damaged cable often saves a whole day.">
          <FileInput
            label="Evidence"
            kind="photo"
            capture="environment"
            maxFiles={vocab.data ? 5 : 5}
            maxSizeMb={8}
            value={form.photos}
            onChange={(files) => set({ photos: files })}
            error={errors.files}
          />
        </Card>

        <div className="row row--between">
          <p className="form-note">Filed as <b>{user?.fullName}</b>{user?.department ? ` · ${user.department}` : ''}. The technician can contact you through this report.</p>
          <Button type="submit" size="lg" tone="danger" loading={submitting}>{submitting ? 'Filing…' : 'Submit fault report'}</Button>
        </div>
      </form>

      <EquipmentPicker open={pickerOpen} onClose={() => setPickerOpen(false)} onPick={(e) => { setPicked(e); setPickerOpen(false); }} />
      <QrScanner open={scanOpen} onClose={() => setScanOpen(false)} onFound={(t) => navigate(`/report/${encodeURIComponent(t)}`, { replace: true })} title="Scan the equipment label" />
    </>
  );
}

function EquipmentPicker({ open, onClose, onPick }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    setLoading(true);
    const t = setTimeout(() => {
      equipmentApi.list({ q, perPage: 20, needsAttention: '' })
        .then((r) => { if (alive) setRows(r.items ?? []); })
        .catch(() => {})
        .finally(() => { if (alive) setLoading(false); });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [open, q]);

  return (
    <Modal open={open} onClose={onClose} title="Which equipment is faulty?" description="Search by name, asset tag, serial or room — or scan the label.">
      <Field label="Search">
        <TextInput autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. centrifuge, BMU-CEN-0002, lab 2" aria-label="Search equipment" />
      </Field>
      {loading ? <Loading rows={4} label="Searching" /> : (
        <ul className="cardlist">
          {rows.map((r) => (
            <li key={r.id}>
              <button type="button" className="listrow listrow--link" style={{ width: '100%', border: '1px solid var(--line)', borderRadius: 'var(--radius)', background: 'var(--surface)', cursor: 'pointer', font: 'inherit', textAlign: 'left' }} onClick={() => onPick(r)}>
                <span className="listrow__main">
                  <span className="listrow__title">{r.name}</span>
                  <span className="listrow__sub">{r.assetTag} · {r.locationLabel ?? 'location not recorded'}</span>
                </span>
                <span className="listrow__side"><EquipmentStatusPill status={r.status} size="sm" /></span>
              </button>
            </li>
          ))}
          {!rows.length && <li><p className="form-note">Nothing found{q ? ` for “${q}”` : ''}. Try a shorter word, or the asset tag printed under the QR code.</p></li>}
        </ul>
      )}
    </Modal>
  );
}

function mapErrors(err) {
  const map = { category_id: 'categoryCode', equipment_id: 'equipment', observed_at: 'observedAt', location_id: 'locationId', on_behalf_of: 'onBehalfOf' };
  const out = {};
  for (const [k, v] of Object.entries(err?.fieldErrors ?? {})) out[map[k] ?? k] = Array.isArray(v) ? v.join(' ') : String(v);
  if (err?.details?.files) out.files = 'One or more files were rejected.';
  return out;
}
