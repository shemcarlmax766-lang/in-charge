import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { equipment as equipmentApi, reference } from '../api/client.js';
import { PageHeader } from '../components/AppShell.jsx';
import { Button, Callout, ErrorState, Field, Loading, Select, TextArea, TextInput, ConfirmDialog } from '../components/ui.jsx';
import { Card } from '../components/display.jsx';
import { useToast, errorText } from '../components/Toast.jsx';
import { useApi } from '../utils/useApi.js';
import { toDateInput } from '../utils/format.js';

/**
 * Create / edit an equipment record.  Field limits mirror the database CHECK constraints
 * exactly, so the form and the server can never disagree about what is acceptable.
 */
const LIMITS = {
  name: 160, manufacturer: 120, model: 120, serialNumber: 80, department: 120,
  custodianNote: 160, warrantyProvider: 120, notes: 2000,
};

export function EquipmentFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const isEdit = Boolean(id);
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const picklists = useApi(() => reference.picklists(), []);
  const existing = useApi(() => (isEdit ? equipmentApi.get(id) : Promise.resolve(null)), [id]);
  const technicians = picklists.data?.technicians ?? [];
  const custodians = picklists.data?.custodians ?? [];

  useEffect(() => {
    if (isEdit) {
      if (!existing.data) return;
      const e = existing.data.equipment;
      setForm({
        name: e.name ?? '', categoryId: e.categoryId ?? '', manufacturer: e.manufacturer ?? '', model: e.model ?? '',
        serialNumber: e.serialNumber ?? '', department: e.department ?? '', locationId: e.locationId ?? '',
        custodianUserId: e.custodianUserId ?? '', custodianNote: e.custodianNote ?? '',
        acquiredOn: toDateInput(e.acquiredOn), warrantyProvider: e.warrantyProvider ?? '', warrantyExpiresOn: toDateInput(e.warrantyExpiresOn),
        criticality: e.criticality ?? 'medium', notes: e.notes ?? '',
        maintenanceIntervalDays: e.maintenanceIntervalDays ?? '', lastMaintenanceOn: toDateInput(e.lastMaintenanceOn),
        responsibleTechnicianId: e.responsibleTechnicianId ?? '',
      });
    } else {
      setForm({
        name: '', categoryId: '', manufacturer: '', model: '', serialNumber: '', department: 'Biomedical Engineering',
        locationId: '', custodianUserId: '', custodianNote: '', acquiredOn: '', warrantyProvider: '', warrantyExpiresOn: '',
        criticality: 'medium', notes: '', maintenanceIntervalDays: '180', lastMaintenanceOn: '', responsibleTechnicianId: '',
      });
    }
  }, [isEdit, existing.data]);

  const set = (patch) => { setForm((f) => ({ ...f, ...patch })); setErrors((e) => { const n = { ...e }; for (const k of Object.keys(patch)) delete n[k]; return n; }); };

  const validate = () => {
    const problems = {};
    if (!form.name?.trim() || form.name.trim().length < 2) problems.name = 'Enter the equipment name (at least 2 characters).';
    if (!form.categoryId) problems.categoryId = 'Choose a category.';
    if (form.serialNumber && form.serialNumber.length > LIMITS.serialNumber) problems.serialNumber = 'Keep the serial number under 80 characters.';
    if (form.acquiredOn && form.acquiredOn > new Date().toISOString().slice(0, 10)) problems.acquiredOn = 'Acquisition cannot be in the future.';
    if (form.acquiredOn && form.warrantyExpiresOn && form.warrantyExpiresOn < form.acquiredOn) problems.warrantyExpiresOn = 'Warranty cannot expire before the item was acquired.';
    if (form.maintenanceIntervalDays && (Number(form.maintenanceIntervalDays) < 1 || Number(form.maintenanceIntervalDays) > 3650)) problems.maintenanceIntervalDays = 'Between 1 and 3650 days.';
    for (const [key, max] of Object.entries(LIMITS)) if (form[key] && form[key].length > max) problems[key] = `Too long (max ${max} characters).`;
    return problems;
  };

  const submit = async (event) => {
    event.preventDefault();
    const problems = validate();
    if (Object.keys(problems).length) {
      setErrors(problems);
      document.querySelector('.field--error input, .field--error select, .field--error textarea')?.focus();
      return;
    }
    setBusy(true);
    const payload = Object.fromEntries(Object.entries(form).filter(([, v]) => v !== '' && v !== null));
    try {
      const saved = isEdit ? await equipmentApi.update(id, payload) : await equipmentApi.create(payload);
      toast.success(isEdit ? 'Equipment record updated.' : `Added ${saved.equipment?.assetTag ?? saved.assetTag}. A QR label is ready on its profile.`);
      navigate(`/equipment/${saved.equipment?.id ?? saved.id}`);
    } catch (err) {
      setErrors(mapFieldErrors(err));
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async ({ confirmText }) => {
    setDeleteBusy(true);
    try {
      await equipmentApi.remove(id, { confirmTag: confirmText });
      toast.success('Record deleted.');
      navigate('/equipment');
    } catch (err) {
      setErrors(mapFieldErrors(err));
      toast.error(errorText(err));
      setDeleteOpen(false);
    } finally { setDeleteBusy(false); }
  };

  const nextDueHint = useMemo(() => {
    if (!form?.maintenanceIntervalDays) return 'No interval set — this item will never appear on the due board.';
    const from = form?.lastMaintenanceOn || new Date().toISOString().slice(0, 10);
    const d = new Date(Date.parse(from) + Number(form?.maintenanceIntervalDays) * 86_400_000);
    return `Next preventive maintenance would fall due ${d.toISOString().slice(0, 10)}.`;
  }, [form?.maintenanceIntervalDays, form?.lastMaintenanceOn]);


  if (existing.error) return <ErrorState error={existing.error} onRetry={existing.refresh} />;
  if (!form) return <Loading rows={9} label="Loading the form" />;

  return (
    <>
      <PageHeader
        back={{ to: isEdit ? `/equipment/${id}` : '/equipment', label: isEdit ? 'Back to the record' : 'All equipment' }}
        eyebrow={isEdit ? 'Edit record' : 'New record'}
        title={isEdit ? form.name || 'Edit equipment' : 'Add equipment'}
        description="Every field here exists because a department has been asked it at 8 pm when something failed. Leave a field empty rather than guessing — an empty field reads as “unknown”, a guess does not."
      />

      <form onSubmit={submit} noValidate className="stack">
        <div className="grid grid--2">
          <Card title="Identification">
            <div className="form-grid">
              <Field label="Equipment name" required error={errors.name} hint={`As the department calls it, e.g. “12-Lead ECG Workstation #02”.`}>
                <TextInput value={form.name} onChange={(e) => set({ name: e.target.value })} maxLength={LIMITS.name + 20} placeholder="Patient monitor, ultrasound, centrifuge…" />
              </Field>
              <Field label="Category" required error={errors.categoryId} hint="Determines the asset-tag prefix and the printed label.">
                <Select value={form.categoryId} onChange={(e) => set({ categoryId: e.target.value })} placeholder="Choose a category…"
                  options={(picklists.data?.categories ?? []).map((c) => ({ value: c.id, label: `${c.name} (${c.code})` }))} />
              </Field>
              <Field label="Manufacturer" error={errors.manufacturer}><TextInput value={form.manufacturer} onChange={(e) => set({ manufacturer: e.target.value })} /></Field>
              <Field label="Model" error={errors.model}><TextInput value={form.model} onChange={(e) => set({ model: e.target.value })} /></Field>
              <Field label="Serial number" error={errors.serialNumber} hint="Must be unique; it is how the workshop matches a part or a warranty claim.">
                <TextInput value={form.serialNumber} onChange={(e) => set({ serialNumber: e.target.value })} className="mono" />
              </Field>
            </div>
          </Card>

          <Card title="Where it lives">
            <div className="form-grid">
              <Field label="Room / location" error={errors.locationId}>
                <Select value={form.locationId} onChange={(e) => set({ locationId: e.target.value })} placeholder="Not assigned…"
                  options={(picklists.data?.locations ?? []).map((l) => ({ value: l.id, label: `${l.name}${l.room ? ` · ${l.room}` : ''}` }))} />
              </Field>
              <Field label="Department / unit" error={errors.department}>
                <TextInput value={form.department} onChange={(e) => set({ department: e.target.value })} />
              </Field>
              <Field label="Responsible person" error={errors.custodianUserId} hint="The staff member who keeps this item. Users are still able to report faults themselves.">
                <Select value={form.custodianUserId} onChange={(e) => set({ custodianUserId: e.target.value })} placeholder="Not recorded…"
                  options={custodians.map((c) => ({ value: c.id, label: c.fullName }))} />
              </Field>
              <Field label="…or free-text custodian" error={errors.custodianNote} hint="For a lab or class that is not an account holder.">
                <TextInput value={form.custodianNote} onChange={(e) => set({ custodianNote: e.target.value })} placeholder="e.g. Physiology demo bench 3" />
              </Field>
              <Field label="Criticality" error={errors.criticality} hint="Feeds the response target and the risk indicator. Life-support class is escalated automatically.">
                <Select value={form.criticality} onChange={(e) => set({ criticality: e.target.value })}
                  options={(picklists.data?.criticalities ?? []).map((c) => ({ value: c.value, label: c.label }))} />
              </Field>
            </div>
          </Card>

          <Card title="Acquisition and warranty">
            <div className="form-grid">
              <Field label="Purchase / acquisition date" error={errors.acquiredOn}><TextInput type="date" value={form.acquiredOn} onChange={(e) => set({ acquiredOn: e.target.value })} /></Field>
              <Field label="Warranty provider" error={errors.warrantyProvider}><TextInput value={form.warrantyProvider} onChange={(e) => set({ warrantyProvider: e.target.value })} /></Field>
              <Field label="Warranty expires" error={errors.warrantyExpiresOn} hint="The department is shown a badge while an item is still in warranty, which is when a repair should be a claim, not a cost.">
                <TextInput type="date" value={form.warrantyExpiresOn} onChange={(e) => set({ warrantyExpiresOn: e.target.value })} />
              </Field>
            </div>
          </Card>

          <Card title="Preventive maintenance" subtitle={nextDueHint}>
            <div className="form-grid">
              <Field label="Interval (days)" error={errors.maintenanceIntervalDays} hint="Common: 30 daily checks, 90 quarterly, 180 half-yearly, 365 annual.">
                <TextInput type="number" min="1" max="3650" inputMode="numeric" value={form.maintenanceIntervalDays} onChange={(e) => set({ maintenanceIntervalDays: e.target.value })} />
              </Field>
              <Field label="Last maintenance performed" error={errors.lastMaintenanceOn}>
                <TextInput type="date" value={form.lastMaintenanceOn} onChange={(e) => set({ lastMaintenanceOn: e.target.value })} />
              </Field>
              <Field label="Responsible technician" error={errors.responsibleTechnicianId} hint="Receives the due and overdue reminders.">
                <Select value={form.responsibleTechnicianId} onChange={(e) => set({ responsibleTechnicianId: e.target.value })} placeholder="Unassigned…"
                  options={technicians.map((t) => ({ value: t.id, label: `${t.fullName}${t.openFaults ? ` (${t.openFaults} open)` : ''}` }))} />
              </Field>
            </div>
            <Callout tone="info" title="Checklist">
              A default checklist is created from the interval name when you add a schedule on the maintenance screen. Edit it there to match the manufacturer manual — the manual always wins.
            </Callout>
          </Card>

          <Card title="Notes">
            <Field label="Internal notes" error={errors.notes} counter={{ text: `${form.notes.length}/${LIMITS.notes}`, over: form.notes.length > LIMITS.notes }}>
              <TextArea rows={4} value={form.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="Handling cautions, shared-use arrangements, anything the next technician should know." />
            </Field>
          </Card>
        </div>

        <div className="row row--between">
          <p className="form-note">Required fields are marked. The department can still be served with unknowns recorded as unknowns.</p>
          <div className="row">
            <Button tone="ghost" as={Link} to={isEdit ? `/equipment/${id}` : '/equipment'}>Cancel</Button>
            <Button tone="primary" type="submit" loading={busy}>{isEdit ? 'Save changes' : 'Create record'}</Button>
          </div>
        </div>
      </form>

      {isEdit && picklists ? (
        <Card title="Danger zone" className="danger-zone">
          <p className="form-note">
            Deleting removes the record entirely. Anything with fault, repair or maintenance history cannot be deleted — the department
            keeps that trail; deactivate or decommission the item instead.
          </p>
          <Button tone="danger" onClick={() => setDeleteOpen(true)}>Delete this record…</Button>
          <ConfirmDialog
            open={deleteOpen}
            title="Delete this equipment record?"
            body="Only records with no history can be deleted. Type the asset tag to confirm."
            confirmLabel="Delete permanently"
            requireText={existing.data?.equipment?.assetTag}
            busy={deleteBusy}
            onCancel={() => setDeleteOpen(false)}
            onConfirm={remove}
          />
        </Card>
      ) : null}
    </>
  );
}

/** Server field keys arrive snake_case (equipment table columns); map them onto the form. */
function mapFieldErrors(err) {
  const map = { category_id: 'categoryId', location_id: 'locationId', serial_number: 'serialNumber', custodian_user_id: 'custodianUserId', responsible_technician_id: 'responsibleTechnicianId', acquired_on: 'acquiredOn', warranty_expires_on: 'warrantyExpiresOn', maintenance_interval_days: 'maintenanceIntervalDays', last_maintenance_on: 'lastMaintenanceOn' };
  const out = {};
  for (const [k, v] of Object.entries(err?.fieldErrors ?? {})) {
    const key = Object.keys(map).includes(k) ? map[k] : k;
    out[key] = Array.isArray(v) ? v.join(' ') : String(v);
  }
  return out;
}
