import { Link } from 'react-router-dom';
import { cx, formatDateTime, formatDate, formatMoney, relativeTime } from '../utils/format.js';
import { EQUIPMENT_STATUS, FAULT_STATUS, SEVERITY, MAINTENANCE_STATE, RISK_LEVEL, CRITICALITY } from '../utils/constants.js';

/** Read-only display primitives: status is always a colour *and* a word, never colour alone. */

export function Badge({ tone = 'neutral', children, dot, size = 'md', className, title }) {
  return (
    <span className={cx('badge', `badge--${tone}`, `badge--${size}`, className)} title={title}>
      {dot ? <span className="badge__dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

export function EquipmentStatusPill({ status, size = 'md' }) {
  const meta = EQUIPMENT_STATUS[status] ?? { label: status ?? 'Unknown', tone: 'neutral' };
  return (
    <Badge tone={meta.tone} dot size={size} title={meta.hint}>
      {meta.label}
    </Badge>
  );
}

export function FaultStatusPill({ status, size = 'md' }) {
  const meta = FAULT_STATUS[status] ?? { label: status, tone: 'neutral' };
  return <Badge tone={meta.tone} size={size}>{meta.label}</Badge>;
}

export function SeverityPill({ severity, size = 'md', showHint = false }) {
  const meta = SEVERITY[severity] ?? { label: severity, tone: 'neutral' };
  return (
    <Badge tone={meta.tone} dot size={size} title={showHint ? undefined : meta.hint}>
      {meta.label}
      {showHint ? <span className="sev-hint">{meta.hint}</span> : null}
    </Badge>
  );
}

export function MaintenanceLight({ state, daysUntil, label, size = 'md' }) {
  const meta = MAINTENANCE_STATE[state] ?? MAINTENANCE_STATE.not_scheduled;
  return (
    <span className={cx('pm-light', `pm-light--${meta.tone}`, `pm-light--${size}`)} title={label ?? meta.label}>
      <span className="pm-light__icon" aria-hidden="true">{meta.light}</span>
      <span className="pm-light__text">{label ?? meta.label}</span>
      {daysUntil !== undefined && daysUntil !== null && state !== 'not_scheduled' ? (
        <span className="pm-light__num">{daysUntil < 0 ? `${Math.abs(daysUntil)} d late` : `${daysUntil} d left`}</span>
      ) : null}
    </span>
  );
}

export function RiskBadge({ level, score, size = 'md' }) {
  const meta = RISK_LEVEL[level] ?? { label: 'Not assessed', tone: 'neutral' };
  return (
    <span className={cx('risk', `risk--${meta.tone}`, `risk--${size}`)}>
      <RiskDial score={score} level={level} size={size === 'lg' ? 62 : 34} />
      <span className="risk__text">
        <span className="risk__level">{meta.label}</span>
        {score !== null && score !== undefined ? <span className="risk__score">{score}/100</span> : null}
      </span>
    </span>
  );
}

export function RiskDial({ score, level, size = 40 }) {
  const value = Math.max(0, Math.min(100, Number(score ?? 0)));
  const r = size / 2 - 3;
  const c = 2 * Math.PI * r;
  const tone = level === 'high' ? 'bad' : level === 'moderate' ? 'warn' : 'ok';
  return (
    <svg className={cx('dial', `dial--${tone}`)} width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img"
      aria-label={`Maintenance risk score ${value} out of 100, ${level ?? 'unknown'} risk`}>
      <circle cx={size / 2} cy={size / 2} r={r} className="dial__track" strokeWidth="4" fill="none" />
      <circle
        cx={size / 2} cy={size / 2} r={r} className="dial__value" strokeWidth="4" fill="none" strokeLinecap="round"
        strokeDasharray={`${(value / 100) * c} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="52%" dominantBaseline="middle" textAnchor="middle" className="dial__num">{Math.round(value)}</text>
    </svg>
  );
}

export function CriticalityTag({ value }) {
  const meta = CRITICALITY[value] ?? { label: value, hint: '' };
  if (!value) return <span className="muted">—</span>;
  return (
    <span className={cx('crit', `crit--${value}`)} title={meta.hint}>
      {value === 'life_support' ? <span aria-hidden="true">✚</span> : null}
      {meta.label}
    </span>
  );
}

export function Card({ title, subtitle, actions, children, className, pad = true, as: Tag = 'section', footer }) {
  return (
    <Tag className={cx('card', className)}>
      {title || actions ? (
        <header className="card__head">
          <div className="card__heading">
            {title ? <h2 className="card__title">{title}</h2> : null}
            {subtitle ? <p className="card__subtitle">{subtitle}</p> : null}
          </div>
          {actions ? <div className="card__actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cx('card__body', !pad && 'card__body--flush')}>{children}</div>
      {footer ? <footer className="card__foot">{footer}</footer> : null}
    </Tag>
  );
}

export function KeyValue({ items, columns = 2, className }) {
  return (
    <dl className={cx('kv', `kv--${columns}`, className)}>
      {items.filter(Boolean).map(([label, value, opts = {}]) => (
        <div key={label} className={cx('kv__item', opts.wide && 'kv__item--wide')}>
          <dt>{label}</dt>
          <dd className={opts.mono ? 'mono' : undefined}>{value === null || value === undefined || value === '' ? <span className="muted">Not recorded</span> : value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function DataTable({ columns, rows, keyOf = (r, i) => r.id ?? i, onRowClick, loading, empty, className, dense, footer, caption }) {
  if (loading) {
    return (
      <div className="table-skeleton" role="status" aria-live="polite">
        <span className="sr-only">Loading table</span>
        {Array.from({ length: 5 }).map((_, i) => <div key={i} className="skeleton skeleton--row" style={{ width: `${96 - i * 7}%` }} />)}
      </div>
    );
  }
  if (!rows?.length) return empty ?? null;
  return (
    <div className={cx('table-wrap', dense && 'table-wrap--dense', className)}>
      <table className="table">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cx(c.align && `is-${c.align}`, c.sortable && 'is-sortable')} style={c.width ? { width: c.width } : undefined}>
                {c.sortable && c.onSort ? (
                  <button type="button" className="th-sort" onClick={() => c.onSort(c.key)} aria-label={`Sort by ${c.label}`}>
                    {c.label} <span aria-hidden="true">{c.dir === 'asc' ? '▲' : c.dir === 'desc' ? '▼' : '↕'}</span>
                  </button>
                ) : c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={keyOf(row, i)}
              className={cx(onRowClick && 'is-clickable', row.rowClassName)}
              onClick={onRowClick ? (e) => { if (!e.target.closest('a,button')) onRowClick(row); } : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter') onRowClick(row); } : undefined}
            >
              {columns.map((c) => (
                <td key={c.key} className={cx(c.align && `is-${c.align}`, c.mono && 'mono')} data-label={c.label}>
                  {c.render ? c.render(row, i) : row[c.key] ?? <span className="muted">—</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer ? <tfoot>{footer}</tfoot> : null}
      </table>
    </div>
  );
}

/** Card list used instead of a table below ~720px, where tables become unreadable. */
export function CardList({ items, render, className }) {
  return <ul className={cx('cardlist', className)}>{items.map((item, i) => <li key={item.id ?? i}>{render(item, i)}</li>)}</ul>;
}

export function Timestamp({ value, prefix, withSeconds }) {
  if (!value) return <span className="muted">—</span>;
  return (
    <time dateTime={value} title={formatDateTime(value, { withSeconds })}>
      {prefix ? `${prefix} ` : ''}{relativeTime(value)}
    </time>
  );
}

export function Money({ amount, currency }) {
  if (amount === null || amount === undefined) return <span className="muted">—</span>;
  return <span className="mono">{formatMoney(amount, currency)}</span>;
}

export function Linkify({ to, children, ...rest }) {
  if (!to) return <>{children}</>;
  if (/^https?:/i.test(to)) return <a href={to} target="_blank" rel="noreferrer noopener" {...rest}>{children}</a>;
  return <Link to={to} {...rest}>{children}</Link>;
}

export function ProgressBar({ value, max = 100, tone = 'primary', label, showValue = true, height = 8 }) {
  const pct = Math.max(0, Math.min(100, (Number(value) / Number(max || 1)) * 100));
  return (
    <div className="pbar" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className="pbar__track" style={{ height }}>
        <div className={`pbar__fill pbar__fill--${tone}`} style={{ width: `${pct}%` }} />
      </div>
      {showValue ? <span className="pbar__num">{Math.round(pct)}%</span> : null}
    </div>
  );
}

export function Timeline({ items, className }) {
  return (
    <ol className={cx('timeline', className)}>
      {items.map((item, i) => (
        <li key={item.id ?? i} className={cx('timeline__item', item.tone && `timeline__item--${item.tone}`, item.isNote && 'timeline__item--note')}>
          <span className="timeline__marker" aria-hidden="true">{item.icon ?? '●'}</span>
          <div className="timeline__body">
            <p className="timeline__title">
              {item.title}
              {item.actor ? <span className="timeline__actor"> · {item.actor}</span> : null}
            </p>
            {item.detail ? <p className="timeline__detail">{item.detail}</p> : null}
            {item.meta ? <p className="timeline__meta">{item.meta}</p> : null}
          </div>
          <time className="timeline__time" dateTime={item.at} title={formatDateTime(item.at, { withSeconds: true })}>
            {formatDateTime(item.at)}
          </time>
        </li>
      ))}
    </ol>
  );
}

export { formatDate };
