
import { cx } from '../utils/format.js';

/**
 * Dependency-free charts (SVG + a little maths).
 *
 * A chart here is a *presentation of a table the user can already read*: each one carries a
 * visually-hidden data list and an `aria-label` summary, so the dashboard conveys the same
 * information with CSS off, on a screen reader, or printed in grey.  Deliberately no charting
 * library — a fleet this size needs bars and a donut, not 400 KB of canvas.
 */

const TONE_COLOR = { ok: 'var(--ok)', warn: 'var(--warn)', bad: 'var(--bad)', info: 'var(--info)', neutral: 'var(--slate)', primary: 'var(--primary)' };
const SERIES_COLORS = ['var(--primary)', 'var(--teal)', 'var(--warn)', 'var(--bad)', 'var(--violet)'];

export function ChartFrame({ title, subtitle, legend, children, footnote, className, tableData }) {
  return (
    <figure className={cx('chart', className)}>
      <figcaption className="chart__cap">
        <div>
          <p className="chart__title">{title}</p>
          {subtitle ? <p className="chart__sub">{subtitle}</p> : null}
        </div>
        {legend ? <ul className="chart__legend">{legend.map((l) => (
          <li key={l.label}><i style={{ background: l.color ?? 'currentColor' }} aria-hidden="true" />{l.label}{l.value !== undefined ? <b>{l.value}</b> : null}</li>
        ))}</ul> : null}
      </figcaption>
      <div className="chart__plot">{children}</div>
      {footnote ? <p className="chart__foot">{footnote}</p> : null}
      {tableData ? (
        <table className="sr-only">
          <thead><tr>{tableData.columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
          <tbody>{tableData.rows.map((r, i) => <tr key={i}>{r.map((cell, j) => <td key={j}>{String(cell)}</td>)}</tr>)}</tbody>
        </table>
      ) : null}
    </figure>
  );
}

/** Horizontal bars: the most legible shape for category comparisons on a narrow screen. */
export function BarList({ items, valueSuffix = '', max, onPick, className, toneBy = () => 'primary' }) {
  const top = max ?? Math.max(1, ...items.map((i) => Number(i.value) || 0));
  return (
    <ul className={cx('barlist', className)}>
      {items.map((item) => {
        const pct = Math.round(((Number(item.value) || 0) / top) * 100);
        const Row = onPick ? 'button' : 'div';
        return (
          <li key={item.label}>
            <Row
              {...(onPick ? { type: 'button', onClick: () => onPick(item) } : {})}
              className={cx('barlist__row', onPick && 'barlist__row--link')}
            >
              <span className="barlist__label" title={item.fullLabel ?? item.label}>{item.label}</span>
              <span className="barlist__track">
                <span className="barlist__fill" style={{ width: `${Math.max(pct, item.value ? 3 : 0)}%`, background: TONE_COLOR[toneBy(item)] ?? toneBy(item) }} />
              </span>
              <span className="barlist__value">{item.value}{valueSuffix}</span>
            </Row>
          </li>
        );
      })}
    </ul>
  );
}

export function DonutChart({ slices, size = 168, thickness = 26, centerLabel, centerValue, className }) {
  const total = slices.reduce((n, s) => n + (Number(s.value) || 0), 0);
  const radius = size / 2 - thickness / 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const arcs = slices.map((s) => {
    const fraction = total ? (Number(s.value) || 0) / total : 0;
    const dash = fraction * circumference;
    const arc = { ...s, dash, offset, fraction };
    offset += dash;
    return arc;
  });
  return (
    <div className={cx('donut', className)}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img"
        aria-label={`${total} items across ${slices.length} categories: ${slices.map((s) => `${s.label} ${s.value}`).join(', ')}`}>
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--line)" strokeWidth={thickness} />
          {total > 0 && arcs.map((a) => (
            <circle
              key={a.label}
              className="donut__arc"
              cx={size / 2} cy={size / 2} r={radius} fill="none"
              stroke={TONE_COLOR[a.tone] ?? a.color ?? 'var(--primary)'}
              strokeWidth={thickness}
              strokeDasharray={`${a.dash} ${circumference - a.dash}`}
              strokeDashoffset={-a.offset}
              strokeLinecap="butt"
            >
              <title>{`${a.label}: ${a.value} (${Math.round(a.fraction * 100)}%)`}</title>
            </circle>
          ))}
        </g>
        <text x="50%" y="47%" textAnchor="middle" className="donut__num">{centerValue ?? total}</text>
        <text x="50%" y="61%" textAnchor="middle" className="donut__cap">{centerLabel ?? 'total'}</text>
      </svg>
    </div>
  );
}

