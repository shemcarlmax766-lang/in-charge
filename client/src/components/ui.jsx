import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../utils/format.js';

/**
 * Form + action primitives.  Everything here is a real <button>/<input>, uses native
 * validation affordances where they help, and takes an explicit `invalid`/`describedBy`
 * contract so server-side field errors render the same way as client-side ones.
 */

export function Button({ as: Tag = 'button', tone = 'primary', size = 'md', icon, loading, children, className, ...rest }) {
  const Component = Tag;
  return (
    <Component
      {...(Tag === 'button' ? { type: rest.type ?? 'button' } : {})}
      className={cx('btn', `btn--${tone}`, `btn--${size}`, loading && 'btn--loading', className)}
      aria-busy={loading || undefined}
      disabled={Tag === 'button' && (rest.disabled || loading)}
      {...rest}
    >
      {icon ? <span className="btn__icon" aria-hidden="true">{icon}</span> : null}
      <span className="btn__label">{children}</span>
      {loading ? <span className="btn__spinner" aria-hidden="true" /> : null}
    </Component>
  );
}

export function IconButton({ label, children, tone = 'ghost', className, ...rest }) {
  return (
    <button type="button" className={cx('iconbtn', `iconbtn--${tone}`, className)} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}

/** Label + control + error + help, wired with ids so screen readers get the whole story. */
export function Field({ label, hint, error, required, children, htmlFor, className, addon, counter }) {
  const id = useId();
  const inputId = htmlFor ?? id;
  const describedBy = [hint ? `${inputId}-hint` : null, error ? `${inputId}-error` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cx('field', error && 'field--error', className)}>
      {label ? (
        <label className="field__label" htmlFor={inputId}>
          {label}
          {required ? <span className="field__req" aria-hidden="true"> *</span> : null}
          {required ? <span className="sr-only"> (required)</span> : null}
        </label>
      ) : null}
      <div className="field__control">
        {typeof children === 'function' ? children({ id: inputId, describedBy }) : children}
        {addon ? <div className="field__addon">{addon}</div> : null}
      </div>
      {hint && !error ? <p className="field__hint" id={`${inputId}-hint`}>{hint}</p> : null}
      {error ? (
        <p className="field__error" id={`${inputId}-error`} role="alert">
          {error}
        </p>
      ) : null}
      {counter ? <p className={cx('field__counter', counter.over && 'field__counter--over')}>{counter.text}</p> : null}
    </div>
  );
}

export function TextInput({ error, className, ...rest }) {
  return <input className={cx('input', error && 'input--error', className)} aria-invalid={error ? 'true' : undefined} {...rest} />;
}

export function TextArea({ error, rows = 4, className, ...rest }) {
  return <textarea rows={rows} className={cx('input', 'textarea', error && 'input--error', className)} aria-invalid={error ? 'true' : undefined} {...rest} />;
}

export function Select({ error, options = [], placeholder, className, children, ...rest }) {
  return (
    <select className={cx('input', 'select', error && 'input--error', className)} aria-invalid={error ? 'true' : undefined} {...rest}>
      {placeholder ? <option value="">{placeholder}</option> : null}
      {(options || []).map((o) => {
        const value = typeof o === 'object' ? o.value : o;
        const label = typeof o === 'object' ? o.label : o;
        return <option key={String(value)} value={value ?? ''}>{label}</option>;
      })}
      {children}
    </select>
  );
}

export function Checkbox({ label, hint, checked, onChange, disabled, className, ...rest }) {
  return (
    <label className={cx('check', disabled && 'check--disabled', className)}>
      <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange?.(e.target.checked)} {...rest} />
      <span className="check__box" aria-hidden="true" />
      <span className="check__text">
        <span className="check__label">{label}</span>
        {hint ? <span className="check__hint">{hint}</span> : null}
      </span>
    </label>
  );
}

