import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { parts as partsApi, reference } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { PageHeader } from '../components/AppShell.jsx';
import { Button, Callout, Card, Checkbox, ConfirmDialog, DataTable, EmptyState, Field, Loading, Modal, Select, Tabs, TextArea, TextInput } from '../components/ui.jsx';
import { Badge, KeyValue } from '../components/display.jsx';
import { useToast, errorText } from '../components/Toast.jsx';
import { useApi } from '../utils/useApi.js';

/**
 * Configuration (categories, locations, fault types, parts, settings) plus the QR label sheet.
 * Reference rows are never hard-deleteable while in use — the picker offers deactivation, which
 * keeps old records meaningful.
 */
export function ReferencePage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'categories';
  const { can } = useAuth();
  const set = (patch) => { const next = new URLSearchParams(params); for (const [k, v] of Object.entries(patch)) { if (!v) next.delete(k); else next.set(k, String(v)); } setParams(next, { replace: true }); };
  const readonly = !can('meta.manage');

  return (
    <>
      <PageHeader eyebrow="Configuration" title="Reference data & settings"
        description={readonly ? 'You can view these lists; only an administrator can change them.' : 'The lists every other screen is built from. Keep them short and boring — a picker with 60 rooms is a picker nobody uses.'} />
      {readonly ? <Callout tone="info">Read-only view. Ask the department administrator to change configuration.</Callout> : null}

      <Tabs active={tab} onChange={(id) => set({ tab: id })} tabs={[
        { id: 'categories', label: 'Equipment categories' },
        { id: 'locations', label: 'Locations' },
        { id: 'fault-categories', label: 'Fault categories' },
        { id: 'parts', label: 'Parts catalogue' },
        { id: 'labels', label: 'QR labels' },
        { id: 'settings', label: 'Settings' },
      ]} />

      <div className="tabpanel">
        {tab === 'categories' ? <RefTable kind="categories" route="category" title="Equipment categories" columns={[['code', 'Code'], ['name', 'Name'], ['description', 'Description']]} hint="The code becomes the asset-tag prefix (BMU-<code>-0001), so choose it once and keep it." readonly={readonly} /> : null}
        {tab === 'locations' ? <RefTable kind="locations" route="location" title="Locations" columns={[['code', 'Code'], ['name', 'Name'], ['building', 'Building'], ['floor', 'Floor'], ['room', 'Room']]} hint="Rooms, not people. Equipment moves; a room does not." readonly={readonly} /> : null}
        {tab === 'fault-categories' ? <RefTable kind="fault-categories" route="faultCategory" title="Fault categories" columns={[['code', 'Code'], ['name', 'Name'], ['description', 'Description'], ['defaultSeverity', 'Default severity']]} hint="These are what a reporter picks from. Keep the wording symptom-shaped, not cause-shaped." readonly={readonly} /> : null}
        {tab === 'parts' ? <PartsPanel readonly={readonly} /> : null}
        {tab === 'labels' ? <LabelSheet /> : null}
        {tab === 'settings' ? <SettingsPanel readonly={readonly} /> : null}
      </div>
    </>
  );
}

