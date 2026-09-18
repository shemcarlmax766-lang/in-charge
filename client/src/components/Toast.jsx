import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { cx } from '../utils/format.js';

const ToastContext = createContext(null);

/**
 * Application toasts + a `<Callout>` primitive for in-page messages.
 * Toasts are deliberately transient and never the only channel: anything the user must be
 * able to act on later is also written to the notification centre by the server.
 */
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const next = useRef(1);

  const dismiss = useCallback((id) => setItems((list) => list.filter((t) => t.id !== id)), []);

  const push = useCallback((tone, message, opts = {}) => {
    const id = next.current++;
    setItems((list) => [...list.slice(-3), { id, tone, message, detail: opts.detail, sticky: !!opts.sticky }]);
    if (!opts.sticky) setTimeout(() => dismiss(id), opts.duration ?? 5200);
    return id;
  }, [dismiss]);

  const value = useMemo(() => ({
    push,
    success: (m, o) => push('ok', m, o),
    error: (m, o) => push('bad', m, { duration: 9000, ...o }),
    info: (m, o) => push('info', m, o),
    warn: (m, o) => push('warn', m, o),
    dismiss,
  }), [push, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite" aria-atomic="false">
        {items.map((t) => (
          <div key={t.id} className={cx('toast', `toast--${t.tone}`)}>
            <div className="toast__body">
              <p className="toast__msg">{t.message}</p>
              {t.detail ? <p className="toast__detail">{t.detail}</p> : null}
            </div>
            <button type="button" className="toast__close" onClick={() => dismiss(t.id)} aria-label="Dismiss notification">
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

export function Callout({ tone = 'info', title, children, actions, className, icon }) {
  return (
    <div className={cx('callout', `callout--${tone}`, className)} role={tone === 'bad' ? 'alert' : 'note'}>
      {icon ? <span className="callout__icon" aria-hidden="true">{icon}</span> : null}
      <div className="callout__main">
        {title ? <p className="callout__title">{title}</p> : null}
        {children ? <div className="callout__body">{children}</div> : null}
        {actions ? <div className="callout__actions">{actions}</div> : null}
      </div>
    </div>
  );
}

/** Turns any thrown error into a sentence a lab user can act on. */
export function errorText(err) {
  if (!err) return 'Something went wrong.';
  if (err.fieldErrors && Object.keys(err.fieldErrors).length) {
    const first = Object.entries(err.fieldErrors)[0];
    return `${first[0]}: ${Array.isArray(first[1]) ? first[1].join(' ') : first[1]}`;
  }
  if (err.status === 0) return 'The server could not be reached. Check your connection and try again.';
  if (err.status === 401) return 'Your session has expired. Sign in again.';
  if (err.status === 403) return err.message || 'Your role is not permitted to do that.';
  if (err.status === 429) return err.message || 'Too many requests — wait a moment and retry.';
  return err.message || 'The request could not be completed.';
}