/** Segmented choice for short lists (severity, status) — much faster on a phone than a select. */
export function ChoiceChips({ name, value, onChange, options, size = 'md', ariaLabel }) {
  return (
    <div className={cx('chips', `chips--${size}`)} role="radiogroup" aria-label={ariaLabel ?? name}>
      {options.map((o) => {
        const val = typeof o === 'object' ? o.value : o;
        const opt = typeof o === 'object' ? o : { value: o, label: o };
        const active = value === val;
        return (
          <button
            key={String(val)}
            type="button"
            role="radio"
            aria-checked={active}
            className={cx('chip', `chip--${opt.tone ?? 'neutral'}`, active && 'chip--active')}
            onClick={() => onChange(val)}
          >
            <span className="chip__label">{opt.label}</span>
            {opt.hint ? <span className="chip__hint">{opt.hint}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function Spinner({ label = 'Loading', size = 'md' }) {
  return (
    <span className={cx('spinner', `spinner--${size}`)} role="status" aria-live="polite">
      <span className="spinner__ring" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function Loading({ label = 'Loading', rows = 3, className } = {}) {
  return (
    <div className={cx('loading-block', className)} role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }).map((_, i) => <div key={i} className="skeleton skeleton--row" style={{ width: `${100 - i * 9}%` }} />)}
    </div>
  );
}

export function EmptyState({ icon = '📋', title, description, action, className }) {
  return (
    <div className={cx('empty', className)}>
      <span className="empty__icon" aria-hidden="true">{icon}</span>
      <p className="empty__title">{title}</p>
      {description ? <p className="empty__desc">{description}</p> : null}
      {action ? <div className="empty__action">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry, className }) {
  return (
    <div className={cx('callout', 'callout--bad', className)} role="alert">
      <span className="callout__icon" aria-hidden="true">⚠</span>
      <div className="callout__main">
        <p className="callout__title">{error?.message || 'This could not be loaded.'}</p>
        <div className="callout__body">
          <p>{error?.status ? `Server responded ${error.status}.` : 'Check your connection and try again.'}</p>
        </div>
        {onRetry ? (
          <div className="callout__actions">
            <Button tone="secondary" size="sm" onClick={onRetry}>Try again</Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Modal dialog: focus-trapped, Escape to close, returns focus to the opener. */
export function Modal({ open, title, description, onClose, children, footer, size = 'md', labelId }) {
  const panel = useRef(null);
  const previouslyFocused = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    previouslyFocused.current = document.activeElement;
    const { body } = document;
    const prevOverflow = body.style.overflow;
    body.style.overflow = 'hidden';
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose?.(); return; }
      if (e.key !== 'Tab' || !panel.current) return;
      const focusables = panel.current.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])');
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    const t = setTimeout(() => panel.current?.querySelector('[data-autofocus],input,select,textarea,button')?.focus(), 20);
    return () => {
      document.removeEventListener('keydown', onKey);
      body.style.overflow = prevOverflow;
      clearTimeout(t);
      previouslyFocused.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="modal" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className={cx('modal__panel', `modal__panel--${size}`)} role="dialog" aria-modal="true" aria-labelledby={labelId ?? 'modal-title'} ref={panel}>
        <header className="modal__head">
          <div>
            <h2 id={labelId ?? 'modal-title'} className="modal__title">{title}</h2>
            {description ? <p className="modal__desc">{description}</p> : null}
          </div>
          <IconButton label="Close dialog" onClick={() => onClose?.()}>×</IconButton>
        </header>
        <div className="modal__body">{children}</div>
        {footer ? <footer className="modal__foot">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Destructive-action confirmation.  `confirmText` forces the user to type a word (asset tag,
 * email) for the irreversible cases — deleting a record, removing a user — because a stray
 * click on "Delete" should not be able to erase a department's history.
 */
export function ConfirmDialog({
  open, title = 'Are you sure?', tone = 'bad', body, children, confirmLabel = 'Confirm',
  cancelLabel = 'Cancel', requireText, busy, error, onConfirm, onCancel,
}) {
  const [typed, setTyped] = useState('');
  useEffect(() => { if (open) setTyped(''); }, [open]);
  const ready = !requireText || typed.trim().toLowerCase() === String(requireText).trim().toLowerCase();
  return (
    <Modal
      open={open}
      onClose={() => !busy && onCancel?.()}
      title={title}
      size="sm"
      footer={(
        <>
          <Button tone="ghost" onClick={() => onCancel?.()} disabled={busy}>{cancelLabel}</Button>
          <Button tone={tone === 'bad' ? 'danger' : 'primary'} onClick={() => onConfirm?.({ confirmText: typed })} disabled={!ready || busy} loading={busy} data-autofocus>
            {confirmLabel}
          </Button>
        </>
      )}
    >
      {body ? <p className="form-note">{body}</p> : null}
      {children}
      {requireText ? (
        <Field
          label={`Type “${requireText}” to confirm`}
          hint="This guard prevents losing a record by clicking the wrong button."
          error={!ready && typed ? 'That does not match.' : null}
        >
          <TextInput value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={requireText} autoComplete="off" />
        </Field>
      ) : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </Modal>
  );
}

export function Tabs({ tabs, active, onChange, className }) {
  const listRef = useRef(null);
  const onKeyDown = (e) => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
    const items = tabs.map((t) => t.id);
    const i = items.indexOf(active);
    const nextIndex = e.key === 'ArrowRight' ? (i + 1) % items.length
      : e.key === 'ArrowLeft' ? (i - 1 + items.length) % items.length
      : e.key === 'Home' ? 0 : items.length - 1;
    e.preventDefault();
    onChange(items[nextIndex]);
    listRef.current?.querySelectorAll('[role="tab"]')[nextIndex]?.focus();
  };
  return (
    <div className={cx('tabs', className)} role="tablist" ref={listRef} onKeyDown={onKeyDown}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          id={`tab-${t.id}`}
          aria-selected={active === t.id}
          aria-controls={`panel-${t.id}`}
          tabIndex={active === t.id ? 0 : -1}
          className={cx('tabs__item', active === t.id && 'tabs__item--active')}
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.count !== undefined && t.count !== null ? <span className="tabs__count">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Pagination({ pagination, onPage, className }) {
  if (!pagination || pagination.pages <= 1) return null;
  const { page, pages, total, perPage } = pagination;
  const from = (page - 1) * perPage + 1;
  const to = Math.min(total, page * perPage);
  return (
    <nav className={cx('pager', className)} aria-label="Pagination">
      <p className="pager__summary">
        {total === 0 ? 'No results' : <>Showing <b>{from}–{to}</b> of <b>{total}</b></>}
      </p>
      <div className="pager__buttons">
        <Button size="sm" tone="ghost" disabled={page <= 1} onClick={() => onPage(page - 1)}>← Previous</Button>
        <span className="pager__page" aria-live="polite">Page {page} of {pages}</span>
        <Button size="sm" tone="ghost" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next →</Button>
      </div>
    </nav>
  );
}

/** Collapsible filter panel: full width on a phone, inline row on a desktop. */
export function FilterBar({ children, active, onClear, className }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cx('filters', className)}>
      <div className="filters__bar">
        <Button size="sm" tone={active ? 'primary' : 'ghost'} icon="⚙" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls="filter-panel">
          Filters{active ? ' · active' : ''}
        </Button>
        {active ? <Button size="sm" tone="ghost" onClick={onClear}>Clear</Button> : null}
      </div>
      {open ? (
        <div id="filter-panel" className="filters__panel">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Debounced search input with an explicit submit, so a fast typist on a phone does not fire
 * six requests per word.
 */
export function SearchInput({ value, onSearch, placeholder = 'Search…', delay = 450, className }) {
  const [local, setLocal] = useState(value ?? '');
  const timer = useRef();
  useEffect(() => { setLocal(value ?? ''); }, [value]);
  const commit = useCallback(() => { clearTimeout(timer.current); onSearch(local.trim()); }, [local, onSearch]);
  return (
    <div className={cx('search', className)}>
      <span className="search__icon" aria-hidden="true">⌕</span>
      <input
        type="search"
        className="input search__input"
        value={local}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => {
          const v = e.target.value;
          setLocal(v);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => onSearch(v.trim()), delay);
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
      />
      {local ? <IconButton label="Clear search" onClick={() => { setLocal(''); onSearch(''); }}>×</IconButton> : null}
    </div>
  );
}

export function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { setCopied(false); }
  }, []);
  return { copied, copy };
}

/*
 * Barrel re-exports, so a screen imports its primitives from one module.
 * These are presentation-only components; authority always lives on the server.
 */
export { Callout, errorText } from './Toast.jsx';
export {
  Badge, Card, DataTable, KeyValue, Timeline, EquipmentStatusPill, FaultStatusPill,
  SeverityPill, MaintenanceLight, RiskBadge, CriticalityTag, Money, Linkify,
  ProgressBar, CardList, Timestamp, formatDate,
} from './display.jsx';