function RefTable({ kind, title, columns, hint, readonly }) {
  const toast = useToast();
  const res = useApi(() => reference[kind === 'categories' ? 'categories' : kind === 'locations' ? 'locations' : 'faultCategories'](), [kind]);
  const [editing, setEditing] = useState(null);
  const [removing, setRemoving] = useState(null);
  const rows = res.data?.items ?? [];

  return (
    <>
      <Card pad={false} title={title} subtitle={hint}
        actions={!readonly ? <Button size="sm" tone="primary" onClick={() => setEditing({})}>＋ Add</Button> : null}>
        {res.loading && !res.data ? <Loading rows={4} /> : (
          <DataTable
            rows={rows}
            empty={<EmptyState title="Nothing configured" description="Add the first entry so equipment can be classified." />}
            columns={[
              ...columns.map(([key, label]) => ({ key, label, render: (r) => (key.endsWith('Severity') || key === 'code') ? <code>{r[key]}</code> : (r[key] ?? <span className="muted">—</span>) })),
              { key: 'usageCount', label: 'In use', align: 'center', render: (r) => (r.usageCount ? <Badge tone={r.usageCount > 0 ? 'neutral' : 'neutral'} size="sm">{r.usageCount}</Badge> : <span className="muted">0</span>) },
              { key: 'isActive', label: '', render: (r) => (!r.isActive ? <Badge tone="neutral" size="sm">inactive</Badge> : null) },
              ...(!readonly ? [{ key: 'actions', label: '', render: (r) => (
                <div className="row row--tight">
                  <Button size="sm" tone="ghost" onClick={() => setEditing(r)}>Edit</Button>
                  <Button size="sm" tone="ghost" onClick={() => setRemoving(r)}>Delete</Button>
                </div>
              ) }] : []),
            ]}
          />
        )}
      </Card>

      <RefFormModal state={editing} kind={kind} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); res.refresh(); toast.success('Saved.'); }} />
      <ConfirmDialog
        open={!!removing}
        title={`Delete “${removing?.name}”?`}
        body={removing?.usageCount ? `${removing.usageCount} record(s) use this entry, so it cannot be deleted — deactivate it instead.` : 'Nothing references this entry, so deleting it is safe.'}
        confirmLabel={removing?.usageCount ? 'Deactivate instead' : 'Delete'}
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          try {
            if (removing.usageCount) await reference.update(kind, removing.id, { isActive: false });
            else await reference.remove(kind, removing.id);
            setRemoving(null); res.refresh(); toast.success(removing.usageCount ? 'Deactivated — new records will not offer it.' : 'Deleted.');
          } catch (err) { toast.error(errorText(err)); }
        }}
      />
    </>
  );
}

function RefFormModal({ state, kind, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({});
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (state) { setForm({ ...state }); setErrors({}); } }, [state]);
  if (!state) return null;
  const isEdit = Boolean(state.id);
  const submit = async () => {
    setBusy(true);
    try {
      const payload = { code: form.code, name: form.name, description: form.description, building: form.building, floor: form.floor, room: form.room, defaultSeverity: form.defaultSeverity, isActive: form.isActive !== false };
      if (isEdit) await reference.update(kind, state.id, payload); else await reference.create(kind, payload);
      onSaved();
    } catch (err) {
      const mapped = {};
      for (const [k, v] of Object.entries(err.fieldErrors ?? {})) mapped[k] = Array.isArray(v) ? v.join(' ') : String(v);
      setErrors(mapped);
      toast.error(errorText(err));
    } finally { setBusy(false); }
  };
  const isLocation = kind === 'locations';
  const isFault = kind === 'fault-categories';
  return (
    <Modal open onClose={onClose} title={`${isEdit ? 'Edit' : 'Add'} ${kind.replace('fault-categories', 'fault category').replace('categories', 'category').replace('locations', 'location')}`}
      footer={<><Button tone="ghost" onClick={onClose}>Cancel</Button><Button tone="primary" loading={busy} onClick={submit}>Save</Button></>}>
      <div className="form-grid form-grid--2">
        <Field label="Code" required error={errors.code} hint={isEdit ? 'Changing a code does not rewrite existing asset tags.' : '1–12 characters, A–Z 0–9.'}><TextInput value={form.code ?? ''} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} className="mono" /></Field>
        <Field label="Name" required error={errors.name}><TextInput value={form.name ?? ''} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        {isLocation ? (
          <>
            <Field label="Building" error={errors.building}><TextInput value={form.building ?? ''} onChange={(e) => setForm({ ...form, building: e.target.value })} /></Field>
            <Field label="Floor" error={errors.floor}><TextInput value={form.floor ?? ''} onChange={(e) => setForm({ ...form, floor: e.target.value })} /></Field>
            <Field label="Room" error={errors.room}><TextInput value={form.room ?? ''} onChange={(e) => setForm({ ...form, room: e.target.value })} /></Field>
          </>
        ) : (
          <Field label="Description" error={errors.description} hint="Shown as help text on the reporting form."><TextInput value={form.description ?? ''} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        )}
        {isFault ? (
          <Field label="Default severity" error={errors.defaultSeverity} hint="Used only if a report arrives without an explicit severity.">
            <Select value={form.defaultSeverity ?? 'medium'} onChange={(e) => setForm({ ...form, defaultSeverity: e.target.value })}
              options={['low', 'medium', 'high', 'critical'].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }))} />
          </Field>
        ) : null}
      </div>
      {isEdit ? <Checkbox label="Active (available in pickers)" checked={form.isActive !== false} onChange={(v) => setForm({ ...form, isActive: v })} /> : null}
    </Modal>
  );
}