/** Grouped monthly bars (reported vs resolved), with a critical overlay. */
export function TrendChart({ data, series = [{ key: 'reported', label: 'Reported', tone: 'primary' }, { key: 'resolved', label: 'Resolved', tone: 'ok' }], height = 190, formatLabel = (l) => l, className }) {
  const max = Math.max(1, ...data.flatMap((d) => series.map((s) => Number(d[s.key]) || 0)));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f)).reverse();
  const barGroupWidth = 100 / Math.max(1, data.length);
  return (
    <div className={cx('trend', className)}>
      <svg viewBox="0 0 100 56" preserveAspectRatio="none" className="trend__svg" role="img"
        aria-label={`Monthly fault volume over ${data.length} months. ${data.map((d) => `${d.month}: ${d.reported ?? 0} reported`).join('; ')}`}>
        {ticks.slice(0, -1).map((_, i) => (
          <line key={i} x1="0" x2="100" y1={4 + i * (44 / (ticks.length - 1))} y2={4 + i * (44 / (ticks.length - 1))} className="trend__grid" strokeWidth="0.2" vectorEffect="non-scaling-stroke" />
        ))}
        {data.map((d, di) => (
          <g key={d.month}>
            {series.map((s, si) => {
              const value = Number(d[s.key]) || 0;
              const h = (value / max) * 42;
              const w = Math.min(3.4, (barGroupWidth * 0.62) / series.length);
              const x = di * barGroupWidth + barGroupWidth / 2 - (series.length * w) / 2 + si * w;
              return (
                <g key={s.key}>
                  <rect x={x} y={48 - h} width={w * 0.86} height={Math.max(h, value ? 0.6 : 0)} rx="0.4"
                    fill={TONE_COLOR[s.tone] ?? SERIES_COLORS[si % SERIES_COLORS.length]}>
                    <title>{`${formatLabel(d.month)} — ${s.label}: ${value}`}</title>
                  </rect>
                </g>
              );
            })}
            {Number(d.critical) > 0 ? (
              <circle cx={di * barGroupWidth + barGroupWidth / 2} cy={3.2} r={0.9} fill="var(--bad)">
                <title>{`${formatLabel(d.month)} — ${d.critical} critical fault(s)`}</title>
              </circle>
            ) : null}
          </g>
        ))}
        <line x1="0" x2="100" y1="48" y2="48" className="trend__axis" strokeWidth="0.3" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="trend__ticks" aria-hidden="true">{ticks.map((t, i) => <span key={i}>{t}</span>)}</div>
      <div className="trend__x">
        {data.map((d) => <span key={d.month} title={d.month}>{formatLabel(d.month)}</span>)}
      </div>
    </div>
  );
}

/** Compliance donut + the raw counts, because a ring alone hides "based on 3 records". */
export function Gauge({ value, label, segments = [], size = 150, tone = 'ok', caption }) {
  const pct = Math.max(0, Math.min(100, Number(value) || 0));
  const r = size / 2 - 10;
  const c = Math.PI * r; // half circle
  return (
    <div className="gauge">
      <svg width={size} height={size * 0.62} viewBox={`0 0 ${size} ${size * 0.62}`} role="img" aria-label={`${label}: ${Math.round(pct)} percent`}>
        <path d={describeArc(size / 2, size * 0.52, r, -90, 90)} className="gauge__track" fill="none" strokeWidth="12" strokeLinecap="round" />
        <path d={describeArc(size / 2, size * 0.52, r, -90, -90 + (pct / 100) * 180)} className={`gauge__value gauge__value--${tone}`} fill="none" strokeWidth="12" strokeLinecap="round" />
        <text x="50%" y="72%" textAnchor="middle" className="gauge__num">{Math.round(pct)}%</text>
      </svg>
      <p className="gauge__label">{label}</p>
      {caption ? <p className="gauge__caption">{caption}</p> : null}
      {segments.length ? (
        <ul className="gauge__segs">
          {segments.map((s) => <li key={s.label} className={`is-${s.tone ?? 'neutral'}`}><b>{s.value}</b> {s.label}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

function polar(cxv, cyv, r, deg) {
  const rad = (deg * Math.PI) / 180;
  return [cxv + r * Math.cos(rad), cyv + r * Math.sin(rad)];
}
function describeArc(cxv, cyv, r, startAngle, endAngle) {
  const [sx, sy] = polar(cxv, cyv, r, startAngle);
  const [ex, ey] = polar(cxv, cyv, r, endAngle);
  const large = Math.abs(endAngle - startAngle) > 180 ? 1 : 0;
  return `M ${sx} ${sy} A ${r} ${r} 0 ${large} 1 ${ex} ${ey}`;
}

/** Small stacked share bar for "3 of 168 items are overdue"-style comparisons. */
export function ShareBar({ parts, className }) {
  const total = Math.max(1, parts.reduce((n, p) => n + (Number(p.value) || 0), 0));
  return (
    <div className={cx('sharebar', className)}>
      <div className="sharebar__track" role="img" aria-label={parts.map((p) => `${p.label}: ${p.value}`).join(', ')}>
        {parts.map((p) => (
          <span key={p.label} className="sharebar__seg" style={{ width: `${((Number(p.value) || 0) / total) * 100}%`, background: TONE_COLOR[p.tone] ?? p.tone }} title={`${p.label}: ${p.value}`}>
            <span className="sr-only">{p.label}: {p.value}</span>
          </span>
        ))}
      </div>
      <ul className="sharebar__legend">
        {parts.map((p) => <li key={p.label} className={`is-${p.tone}`}><b>{p.value}</b>{p.label}</li>)}
      </ul>
    </div>
  );
}

export { SERIES_COLORS, TONE_COLOR };
