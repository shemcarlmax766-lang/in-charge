import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { dashboard as dashboardApi } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { PageHeader } from '../components/AppShell.jsx';
import { Button, Callout, ErrorState, Loading, Select, Badge } from '../components/ui.jsx';
import { Card, DataTable, EquipmentStatusPill, FaultStatusPill, KeyValue, MaintenanceLight, RiskBadge, SeverityPill, Timestamp, Timeline } from '../components/display.jsx';
import { BarList, ChartFrame, DonutChart, Gauge, ShareBar, TrendChart } from '../components/charts.jsx';
import { useApi } from '../utils/useApi.js';
import { cx, formatDuration, formatHours, formatMoney, monthLabel, pluralise } from '../utils/format.js';
import { SAFETY_NOTICE } from '../utils/constants.js';

/**
 * Dashboard.  The order is the department's own order of business: what is broken and being
 * handled → what needs attention soon → how the fleet is trending → who is carrying what.
 * Charts are secondary to numbers a person can act on.
 */
export function DashboardPage() {
  const { can, is, user } = useAuth();
  const navigate = useNavigate();
  const [months, setMonths] = useState(12);
  const { data, loading, error, refresh } = useApi(() => dashboardApi.get({ chartMonths: months }), [months]);
  const kpis = data?.kpis;
  const personal = data?.scope === 'personal';

  const kpiItems = useMemo(() => {
    if (!kpis) return [];
    const common = [
      { label: 'Total equipment', value: kpis.totalEquipment, hint: `${kpis.totalIncludingDecommissioned - kpis.totalEquipment ?? 0} archived/decommissioned`, tone: 'info', to: '/equipment' },
      { label: 'Operational', value: kpis.operational, hint: `${kpis.fleetAvailabilityPercent}% of the live fleet`, tone: 'ok', to: '/equipment?status=operational' },
      { label: 'Faulty / unusable', value: kpis.faulty + kpis.underRepair + kpis.outOfService, hint: `${kpis.faulty} reported · ${kpis.underRepair} in repair · ${kpis.outOfService} out of service`, tone: 'bad', to: '/equipment?needsAttention=1' },
      { label: 'Open fault reports', value: kpis.openFaults, hint: `${kpis.unassignedFaults} not yet assigned`, tone: 'warn', to: personal ? '/my-reports' : '/faults?scope=open' },
      { label: 'Critical faults', value: kpis.criticalFaults, hint: kpis.slaBreachedFaults ? `${kpis.slaBreachedFaults} past the response target` : 'within response target', tone: kpis.criticalFaults ? 'bad' : 'ok', to: '/faults?severity=critical' },
      { label: 'Maintenance overdue', value: kpis.maintenanceOverdue, hint: `${kpis.maintenanceDueSoon} due within 14 days`, tone: kpis.maintenanceOverdue ? 'bad' : 'ok', to: '/maintenance?tab=due' },
    ];
    if (!personal) {
      common.push(
        { label: 'Average repair time', value: formatHours(kpis.averageRepairHours).replace(/ /g, ' '), hint: `${pluralise(kpis.resolvedIn180Days, 'fault')} resolved in 180 days`, tone: 'info' },
        { label: 'Repair cost this year', value: formatMoney(kpis.repairCostYtd, kpis.currency), hint: `${pluralise(kpis.repairCountYtd, 'repair')} recorded`, tone: 'neutral' },
      );
    }
    return common;
  }, [kpis, personal]);

  return (
    <>
      <PageHeader
        eyebrow={new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
        title={personal ? `Good ${greeting()}, ${user?.fullName?.split(' ')[0]}` : 'Department status'}
        description={personal
          ? 'Your submitted reports and the equipment you interact with. Fault details are open to the whole department.'
          : 'Everything the department needs to answer “what do we have, is it working, who is fixing it, when is service due?”'}
        actions={(
          <>
            <Button as={Link} to="/faults/new" tone="primary">＋ Report a fault</Button>
            {can('equipment.create') ? <Button as={Link} to="/equipment/new" tone="secondary">＋ Add equipment</Button> : null}
          </>
        )}
      />

      {error ? <ErrorState error={error} onRetry={refresh} /> : null}

      {loading && !data ? <Loading rows={6} label="Loading the department dashboard" /> : (
        <>
          <div className="grid grid--kpi" style={{ marginBottom: 'var(--sp-5)' }}>
            {kpiItems.map((k) => (
              <Kpi key={k.label} {...k} />
            ))}
          </div>

          {personal && kpis?.slaBreachedFaults ? (
            <Callout tone="warn" title="One or more of your reports is past the department response target" >
              The technicians have been reminded. If the equipment is unsafe to use rather than merely
              faulty, tell the department desk directly as well — this system does not replace that call.
            </Callout>
          ) : null}

          <div className="grid grid--2" style={{ marginBottom: 'var(--sp-4)' }}>
            <Card title="Equipment status" subtitle="Every active item by current state">
              <div className="row" style={{ alignItems: 'center', gap: 'var(--sp-5)' }}>
                <DonutChart
                  slices={data.equipmentByStatus.map((s) => ({ label: s.label, value: s.count, tone: s.tone }))}
                  centerValue={data.equipmentByStatus.reduce((n, s) => n + s.count, 0)}
                  centerLabel="items"
                />
                <div style={{ flex: '1 1 200px', minWidth: 190 }}>
                  <BarList
                    items={data.equipmentByStatus.filter((s) => s.count > 0).map((s) => ({ label: s.label, value: s.count, tone: s.tone, to: `/equipment?status=${s.status}` }))}
                    onPick={(item) => navigate(item.to ?? '/equipment')}
                  />
                </div>
              </div>
            </Card>

            <Card
              title="Faults by category"
              subtitle={`Reported in the last 12 months${personal ? ' by you' : ''}`}
              actions={<Badge tone="neutral">{data.faultsByCategory.reduce((n, c) => n + c.count, 0)} total</Badge>}
            >
              <BarList
                items={data.faultsByCategory.filter((c) => c.count > 0).map((c) => ({ label: c.label, value: c.count, tone: c.criticalCount ? 'bad' : 'primary', critical: c.criticalCount }))}
                onPick={(item) => navigate(`/faults?categoryId=${item.id}`)}
              />
              {data.faultsByCategory.every((c) => !c.count) ? <p className="form-note">No fault reports in this window.</p> : null}
            </Card>
          </div>

          <div className="grid grid--2" style={{ marginBottom: 'var(--sp-4)' }}>
            <Card
              title="Fault volume by month"
              subtitle="Bars are reports; the dot marks months containing a critical fault"
              actions={<Select value={months} onChange={(e) => setMonths(Number(e.target.value))} aria-label="Chart range" options={[6, 12, 18, 24].map((n) => ({ value: n, label: `${n} months` }))} />}
            >
              <ChartFrame
                title={null}
                tableData={{ columns: ['Month', 'Reported', 'Resolved', 'Critical'], rows: data.faultsByMonth.map((m) => [m.month, m.reported, m.resolved, m.critical]) }}
              >
                <TrendChart data={data.faultsByMonth} formatLabel={monthLabel} series={[{ key: 'reported', label: 'Reported', tone: 'primary' }, { key: 'resolved', label: 'Resolved', tone: 'ok' }]} />
              </ChartFrame>
              <div className="chart__legend" style={{ marginTop: 6 }}>
                <span><i style={{ background: 'var(--primary)' }} /> Reported</span>
                <span><i style={{ background: 'var(--ok)' }} /> Resolved</span>
                <span><i style={{ background: 'var(--bad)', borderRadius: 9 }} /> month with critical faults</span>
              </div>
            </Card>

            <Card title="Preventive maintenance" subtitle={`Compliance over the last ${data.maintenanceCompliance.windowDays} days`}>
              <div className="row" style={{ alignItems: 'center', gap: 'var(--sp-5)' }}>
                <Gauge
                  value={data.maintenanceCompliance.fleetCompliancePercent}
                  tone={data.maintenanceCompliance.fleetCompliancePercent > 90 ? 'ok' : data.maintenanceCompliance.fleetCompliancePercent > 75 ? 'warn' : 'bad'}
                  label="Fleet not overdue"
                  caption={data.maintenanceCompliance.onTimePercent === null ? 'No PM records in the window yet' : `${data.maintenanceCompliance.recordsOnTime}/${data.maintenanceCompliance.recordsDone} visits on time`}
                  segments={[
                    { label: 'up to date', value: data.maintenanceCompliance.upToDateEquipment, tone: 'ok' },
                    { label: 'due soon', value: data.maintenanceCompliance.dueSoonEquipment, tone: 'warn' },
                    { label: 'overdue', value: data.maintenanceCompliance.overdueEquipment, tone: 'bad' },
                  ]}
                />
                <div style={{ flex: '1 1 200px', minWidth: 200 }}>
                  <KeyValue columns={1} items={[
                    ['Average lateness', data.maintenanceCompliance.averageLatenessDays !== null ? `${data.maintenanceCompliance.averageLatenessDays} days` : '—'],
                    ['Worst lateness', `${data.maintenanceCompliance.worstLatenessDays} days`],
                    ['Items with no schedule', `${data.maintenanceCompliance.unscheduledEquipment} — these are the blind spots`],
                  ]} />
                  <Button as={Link} to="/maintenance?tab=due" tone="secondary" size="sm" style={{ marginTop: 10 }}>Open the due board</Button>
                </div>
              </div>
            </Card>
          </div>

          <div className="grid grid--split" style={{ gap: 'var(--sp-4)' }}>
            <div className="grid" style={{ gap: 'var(--sp-4)' }}>
              <Card
                title="Most frequently failing equipment"
                subtitle={personal ? 'Ranked by reports in the last two years' : 'Ranked by reports in the last two years, worst first'}
                actions={<Button as={Link} to="/risk" tone="ghost" size="sm">Risk register →</Button>}
              >
                {data.topFailingEquipment.length === 0
                  ? <p className="form-note">No repeat offenders. Either the fleet is healthy or reporting needs encouraging.</p>
                  : (
                    <DataTable
                      dense
                      columns={[
                        { key: 'name', label: 'Equipment', render: (r) => (
                          <div className="cell-main">
                            <Link className="cell-title" to={`/equipment/${r.id}`}>{r.name}</Link>
                            <span className="cell-sub">{r.assetTag} · {r.categoryName ?? '—'}{r.locationName ? ` · ${r.locationName}` : ''}</span>
                          </div>
                        ) },
                        { key: 'faultCount', label: 'Faults', align: 'center', render: (r) => <b>{r.faultCount}</b> },
                        { key: 'criticalCount', label: 'Critical', align: 'center', render: (r) => (r.criticalCount ? <Badge tone="bad">{r.criticalCount}</Badge> : <span className="muted">0</span>) },
                        { key: 'daysSinceFault', label: 'Last fault', align: 'right', render: (r) => (r.daysSinceFault === null ? '—' : r.daysSinceFault <= 1 ? 'today' : `${r.daysSinceFault} d ago`) },
                      ]}
                      rows={data.topFailingEquipment}
                    />
                  )}
              </Card>

              {can('dashboard.view') && data.technicianWorkload.length ? (
                <Card title="Workload" subtitle="Open faults per technician, last 90 days of activity" className="print-only-none">
                  <ShareBar
                    parts={data.technicianWorkload.map((t) => ({ label: t.fullName.split(' ').slice(-1)[0], value: t.openCount, tone: t.openCount > 6 ? 'bad' : t.openCount > 3 ? 'warn' : 'ok' }))}
                  />
                  <DataTable
                    dense
                    rows={data.technicianWorkload}
                    columns={[
                      { key: 'fullName', label: 'Technician', render: (t) => (
                        <div className="cell-main"><span className="cell-title">{t.fullName}</span><span className="cell-sub">{t.jobTitle ?? ''}</span></div>
                      ) },
                      { key: 'openCount', label: 'Open', align: 'center', render: (t) => <b>{t.openCount}</b> },
                      { key: 'criticalCount', label: 'Critical', align: 'center', render: (t) => (t.criticalCount ? <Badge tone="bad">{t.criticalCount}</Badge> : <span className="muted">0</span>) },
                      { key: 'avgRepairHours', label: 'Avg repair', align: 'right', render: (t) => formatHours(t.avgRepairHours) },
                    ]}
                  />
                </Card>
              ) : null}
            </div>

            <div className="grid" style={{ gap: 'var(--sp-4)' }}>
              <Card
                title="Highest maintenance risk"
                subtitle="Rule-based indicator from this department's own history"
                actions={<Button as={Link} to="/risk" tone="ghost" size="sm">All</Button>}
              >
                <div className="stack" style={{ gap: 'var(--sp-3)' }}>
                  {(data.risk?.top ?? []).map((r) => (
                    <Link key={r.equipmentId} to={`/equipment/${r.equipmentId}`} className="listrow listrow--link" style={{ border: '1px solid var(--line)', borderRadius: 'var(--radius)', padding: '10px' }}>
                      <RiskBadge level={r.level} score={r.score} />
                      <span className="listrow__main">
                        <span className="listrow__title">{r.equipmentName}</span>
                        <span className="listrow__sub">{r.assetTag} · {r.inputSnapshot?.faultsIn12Months ?? 0} faults/12 mo · next PM {r.inputSnapshot?.nextMaintenanceOn ?? 'not scheduled'}</span>
                      </span>
                    </Link>
                  ))}
                  {!(data.risk?.top ?? []).length ? <p className="form-note">No active equipment to assess.</p> : null}
                </div>
                <p className="chart__foot" style={{ marginTop: 10 }}>{SAFETY_NOTICE}</p>
              </Card>

              <Card title="Recent activity" subtitle="Every status change in the workflow, newest first">
                <Timeline
                  items={data.recentActivity.map((a) => ({
                    id: a.id,
                    title: <>{a.fromStatus && a.fromStatus !== a.toStatus
                      ? <>moved {a.reference} to <FaultStatusPill status={a.toStatus} size="sm" /></>
                      : <>commented on {a.reference}</>}</>,
                    detail: a.comment,
                    actor: a.actorName,
                    meta: `${a.equipmentName} (${a.assetTag})`,
                    at: a.changedAt,
                    tone: a.severity === 'critical' ? 'bad' : null,
                  }))}
                />
              </Card>

              {data.recentMaintenance.length ? (
                <Card title="Recent maintenance" subtitle="Signed-off preventive visits">
                  <div className="stack" style={{ gap: 10 }}>
                    {data.recentMaintenance.slice(0, 5).map((m) => (
                      <div key={m.id} className="row row--between" style={{ gap: 8 }}>
                        <div style={{ minWidth: 0 }}>
                          <Link to={`/equipment/${m.equipmentId ?? ''}`} className="cell-title">{m.equipmentName}</Link>
                          <p className="cell-sub">{m.scheduleTitle ?? 'Ad-hoc'} · {m.performedByName}</p>
                        </div>
                        <Badge tone={m.conditionFound === 'pass' ? 'ok' : m.conditionFound === 'needs_attention' ? 'warn' : 'info'}>
                          {m.conditionFound?.replace(/_/g, ' ')}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </Card>
              ) : null}
            </div>
          </div>
        </>
      )}
    </>
  );
}

function Kpi({ label, value, hint, tone, to }) {
  const Body = (
    <>
      <p className="kpi__label">{label}</p>
      <p className="kpi__value">{value ?? '—'}</p>
      {hint ? <p className="kpi__hint">{hint}</p> : null}
    </>
  );
  const cls = cx('kpi', `kpi--${tone ?? 'neutral'}`, (tone === 'bad' && Number(value)) && 'kpi--alert');
  return to ? <Link to={to} className={cls}>{Body}</Link> : <div className={cls}>{Body}</div>;
}

const greeting = () => {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
};