function PartsPanel() {
  const toast = useToast();
  const [q, setQ] = useState('');
  const res = useApi(() => partsApi.list({ q: q || undefined }), [q]);
  const [editing, setEditing] = useState(null);
  return (
    <>
      <Card pad={false} title="Spare parts catalogue" subtitle="Reference for repair lines, with typical unit costs. Stock counts are informational — this system does not run a stores module."
        actions={<Button size="sm" tone="primary" onClick={() => setEditing({ unit: 'pcs', unitCost: 0, inStock: 0, isActive: true })}>＋ Add part</Button>}>
        <div style={{ padding: 'var(--sp-3) var(--sp-4) 0' }}><TextInput placeholder="Filter by code, name or category…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search parts" /></div>
        {res.loading && !res.data ? <Loading rows={4} /> : (
          <DataTable dense rows={res.data?.items ?? []} empty={<EmptyState title="No parts listed" description="Add the consumables and common spares your technicians fit most often." />}
            columns={[
              { key: 'code', label: 'Code', mono: true },
              { key: 'name', label: 'Part' },
              { key: 'category', label: 'Category' },
              { key: 'unit', label: 'Unit', align: 'center' },
              { key: 'unitCost', label: 'Unit cost', align: 'right', render: (r) => <span className="mono">{Number(r.unitCost).toFixed(2)}</span> },
              { key: 'inStock', label: 'On hand', align: 'center', render: (r) => (r.inStock === 0 ? <Badge tone="warn" size="sm">none</Badge> : r.inStock) },
              { key: 'actions', label: '', render: (r) => <Button size="sm" tone="ghost" onClick={() => setEditing(r)}>Edit</Button> },
            ]} />
        )}
      </Card>
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? 'Edit part' : 'Add part'}
        footer={<><Button tone="ghost" onClick={() => setEditing(null)}>Cancel</Button><Button tone="primary" onClick={async () => {
          try { await partsApi.upsert(editing); setEditing(null); res.refresh(); toast.success('Saved.'); } catch (err) { toast.error(errorText(err)); }
        }}>Save</Button></>}>
        {editing ? (
          <div className="form-grid form-grid--2">
            <Field label="Code" required><TextInput className="mono" value={editing.code ?? ''} onChange={(e) => setEditing({ ...editing, code: e.target.value.toUpperCase() })} /></Field>
            <Field label="Name" required><TextInput value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
            <Field label="Category"><TextInput value={editing.category ?? ''} onChange={(e) => setEditing({ ...editing, category: e.target.value })} /></Field>
            <Field label="Unit"><TextInput value={editing.unit ?? 'pcs'} onChange={(e) => setEditing({ ...editing, unit: e.target.value })} /></Field>
            <Field label="Unit cost"><TextInput type="number" min="0" step="0.01" value={editing.unitCost ?? 0} onChange={(e) => setEditing({ ...editing, unitCost: e.target.value })} /></Field>
            <Field label="On hand" hint="Not decremented by repairs; update it when the shelf is checked."><TextInput type="number" min="0" value={editing.inStock ?? 0} onChange={(e) => setEditing({ ...editing, inStock: e.target.value })} /></Field>
          </div>
        ) : null}
      </Modal>
    </>
  );
}

