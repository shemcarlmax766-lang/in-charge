import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { equipment as equipmentApi, reference } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { PageHeader } from '../components/AppShell.jsx';
import { Button, EmptyState, ErrorState, FilterBar, Pagination, SearchInput, Select, TextInput } from '../components/ui.jsx';
import { Card, DataTable, EquipmentStatusPill, MaintenanceLight, RiskBadge, Badge } from '../components/display.jsx';
import { useApi } from '../utils/useApi.js';
import { cx } from '../utils/format.js';

/**
 * Inventory browser (Phase 2).  Search and filters live in the URL, so a filter state can be
 * pasted into a message ("we have 4 of these, 2 broken: <link>") and survives a reload.
 */
export function EquipmentListPage() {
  const [params, setParams] = useSearchParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const [selected, setSelected] = useState([]);

  const filters = useMemo(() => ({
    q: params.get('q') ?? '',
    status: params.get('status') ?? '',
    categoryId: params.get('categoryId') ?? '',
    locationId: params.get('locationId') ?? '',
    criticality: params.get('criticality') ?? '',
    maintenanceState: params.get('maintenanceState') ?? '',
    technicianId: params.get('technicianId') ?? '',
    needsAttention: params.get('needsAttention') ?? '',
    sort: params.get('sort') ?? 'name',
    dir: params.get('dir') ?? 'asc',
    page: params.get('page') ?? 1,
    perPage: params.get('perPage') ?? 25,
  }), [params]);

  const query = useMemo(() => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v !== '' && v !== null && v !== undefined) sp.set(k, String(v));
    return sp.toString();
  }, [filters]);

  const { data, loading, error, refresh } = useApi(() => equipmentApi.list(filters), [query]);
  const picklists = useApi(() => reference.picklists(), []);

  const set = (patch) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === '' || v === null || v === undefined) next.delete(k);
      else next.set(k, String(v));
    }
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };

  const active = Object.entries(filters).some(([k, v]) => v !== '' && v !== null && v !== undefined && k !== 'sort' && k !== 'dir' && k !== 'page' && k !== 'perPage' && k !== 'q');
  const rows = data?.items ?? [];
  const total = data?.pagination?.total ?? 0;

  const toggleSort = (key) => {
    const map = { name: 'name', assetTag: 'assetTag', status: 'status', nextMaintenanceOn: 'nextMaintenanceOn', totalFaults: 'totalFaults', criticality: 'criticality' };
    const target = map[key] ?? key;
    set({ sort: target, dir: filters.sort === target && filters.dir === 'asc' ? 'desc' : 'asc' });
  };

  return (
    <>
      <PageHeader
        eyebrow="Inventory"
        title="Equipment"
        description={loading ? 'Loading…' : `${total} item${total === 1 ? '' : 's'} matching the current filters. Scan a label or open a record for its full history.`}
        actions={(
          <>
            {can('equipment.create') ? <Button as={Link} to="/equipment/new" tone="primary">＋ Add equipment</Button> : null}
            {selected.length && can('equipment.qr') ? <Button tone="secondary" onClick={() => navigate('/reference?tab=labels&ids=' + selected.join(','))}>🏷 Print {selected.length} label{selected.length > 1 ? 's' : ''}</Button> : null}
          </>
        )}
      />

      <form onSubmit={(e) => { e.preventDefault(); refresh(); }}>
        <SearchInput
          value={filters.q}
          onSearch={(q) => set({ q })}
          placeholder="Search by name, asset tag, serial, manufacturer, model, room or category"
        />
      </form>

      <div style={{ marginTop: 'var(--sp-4)' }}>
        <FilterBar active={active} onClear={() => setParams(new URLSearchParams(), { replace: true })}>
          <Select value={filters.status} onChange={(e) => set({ status: e.target.value })} aria-label="Filter by status"
            options={[{ value: '', label: 'Any status' }, ...(picklists.data?.equipmentStatuses ?? [])]} />
          <Select value={filters.categoryId} onChange={(e) => set({ categoryId: e.target.value })} aria-label="Filter by category"
            options={[{ value: '', label: 'Any category' }, ...(picklists.data?.categories ?? []).map((c) => ({ value: c.id, label: c.name }))]} />
          <Select value={filters.locationId} onChange={(e) => set({ locationId: e.target.value })} aria-label="Filter by location"
            options={[{ value: '', label: 'Any location' }, ...(picklists.data?.locations ?? []).map((l) => ({ value: l.id, label: l.name }))]} />
          <Select value={filters.maintenanceState} onChange={(e) => set({ maintenanceState: e.target.value })} aria-label="Filter by maintenance state"
            options={[
              { value: '', label: 'Any maintenance state' },
              { value: 'overdue', label: '🔴 Overdue' },
              { value: 'due_soon', label: '🟡 Due soon' },
              { value: 'up_to_date', label: '🟢 Up to date' },
              { value: 'not_scheduled', label: '⚪ No schedule' },
            ]} />
          <Select value={filters.criticality} onChange={(e) => set({ criticality: e.target.value })} aria-label="Filter by criticality"
            options={[{ value: '', label: 'Any criticality' }, ...(picklists.data?.criticalities ?? []).map((c) => ({ value: c.value, label: c.label }))]} />
          <Select value={filters.technicianId} onChange={(e) => set({ technicianId: e.target.value })} aria-label="Filter by responsible technician"
            options={[{ value: '', label: 'Any technician' }, ...(picklists.data?.technicians ?? []).map((t) => ({ value: t.id, label: t.fullName }))]} />
          <label className="check" style={{ alignSelf: 'end' }}>
            <input type="checkbox" checked={filters.needsAttention === '1'} onChange={(e) => set({ needsAttention: e.target.checked ? '1' : '' })} />
            <span className="check__box" aria-hidden="true" />
            <span className="check__text"><span className="check__label">Needs attention only</span><span className="check__hint">Broken, under work, or PM due</span></span>
          </label>
        </FilterBar>

        <Card pad={false}>
          {error ? <div style={{ padding: 'var(--sp-4)' }}><ErrorState error={error} onRetry={refresh} /></div> : (
            <DataTable
              loading={loading && !data}
              rows={rows}
              onRowClick={(row) => navigate(`/equipment/${row.id}`)}
              caption="Equipment inventory"
              columns={[
                { key: 'select', label: '', render: (r) => (
                  <input
                    type="checkbox"
                    className="row-check"
                    aria-label={`Select ${r.name}`}
                    checked={selected.includes(r.id)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setSelected((list) => (e.target.checked ? [...list, r.id] : list.filter((x) => x !== r.id)))}
                  />
                ) },
                { key: 'name', label: 'Equipment', sortable: true, dir: filters.sort === 'name' ? filters.dir : null, onSort: toggleSort, render: (r) => (
                  <div className="cell-main">
                    <span className="cell-title">{r.name}</span>
                    <span className="cell-sub">{r.manufacturer ? `${r.manufacturer} ${r.model ?? ''}`.trim() : r.categoryName} · {r.assetTag}</span>
                  </div>
                ) },
                { key: 'locationLabel', label: 'Location', render: (r) => r.locationLabel ?? r.locationName ?? <span className="muted">Not recorded</span> },
                { key: 'status', label: 'Status', render: (r) => (
                  <div className="row row--tight" style={{ flexWrap: 'wrap' }}>
                    <EquipmentStatusPill status={r.status} />
                    {r.openFaultCount > 0 ? <Badge tone="warn">⚑ {r.openFaultCount}</Badge> : null}
                  </div>
                ) },
                { key: 'maintenanceState', label: 'Maintenance', render: (r) => <MaintenanceLight state={r.maintenanceState} daysUntil={r.daysUntilPm} /> },
                { key: 'totalFaults', label: 'Faults', align: 'center', sortable: true, dir: filters.sort === 'totalFaults' ? filters.dir : null, onSort: toggleSort, render: (r) => (r.totalFaults ? <b>{r.totalFaults}</b> : <span className="muted">0</span>) },
                { key: 'nextMaintenanceOn', label: 'Next PM', align: 'right', render: (r) => r.nextMaintenanceOn ?? <span className="muted">—</span> },
              ]}
              empty={(
                <EmptyState
                  icon="⚕"
                  title={filters.q || active ? 'Nothing matches those filters' : 'The inventory is empty'}
                  description={filters.q || active
                    ? 'Try a broader search, or clear the filters. Equipment is normally found by asset tag (BMU-…) or serial number.'
                    : 'Add the department’s first items, or scan a label that already exists.'}
                  action={filters.q || active
                    ? <Button tone="secondary" onClick={() => setParams(new URLSearchParams(), { replace: true })}>Clear filters</Button>
                    : (can('equipment.create') ? <Button as={Link} to="/equipment/new" tone="primary">＋ Add equipment</Button> : null)}
                />
              )}
            />
          )}
          <Pagination pagination={data?.pagination} onPage={(page) => set({ page })} />
        </Card>
      </div>
    </>
  );
}
