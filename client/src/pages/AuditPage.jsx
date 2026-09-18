import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { audit as auditApi } from '../api/client.js';
import { PageHeader } from '../components/AppShell.jsx';
import { Button, Callout, Card, DataTable, EmptyState, FilterBar, Loading, Pagination, SearchInput, Select } from '../components/ui.jsx';
import { Badge, KeyValue } from '../components/display.jsx';
import { useApi } from '../utils/useApi.js';
import { formatDateTime } from '../utils/format.js';

/** The audit trail, as a browsable report. Read-only by design: nothing here can be edited. */
export function AuditPage() {
  const [q, setQ] = useState('');
  const [entity, setEntity] = useState('');
  const [open, setOpen] = useState(null);
  const params = useMemo(() => ({ q: q || undefined, entityType: entity || undefined, perPage: 50, page: 1 }), [q, entity]);
  const res = useApi(() => auditApi.list(params), [JSON.stringify(params)]);

  return (
    <>
      <PageHeader eyebrow="Accountability" title="Audit log"
        description="Who changed what, when, and what it was before. Status changes, assignments, records and configuration all appear here." />
      <SearchInput value={q} onSearch={setQ} placeholder="Search action, reference or summary…" />
      <div className="row" style={{ margin: 'var(--sp-3) 0' }}>
        <Select value={entity} onChange={(e) => setEntity(e.target.value)} style={{ maxWidth: 240 }} aria-label="Entity type"
          options={[{ value: '', label: 'All entity types' }, ...['equipment', 'fault_report', 'repair_record', 'maintenance_record', 'maintenance_schedule', 'user', 'app_settings', 'sessions', 'equipment_categories', 'locations'].map((v) => ({ value: v, label: v.replace(/_/g, ' ') }))]} />
        <span className="muted" style={{ fontSize: '.8rem' }}>{res.data?.pagination?.total ?? '…'} entries</span>
      </div>

      <Card pad={false}>
        {res.loading && !res.data ? <Loading rows={8} /> : (
          <>
            <DataTable
              dense
              rows={res.data?.items ?? []}
              onRowClick={setOpen}
              empty={<EmptyState title="Nothing matches" description="Clear the search or the entity filter." />}
              columns={[
                { key: 'createdAt', label: 'When', render: (r) => <span className="nowrap">{formatDateTime(r.createdAt)}</span> },
                { key: 'actorName', label: 'Actor', render: (r) => (<div className="cell-main"><span className="cell-title">{r.actorName ?? 'system'}</span><span className="cell-sub">{r.actorRole}</span></div>) },
                { key: 'action', label: 'Action', render: (r) => <code>{r.action}</code> },
                { key: 'entityRef', label: 'Record', render: (r) => (r.entityRef ? <code>{r.entityRef}</code> : <span className="muted">{r.entityType}</span>) },
                { key: 'summary', label: 'Summary' },
                { key: 'ip', label: 'IP', render: (r) => <span className="muted mono" style={{ fontSize: '.72rem' }}>{r.ip ?? '—'}</span> },
              ]}
            />
            <Pagination pagination={res.data?.pagination} onPage={() => {}} />
          </>
        )}
      </Card>

      {open ? (
        <div style={{ marginTop: 'var(--sp-4)' }}>
          <Card title={`Audit entry · ${open.action}`} actions={<Button size="sm" tone="ghost" onClick={() => setOpen(null)}>Dismiss</Button>}>
            <KeyValue columns={2} items={[
              ['When', formatDateTime(open.createdAt, { withSeconds: true })],
              ['Actor', `${open.actorName ?? 'system'} (${open.actorRole ?? '—'})`],
              ['Entity', `${open.entityType} #${open.entityId ?? '—'}`],
              ['Reference', open.entityRef],
              ['IP / client', `${open.ip ?? '—'} · ${open.userAgent ?? '—'}`],
            ]} />
            {open.before ? <><p className="form-section__title">Before</p><pre className="json-diff">{JSON.stringify(open.before, null, 2)}</pre></> : null}
            {open.after ? <><p className="form-section__title">After</p><pre className="json-diff">{JSON.stringify(open.after, null, 2)}</pre></> : null}
            {open.summary ? <Callout tone="info">{open.summary}</Callout> : null}
          </Card>
        </div>
      ) : null}
    </>
  );
}
