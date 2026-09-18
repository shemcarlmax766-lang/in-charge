import { useState } from 'react';
import { Link } from 'react-router-dom';
import { dashboard as dashboardApi } from '../api/client.js';
import { PageHeader } from '../components/AppShell.jsx';
import { Button, Callout, Card, DataTable, ErrorState, Loading, Modal, Select } from '../components/ui.jsx';
import { Badge, MaintenanceLight, RiskBadge, formatDate, KeyValue } from '../components/display.jsx';
import { useApi } from '../utils/useApi.js';
import { SAFETY_NOTICE } from '../utils/constants.js';

/**
 * Risk register (Phase 8).  Ranking + explanation, not a black box: the whole point is that a
 * department head can defend the decision to shorten a PM interval by pointing at the rows
 * behind the number.
 */
export function RiskPage() {
  const [level, setLevel] = useState('');
  const [limit, setLimit] = useState(50);
  const [openRow, setOpenRow] = useState(null);
  const { data, loading, error, refresh } = useApi(() => dashboardApi.risk({ level: level || undefined, limit }), [level, limit]);
  const model = useApi(() => dashboardApi.riskModel(), []);

  return (
    <>
      <PageHeader
        eyebrow="Decision support"
        title="Maintenance risk register"
        description="A rule-based ranking of which equipment deserves attention next, computed from this department's own failure and maintenance history."
        actions={<Button as={Link} to="/maintenance" tone="secondary">Maintenance programme</Button>}
      />

      <Callout tone="safety" title="What this is, and what it is not">
        <p>{SAFETY_NOTICE}</p>
        <p style={{ marginTop: 6 }}>
          It is <b>not</b> a machine-learning model and does not predict failures. It scores {model.data?.factors?.length ?? 7} published
          factors (raw ceiling {model.data?.maxRaw ?? 135} points, normalised to 0–100) so that a number can always be traced to a record.
        </p>
      </Callout>

      <div className="row" style={{ margin: 'var(--sp-4) 0', gap: 'var(--sp-3)' }}>
        <Select aria-label="Risk band" value={level} onChange={(e) => setLevel(e.target.value)} style={{ maxWidth: 200 }}
          options={[{ value: '', label: 'All bands' }, { value: 'high', label: 'High risk only' }, { value: 'moderate', label: 'Moderate only' }, { value: 'low', label: 'Low only' }]} />
        <Select aria-label="Number of rows" value={limit} onChange={(e) => setLimit(Number(e.target.value))} style={{ maxWidth: 160 }}
          options={[10, 25, 50, 100].map((n) => ({ value: n, label: `${n} items` }))} />
        <span className="spacer" />
        <div className="row row--tight">
          {Object.entries(data?.distribution ?? {}).map(([k, v]) => <Badge key={k} tone={k === 'high' ? 'bad' : k === 'moderate' ? 'warn' : 'ok'}>{v} {k}</Badge>)}
        </div>
      </div>

      <Card pad={false}>
        {error ? <div style={{ padding: 'var(--sp-4)' }}><ErrorState error={error} onRetry={refresh} /></div> : (
          <DataTable
            loading={loading && !data}
            rows={data?.items ?? []}
            onRowClick={setOpenRow}
            caption="Maintenance risk ranking"
            columns={[
              { key: 'equipmentName', label: 'Equipment', render: (r) => (<div className="cell-main"><span className="cell-title">{r.equipmentName}</span><span className="cell-sub">{r.assetTag} · {r.criticality?.replace('_', ' ')}</span></div>) },
              { key: 'score', label: 'Risk', render: (r) => <RiskBadge level={r.level} score={r.score} /> },
              { key: 'faults', label: 'Faults 12 mo', align: 'center', render: (r) => r.inputSnapshot?.faultsIn12Months ?? 0 },
              { key: 'worst', label: 'Worst severity', align: 'center', render: (r) => (r.inputSnapshot?.worstSeverityOnRecord ? <Badge tone={r.inputSnapshot.worstSeverityOnRecord === 'critical' ? 'bad' : r.inputSnapshot.worstSeverityOnRecord === 'high' ? 'warn' : 'neutral'}>{r.inputSnapshot.worstSeverityOnRecord}</Badge> : <span className="muted">none</span>) },
              { key: 'pm', label: 'PM position', render: (r) => (r.inputSnapshot?.nextMaintenanceOn
                ? <span>{formatDate(r.inputSnapshot.nextMaintenanceOn)} {new Date(r.inputSnapshot.nextMaintenanceOn) < new Date() ? <MaintenanceLight state="overdue" label="overdue" /> : null}</span>
                : <MaintenanceLight state="not_scheduled" label="no schedule" />) },
              { key: 'drivers', label: 'Main drivers', render: (r) => (
                <span className="cell-sub">{r.factors.filter((f) => f.points > 0).sort((a, b) => b.points - a.points).slice(0, 2).map((f) => `${f.label} (${f.points})`).join(' · ') || 'Nothing on record'}</span>
              ) },
              { key: 'go', label: '', render: (r) => <Button size="sm" as={Link} to={`/equipment/${r.equipmentId}`} tone="ghost" onClick={(e) => e.stopPropagation()}>Open</Button> },
            ]}
          />
        )}
      </Card>

      <Modal open={!!openRow} onClose={() => setOpenRow(null)} size="lg" title={openRow ? `${openRow.equipmentName} — ${openRow.levelLabel}` : ''}
        description={openRow ? `${openRow.assetTag} · score ${openRow.score}/100 (raw ${openRow.rawScore}/${openRow.rawMax}) · ${openRow.modelVersion}` : ''}
        footer={<><Button tone="ghost" onClick={() => setOpenRow(null)}>Close</Button>{openRow ? <Button as={Link} to={`/equipment/${openRow.equipmentId}`} tone="primary">Open equipment record</Button> : null}</>}>
        {openRow ? (
          <div className="stack">
            <Callout tone="safety">{openRow.disclaimer}</Callout>
            {openRow.escalation ? <Callout tone="warn" title="Band escalated">{openRow.escalation.rule} — {openRow.escalation.reason}</Callout> : null}
            <p className="form-note"><b>Advice:</b> {openRow.advice}</p>
            {openRow.factors.map((f) => (
              <div key={f.key} className="factor">
                <div className="factor__head">
                  <p className="factor__label">{f.label}</p>
                  <p className="factor__points">{f.points} / {f.maxPoints} · {f.weightPercent}% of the scale</p>
                </div>
                <p className="factor__basis">{f.basis}</p>
                <ul className="factor__list">{(f.contributing ?? []).map((c, i) => <li key={i}><span>{c}</span></li>)}</ul>
                {f.advice ? <p className="factor__advice">→ {f.advice}</p> : null}
              </div>
            ))}
            <KeyValue columns={3} items={Object.entries(openRow.inputSnapshot ?? {}).map(([k, v]) => [k.replace(/([A-Z])/g, ' $1').toLowerCase(), v ?? '—'])} />
          </div>
        ) : null}
      </Modal>
    </>
  );
}