function LabelSheet() {
  const toast = useToast();
  const [ids, setIds] = useState([]);
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const options = useApi(() => import('../api/client.js').then((m) => m.equipment.list({ q: search || undefined, perPage: 30 })), [search]);

  const generate = async () => {
    if (!ids.length) { toast.warn('Pick at least one item.'); return; }
    setBusy(true);
    try {
      const { equipment } = await import('../api/client.js');
      const res = await equipment.labels(ids);
      setRows(res.items);
      toast.success(`${res.items.length} label(s) ready.`);
    } catch (err) { toast.error(errorText(err)); } finally { setBusy(false); }
  };

  return (
    <>
      <Card title="QR label sheet" subtitle="Pick equipment, generate, then print on label stock at 100% scale. Each label opens that item’s profile and fault-report form.">
        <div className="row" style={{ marginBottom: 'var(--sp-3)' }}>
          <TextInput style={{ flex: '1 1 260px' }} placeholder="Search equipment…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search equipment for labels" />
          <Button tone="primary" loading={busy} onClick={generate}>Generate {ids.length ? `${ids.length} label(s)` : ''}</Button>
          {rows.length ? <Button tone="ghost" onClick={() => window.print()}>🖨 Print sheet</Button> : null}
        </div>
        <ul className="chipcloud">
          {(options.data?.items ?? []).map((e) => (
            <li key={e.id}>
              <button type="button" className={`chip${ids.includes(e.id) ? ' chip--active' : ''}`} onClick={() => setIds((list) => (list.includes(e.id) ? list.filter((x) => x !== e.id) : [...list, e.id]))}>
                <span className="chip__label">{e.name}</span><span className="chip__hint">{e.assetTag}</span>
              </button>
            </li>
          ))}
        </ul>
      </Card>
      {rows.length ? (
        <div className="label-sheet">
          {rows.map((l) => (
            <div key={l.id} className="label">
              <img src={l.png} alt={`QR code for ${l.assetTag}`} width="120" height="120" />
              <p className="label__tag">{l.assetTag}</p>
              <p className="label__name">{l.name}</p>
              <p className="label__foot">Report a fault: scan this code</p>
            </div>
          ))}
        </div>
      ) : <Callout tone="info">Tip: print labels for new equipment as it is commissioned, not later — a device without a tag gets fewer, vaguer reports.</Callout>}
    </>
  );
}
function SettingsPanel({ readonly }) {
  const toast = useToast();
  const res = useApi(() => reference.settings(), []);
  const [form, setForm] = useState({});
  useEffect(() => {
    if (!res.data) return;
    const out = {};
    for (const [k, v] of Object.entries(res.data.settings)) out[k] = v.type === 'json' ? JSON.stringify(v.value, null, 0) : v.type === 'bool' ? v.value : v.value ?? '';
    setForm(out);
  }, [res.data]);
  if (res.loading && !res.data) return <Loading rows={5} />;

  const save = async () => {
    const patch = {};
    for (const [k, def] of Object.entries(res.data.definitions)) {
      const current = res.data.settings[k].value;
      let next = form[k];
      if (def.type === 'bool') next = !!next;
      else if (def.type === 'int') next = Number(next);
      else if (def.type === 'json') { try { next = JSON.parse(next); } catch { toast.error(`${def.label} must be valid JSON, e.g. {"critical":4}`); return; } }
      if (JSON.stringify(next) !== JSON.stringify(current)) patch[k] = next;
    }
    if (!Object.keys(patch).length) { toast.info('Nothing changed.'); return; }
    try { await reference.saveSettings(patch); res.refresh(); toast.success('Settings saved.'); }
    catch (err) { toast.error(errorText(err)); }
  };

  return (
    <>
      <Card title="Department settings" subtitle="Everything here is configuration, not code: names on reports, currency, response targets and reminder windows.">
        <div className="form-grid form-grid--2">
          {Object.entries(res.data.definitions).map(([key, def]) => {
            const value = form[key];
            if (def.type === 'bool') {
              return <div key={key} className="check"><label className="check" style={{ border: 0, padding: 0 }}><input type="checkbox" disabled={readonly} checked={!!value} onChange={(e) => setForm({ ...form, [key]: e.target.checked })} /><span className="check__box" aria-hidden="true" /><span className="check__text"><span className="check__label">{def.label}</span><span className="check__hint">{def.description}</span></span></label></div>;
            }
            return (
              <Field key={key} label={def.label} hint={def.description}>
                {def.type === 'json'
                  ? <TextArea rows={2} disabled={readonly} value={value ?? ''} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
                  : <TextInput disabled={readonly} type={def.type === 'int' ? 'number' : 'text'} value={value ?? ''} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />}
              </Field>
            );
          })}
        </div>
        {!readonly ? <div className="row row--end" style={{ marginTop: 'var(--sp-4)' }}><Button tone="primary" onClick={save}>Save settings</Button></div> : null}
      </Card>
      <Callout tone="warn" title="Careful with these two">
        <p>“Require verification before closing” exists so a fault cannot disappear without someone checking the fix. Turning it off is a
          departmental decision, not a convenience.</p>
        <p style={{ marginTop: 6 }}>Response targets change what counts as “overdue” on the dashboard, so agree them with the technical team.</p>
      </Callout>
    </>
  );
}
