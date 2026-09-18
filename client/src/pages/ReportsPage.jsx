import { useMemo, useState } from 'react';
import { reports as reportsApi, reference } from '../api/client.js';
import { PageHeader } from '../components/AppShell.jsx';
import { Button, Callout, Card, DataTable, EmptyState, ErrorState, Field, Loading, Select, TextInput } from '../components/ui.jsx';
import { Badge, KeyValue } from '../components/display.jsx';
import { useToast, errorText } from '../components/Toast.jsx';
import { useApi } from '../utils/useApi.js';
import { formatDateTime, formatMoney, toDateInput } from '../utils/format.js';

/**
 * Reports (Phase 10).  One query per report feeds the table, the CSV and the print view, so a
 * number in a file is always the number that was on the screen.  PDF comes from the browser's
 * print-to-PDF of the styled printable view (see docs/REPORTS.md for why).
 */
export function ReportsPage() {
  const toast = useToast();
  const [key, setKey] = useState('');
  const [filters, setFilters] = useState({ from: '', to: '', severity: '', status: '', technicianId: '', q: '' });
  const list = useApi(() => reportsApi.list(), []);
  const picklists = useApi(() => reference.picklists(), []);
  const active = key || list.data?.items?.[0]?.key || '';
  const meta = useMemo(() => (list.data?.items ?? []).find((r) => r.key === active), [list.data, active]);

  const query = useMemo(() => Object.fromEntries(Object.entries(filters).filter(([, v]) => v)), [filters]);
  const report = useApi(() => (active ? reportsApi.run(active, query) : Promise.resolve(null)), [active, JSON.stringify(query)]);
  const data = report.data;

  const showPrint = () => {
    const url = reportsApi.printUrl(active, query);
    const win = window.open(url, '_blank', 'noopener');
    if (!win) toast.warn('Your browser blocked the pop-up. Allow pop-ups for this site to print a report.');
  };

  if (list.loading) return <Loading rows={5} label="Loading the report catalogue" />;
  if (!list.data?.items?.length) return <EmptyState icon="▤" title="No reports available" description="Your role is not permitted to generate departmental reports." />;

  return (
    <>
      <PageHeader
        eyebrow="Reporting"
        title="Departmental reports"
        description="Inventory, fault history, maintenance, costs, downtime, repeat failures and compliance — exportable, printable and attributable."
        actions={(
          <>
            <Button tone="secondary" onClick={showPrint} disabled={!data}>🖨 Print / save as PDF</Button>
            <Button tone="primary" onClick={async () => {
              try {
                const res = await fetch(reportsApi.csvUrl(active, query), { credentials: 'same-origin' });
                if (!res.ok) throw new Error(`Export failed (${res.status})`);
                const blob = await res.blob();
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `${active}-${new Date().toISOString().slice(0, 10)}.csv`;
                document.body.appendChild(a); a.click(); a.remove();
                setTimeout(() => URL.revokeObjectURL(a.href), 4000);
                toast.success('CSV downloaded.');
              } catch (err) { toast.error(errorText(err)); }
            }} disabled={!data}>⬇ Download CSV</Button>
          </>
        )}
      />

      <div className="row" style={{ alignItems: 'stretch', gap: 'var(--sp-3)', marginBottom: 'var(--sp-4)' }}>
        <div style={{ flex: '1 1 240px', minWidth: 210 }}>
          <Field label="Report">
            <Select value={active} onChange={(e) => setKey(e.target.value)} options={(list.data.items ?? []).map((r) => ({ value: r.key, label: r.title }))} />
          </Field>
        </div>
        <div style={{ flex: '1 1 150px' }}><Field label="From"><TextInput type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} /></Field></div>
        <div style={{ flex: '1 1 150px' }}><Field label="To"><TextInput type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} /></Field></div>
        {['faults', 'costs', 'failures'].includes(active) ? (
          <div style={{ flex: '1 1 150px' }}>
            <Field label="Severity">
              <Select value={filters.severity} onChange={(e) => setFilters({ ...filters, severity: e.target.value })} placeholder="Any"
                options={['low', 'medium', 'high', 'critical'].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }))} />
            </Field>
          </div>
        ) : null}
        {['faults', 'costs', 'maintenance', 'failures'].includes(active) ? (
          <div style={{ flex: '1 1 170px' }}>
            <Field label="Technician">
              <Select value={filters.technicianId} onChange={(e) => setFilters({ ...filters, technicianId: e.target.value })} placeholder="Any"
                options={(picklists.data?.technicians ?? []).map((t) => ({ value: t.id, label: t.fullName }))} />
            </Field>
          </div>
        ) : null}
        <div className="row row--end" style={{ alignItems: 'flex-end' }}>
          <Button tone="ghost" onClick={() => setFilters({ from: '', to: '', severity: '', status: '', technicianId: '', q: '' })}>Reset</Button>
        </div>
      </div>

      <Callout tone="info" title={meta?.title}>{meta?.description}</Callout>

      <div style={{ marginTop: 'var(--sp-4)' }}>
        {report.error ? <ErrorState error={report.error} onRetry={report.refresh} /> : (
          <Card pad={false}
            title={`${meta?.title ?? 'Report'} · ${data?.rowCount ?? 0} row${data?.rowCount === 1 ? '' : 's'}`}
            subtitle={data ? `Generated ${formatDateTime(data.generatedAt)} · ${Object.entries(data.filters ?? {}).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' · ') || 'no filters'}` : ''}
            footer={data && Object.keys(data.totals ?? {}).length ? (
              <div className="row" style={{ gap: 'var(--sp-5)', flexWrap: 'wrap' }}>
                {Object.entries(data.totals).map(([k, v]) => (
                  <span key={k} className="report-totals"><b>{typeof v === 'number' ? (k.includes('ost') || k.includes('otal') || k.includes('ost') ? formatMoney(v) : v.toLocaleString()) : String(v)}</b> {k.replace(/([A-Z])/g, ' $1').toLowerCase()}</span>
                ))}
              </div>
            ) : null}
          >
            {report.loading && !data ? <Loading rows={6} label="Running the report" /> : (
              <DataTable
                dense
                rows={(data?.rows ?? []).slice(0, 400)}
                columns={(data?.columns ?? []).map((c) => ({ key: c.key, label: c.label, render: (r) => {
                  const v = r[c.key];
                  if (v === null || v === undefined || v === '') return <span className="muted">—</span>;
                  if (typeof v === 'number' && /(cost|total|price|percent)/i.test(c.key)) return <span className="mono">{c.key.includes('percent') ? `${v}%` : formatMoney(v)}</span>;
                  if (typeof v === 'boolean') return v ? 'yes' : 'no';
                  return String(v).length > 120 ? <span title={String(v)}>{String(v).slice(0, 118)}…</span> : String(v);
                } }))}
                empty={<EmptyState icon="▤" title="This report is empty" description="No rows match the filters — widen the date range or clear a filter." />}
              />
            )}
            {data && data.rows.length > 400 ? <p className="form-note" style={{ padding: '0 var(--sp-4) var(--sp-4)' }}>Showing the first 400 of {data.rows.length} rows; the CSV contains all of them.</p> : null}
          </Card>
        )}
      </div>
    </>
  );
}
