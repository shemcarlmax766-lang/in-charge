import { useState } from 'react';
import { Link } from 'react-router-dom';
import { notifications } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { PageHeader } from '../components/AppShell.jsx';
import { Button, Callout, Card, EmptyState, ErrorState, Loading } from '../components/ui.jsx';
import { Badge } from '../components/display.jsx';
import { useToast, errorText } from '../components/Toast.jsx';
import { useApi } from '../utils/useApi.js';
import { cx, formatDateTime, relativeTime } from '../utils/format.js';

/** The in-app notification centre — the department's durable record of what it was told. */
export function NotificationsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [filter, setFilter] = useState('all');
  const res = useApi(() => notifications.list({ unreadOnly: filter === 'unread', limit: 60 }), [filter]);
  const [open, setOpen] = useState(null);

  const markAll = async () => {
    try { await notifications.markRead([]); res.refresh(); toast.success('Marked everything as read.'); }
    catch (err) { toast.error(errorText(err)); }
  };
  const remove = async (id) => {
    try { await notifications.remove(id); res.refresh(); } catch (err) { toast.error(errorText(err)); }
  };

  return (
    <>
      <PageHeader eyebrow="Notifications" title="What the department has been told"
        description="In-app delivery is the system of record. Email/SMS/push are configured per deployment; each notification keeps a delivery row per channel, so “we did not email anyone” is provable rather than assumed."
        actions={<Button tone="secondary" onClick={markAll} disabled={!res.data?.unread}>Mark all read</Button>} />

      <div className="tabs" role="tablist" style={{ marginBottom: 'var(--sp-4)' }}>
        {[['all', 'All'], ['unread', `Unread${res.data?.unread ? ` (${res.data.unread})` : ''}`]].map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={filter === id} className={cx('tabs__item', filter === id && 'tabs__item--active')} onClick={() => setFilter(id)}>{label}</button>
        ))}
      </div>

      <Card pad={false}>
        {res.loading && !res.data ? <Loading rows={5} /> : res.error ? <div style={{ padding: 'var(--sp-4)' }}><ErrorState error={res.error} onRetry={res.refresh} /></div> : (
          (res.data?.items ?? []).length === 0
            ? <EmptyState icon="◍" title={filter === 'unread' ? 'Nothing unread' : 'No notifications yet'}
                description="You are told when a fault is assigned, when its status changes, when a repair is completed and when maintenance falls due." />
            : <ul>
                {res.data.items.map((n) => (
                  <li key={n.id} className={cx('notif', n.unread ? 'notif--unread' : 'notif--read')}>
                    <span className="notif__dot" aria-hidden="true" />
                    <div>
                      <p className="notif__title">
                        {n.link ? <Link to={n.link}>{n.title}</Link> : n.title}
                        {' '}<Badge tone={n.severity === 'critical' ? 'bad' : n.severity === 'warning' ? 'warn' : n.severity === 'success' ? 'ok' : 'neutral'} size="sm">{n.type.replace(/_/g, ' ')}</Badge>
                      </p>
                      <p className="notif__body">{n.body}</p>
                      {can('meta.manage') ? (
                        <p className="notif__meta"><button type="button" className="linklike" onClick={async () => { try { const d = await notifications.deliveries(n.id); setOpen({ id: n.id, rows: d.items }); } catch (err) { toast.error(errorText(err)); } }}>Delivery channels</button></p>
                      ) : null}
                    </div>
                    <div className="notif__meta">
                      <span title={formatDateTime(n.createdAt)}>{relativeTime(n.createdAt)}</span>
                      <button type="button" className="linklike" onClick={() => remove(n.id)}>Dismiss</button>
                    </div>
                  </li>
                ))}
              </ul>
        )}
      </Card>

      {open ? (
        <Callout tone="info" title={`Delivery for notification #${open.id}`}>
          <ul className="deliveries">
            {open.rows.map((d, i) => (
              <li key={i}><span>{d.channel}</span><span className="muted">{d.target ?? '—'} · {d.detail ?? ''}</span><Badge tone={d.status === 'sent' ? 'ok' : d.status === 'failed' ? 'bad' : 'neutral'} size="sm">{d.status}</Badge></li>
            ))}
          </ul>
        </Callout>
      ) : null}
    </>
  );
}
