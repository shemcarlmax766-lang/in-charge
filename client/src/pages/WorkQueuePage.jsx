import { useState } from 'react';
import { Link } from 'react-router-dom';
import { faults as faultsApi, maintenance as maintenanceApi } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { PageHeader } from '../components/AppShell.jsx';
import { Badge, Card, DataTable, EmptyState, ErrorState, Loading, Modal, Field, TextArea, Button, Tabs } from '../components/ui.jsx';
import { FaultStatusPill, MaintenanceLight, SeverityPill } from '../components/display.jsx';
import { useToast, errorText } from '../components/Toast.jsx';
import { useApi } from '../utils/useApi.js';
import { formatDuration, relativeTime } from '../utils/format.js';

/**
 * The technician's working screen: what is mine, what nobody has taken, what is stuck, and
 * what needs a PM.  Quick actions are the two that unblock the board (claim, acknowledge);
 * everything else opens the report.
 */
export function WorkQueuePage() {
  const { user } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState('mine');
  const [claiming, setClaiming] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const mine = useApi(() => faultsApi.list({ scope: 'assigned', perPage: 50, sort: 'severity', dir: 'asc' }), []);
  const unassigned = useApi(() => faultsApi.list({ scope: 'unassigned', perPage: 50, sort: 'severity', dir: 'asc' }), []);
  const board = useApi(() => maintenanceApi.dueBoard({ days: 45 }), []);
  const rows = (tab === 'mine' ? mine.data?.rows : tab === 'unassigned' ? unassigned.data?.rows : []) ?? [];

  const act = async (fault, target, comment) => {
    setBusy(true);
    try {
      await faultsApi.transition(fault.id, target, comment);
      toast.success(`Marked ${target.replace(/_/g, ' ')}.`);
      setClaiming(null); setNote('');
      mine.refresh(); unassigned.refresh();
    } catch (err) { toast.error(errorText(err)); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader
        eyebrow="Technicians"
        title="Work queue"
        description={`Open faults by response urgency, plus the maintenance that is due. Sorted so the worst-waiting thing is at the top.`}
        actions={<Button as={Link} to="/faults/new" tone="danger">＋ Log a fault</Button>}
      />

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'mine', label: 'Assigned to me', count: mine.data?.pagination?.total ?? null },
          { id: 'unassigned', label: 'Unclaimed', count: unassigned.data?.pagination?.total ?? null },
          { id: 'pm', label: 'Maintenance due', count: board.data?.items?.length ?? null },
        ]}
      />

      <div className="tabpanel">
        {tab === 'pm' ? (
          <Card title="Preventive maintenance due" subtitle="Overdue first, then the next 45 days" pad={false}>
            {board.loading ? <Loading rows={4} /> : (board.data?.items ?? []).length === 0
              ? <EmptyState icon="🟢" title="Nothing due" description="Every scheduled item on the fleet is inside its interval." />
              : (
                <DataTable
                  dense
                  rows={board.data?.items ?? []}
                  columns={[
                    { key: 'equipmentName', label: 'Equipment', render: (r) => (<div className="cell-main"><Link className="cell-title" to={`/equipment/${r.equipmentId}`}>{r.equipmentName}</Link><span className="cell-sub">{r.assetTag} · {r.locationName ?? '—'}</span></div>) },
                    { key: 'nextScheduleTitle', label: 'Schedule', render: (r) => r.nextScheduleTitle ?? <span className="muted">Ad-hoc date only</span> },
                    { key: 'nextMaintenanceOn', label: 'Due', render: (r) => r.nextMaintenanceOn ?? '—' },
                    { key: 'pmState', label: 'State', render: (r) => <MaintenanceLight state={r.pmState.state} label={r.pmState.label} /> },
                    { key: 'responsibleTechnicianName', label: 'Owner', render: (r) => r.responsibleTechnicianName ?? <Badge tone="warn" size="sm">unassigned</Badge> },
                    { key: 'go', label: '', render: (r) => <Button size="sm" as={Link} to={`/maintenance?tab=schedules&equipment=${r.equipmentId}`}>Open</Button> },
                  ]}
                />
              )}
          </Card>
        ) : (
          <Card pad={false} title={tab === 'mine' ? 'Your open faults' : 'Waiting for an owner'}
            subtitle={tab === 'mine' ? 'Oldest critical first' : 'Claiming one makes you the responsible technician and starts the clock'}>
            {(tab === 'mine' ? mine.loading : unassigned.loading) ? <Loading rows={4} /> : (
              <div className="stack" style={{ padding: 'var(--sp-4)' }}>
                {rows.length === 0 && <EmptyState icon="✓" title={tab === 'mine' ? 'Your queue is clear' : 'Nothing is unclaimed'} description={tab === 'mine' ? 'Nice work. Verify anything waiting on a user to close it out.' : 'Every open report has someone responsible for it.'} />}
                {rows.map((f) => (
                  <article key={f.id} className="workrow">
                    <div className="workrow__main">
                      <div className="row row--tight" style={{ gap: 6, flexWrap: 'wrap' }}>
                        <SeverityPill severity={f.severity} />
                        <FaultStatusPill status={f.status} />
                        {f.isOverdue ? <Badge tone="bad">⏱ {formatDuration(f.minutesOverdue)} past target</Badge> : f.dueAt ? <Badge tone="neutral">target {relativeTime(f.dueAt)}</Badge> : null}
                      </div>
                      <Link to={`/faults/${f.id}`} className="workrow__title">{f.title}</Link>
                      <p className="cell-sub">
                        <code>{f.reference}</code> · {f.equipmentName} ({f.assetTag}){f.locationName ? ` · ${f.locationName}` : ''} · reported {relativeTime(f.createdAt)} by {f.reportedByName}
                      </p>
                    </div>
                    <div className="workrow__actions">
                      {tab === 'unassigned' ? (
                        <>
                          <Button size="sm" tone="primary" onClick={() => act(f, 'under_inspection', 'Claimed from the board')}>Claim &amp; inspect</Button>
                          <Button size="sm" tone="ghost" onClick={() => { setClaiming(f); setNote(''); }}>With a note…</Button>
                        </>
                      ) : f.status === 'assigned' ? (
                        <Button size="sm" tone="primary" onClick={() => act(f, 'acknowledged')}>Acknowledge</Button>
                      ) : f.status === 'acknowledged' || f.status === 'under_inspection' ? (
                        <Button size="sm" tone="primary" as={Link} to={`/faults/${f.id}`}>Open &amp; work</Button>
                      ) : (
                        <Button size="sm" tone="secondary" as={Link} to={`/faults/${f.id}`}>Open</Button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </Card>
        )}
      </div>

      <Modal
        open={!!claiming}
        onClose={() => setClaiming(null)}
        title="Claim this fault"
        description={claiming ? `${claiming.reference} — ${claiming.title}` : ''}
        footer={<><Button tone="ghost" onClick={() => setClaiming(null)}>Cancel</Button><Button tone="primary" loading={busy} onClick={() => act(claiming, 'under_inspection', note || undefined)}>Claim and start inspecting</Button></>}
      >
        <Field label="Note for the reporter (optional)" hint="Say when you expect to look at it; that is usually all they want.">
          <TextArea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="I will test it tomorrow morning during the lab session." />
        </Field>
      </Modal>
    </>
  );
}
