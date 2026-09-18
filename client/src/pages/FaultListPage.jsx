import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { faults as faultsApi, reference } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { PageHeader } from '../components/AppShell.jsx';
import { Badge, Button, Card, DataTable, EmptyState, ErrorState, FilterBar, Pagination, SearchInput } from '../components/ui.jsx';
import { FaultStatusPill, SeverityPill } from '../components/display.jsx';
import { useApi } from '../utils/useApi.js';
import { formatDateTime, pluralise } from '../utils/format.js';

const SCOPES = [
  { id: 'open', label: 'Open' },
  { id: 'assigned', label: 'Assigned to me' },
  { id: 'unassigned', label: 'Waiting for an owner' },
  { id: 'mine', label: 'My reports' },
  { id: '', label: 'All' },
];

/** Every fault report the user is allowed to see, with the filters a supervisor asks for. */
export function FaultListPage({ mine = false }) {
  const [params, setParams] = useSearchParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState(mine ? 'mine' : (params.get('scope') ?? (can('fault.view.any') ? 'open' : 'mine')));

  const filters = useMemo(() => ({
    q: params.get('q') ?? '',
    status: params.get('status') ?? '',
    severity: params.get('severity') ?? '',
    categoryId: params.get('categoryId') ?? '',
    technicianId: params.get('technicianId') ?? '',
    equipmentId: params.get('equipmentId') ?? '',
    overdue: params.get('overdue') ?? '',
    scope: tab || undefined,
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
    sort: params.get('sort') ?? 'createdAt',
    dir: params.get('dir') ?? 'desc',
    page: params.get('page') ?? 1,
    perPage: 25,
  }), [params, tab]);

  const query = useMemo(() => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v !== '' && v !== undefined) sp.set(k, String(v));
    return sp.toString();
  }, [filters]);

  const { data, loading, error, refresh } = useApi(() => faultsApi.list(filters), [query]);
  const vocab = useApi(() => faultsApi.vocabulary(), []);
  const picklists = useApi(() => reference.picklists(), []);

  const set = (patch) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (!v) next.delete(k); else next.set(k, String(v)); }
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };

  const rows = data?.rows ?? [];
  const active = ['q', 'status', 'severity', 'categoryId', 'technicianId', 'overdue', 'from', 'to'].some((k) => params.get(k));
  const scopes = can('fault.view.any') ? SCOPES : SCOPES.filter((s) => ['open', 'mine'].includes(s.id));

  return (
    <>
      <PageHeader
        eyebrow="Fault workflow"
        title={mine ? 'My reports' : 'Fault reports'}
        description={mine
          ? 'Everything you have submitted, with where each one stands.'
          : 'Reported problems, who owns them, and how long they have been waiting.'}
        actions={<Button as={Link} to="/faults/new" tone="danger">＋ Report a fault</Button>}
      />

      <div className="tabs" role="tablist" aria-label="Report scope" style={{ marginBottom: 'var(--sp-4)' }}>
        {scopes.map((s) => (
          <button key={s.id || 'all'} type="button" role="tab" aria-selected={tab === s.id} className={`tabs__item${tab === s.id ? ' tabs__item--active' : ''}`}
            onClick={() => { setTab(s.id); set({ scope: s.id }); }}>
            {s.label}
          </button>
        ))}
      </div>

      <SearchInput value={filters.q} onSearch={(q) => set({ q })} placeholder="Search reference, title, description, asset tag…" />

      <div style={{ marginTop: 'var(--sp-4)' }}>
        <FilterBar active={active} onClear={() => { setParams(new URLSearchParams(), { replace: true }); }}>
          <select className="input" value={filters.status} onChange={(e) => set({ status: e.target.value })} aria-label="Workflow status">
            <option value="">Any status</option>
            {(vocab.data?.statuses ?? []).map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          <select className="input" value={filters.severity} onChange={(e) => set({ severity: e.target.value })} aria-label="Severity">
            <option value="">Any severity</option>
            {(vocab.data?.severities ?? []).map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          <select className="input" value={filters.categoryId} onChange={(e) => set({ categoryId: e.target.value })} aria-label="Fault category">
            <option value="">Any category</option>
            {(vocab.data?.categories ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {can('fault.view.any') ? (
            <select className="input" value={filters.technicianId} onChange={(e) => set({ technicianId: e.target.value })} aria-label="Technician">
              <option value="">Any technician</option>
              {(picklists.data?.technicians ?? []).map((t) => <option key={t.id} value={t.id}>{t.fullName}</option>)}
            </select>
          ) : null}
          <select className="input" value={filters.overdue} onChange={(e) => set({ overdue: e.target.checked ? '1' : '' })} aria-label="Past response target">
            <option value="">Any response time</option>
            <option value="1">Only past the target</option>
          </select>
          <label className="field"><span className="field__label">From</span><input type="date" className="input" value={filters.from} onChange={(e) => set({ from: e.target.value })} /></label>
          <label className="field"><span className="field__label">To</span><input type="date" className="input" value={filters.to} onChange={(e) => set({ to: e.target.value })} /></label>
        </FilterBar>

        <Card pad={false}>
          {error ? <div style={{ padding: 'var(--sp-4)' }}><ErrorState error={error} onRetry={refresh} /></div> : (
            <DataTable
              loading={loading && !data}
              rows={rows}
              onRowClick={(r) => navigate(`/faults/${r.id}`)}
              caption="Fault reports"
              columns={[
                { key: 'reference', label: 'Report', mono: true, render: (r) => (
                  <div className="cell-main">
                    <span className="cell-title"><code>{r.reference}</code></span>
                    <span className="cell-sub">{formatDateTime(r.createdAt)}{r.assignedAt ? ` · owned ${pluralise(Math.round((Date.parse(r.assignedAt) - Date.parse(r.createdAt)) / 3_600_000), 'hour')} later` : ''}</span>
                  </div>
                ) },
                { key: 'title', label: 'Fault', render: (r) => (
                  <div className="cell-main">
                    <span className="cell-title">{r.title}</span>
                    <span className="cell-sub">{r.equipmentName} · {r.assetTag}{r.categoryName ? ` · ${r.categoryName}` : ''}</span>
                  </div>
                ) },
                { key: 'severity', label: 'Severity', align: 'center', render: (r) => <SeverityPill severity={r.severity} /> },
                { key: 'status', label: 'Status', render: (r) => <FaultStatusPill status={r.status} /> },
                { key: 'assignedToName', label: 'With', render: (r) => (r.assignedToName ? r.assignedToName : <Badge tone="warn" size="sm">unassigned</Badge>) },
                { key: 'sla', label: 'Response', align: 'right', render: (r) => (
                  r.isOverdue
                    ? <span className="sla sla--late" title={`Target ${formatDateTime(r.dueAt)}`}>⏱ {Math.ceil((r.minutesOverdue ?? 0) / 60)} h late</span>
                    : r.minutesOverdue === 0 && r.dueAt ? <span className="muted">on target</span> : <span className="muted">—</span>
                ) },
              ]}
              empty={(
                <EmptyState
                  icon="⚑"
                  title={tab === 'unassigned' ? 'Nothing is waiting for an owner' : 'No fault reports here'}
                  description={tab === 'unassigned'
                    ? 'Every open report has someone responsible for it. Good.'
                    : 'Either nothing is broken, or it is not being reported. The second one is the usual case.'}
                  action={<Button as={Link} to="/faults/new" tone="secondary">Report a fault</Button>}
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
