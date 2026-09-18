import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { notifications, equipment as equipmentApi, publicApi } from '../api/client.js';
import { Button, IconButton } from './ui.jsx';
import { QrScanner, parseTag } from './QrScanner.jsx';
import { cx, relativeTime } from '../utils/format.js';
import { SAFETY_NOTICE } from '../utils/constants.js';

/**
 * Application frame: capability-driven navigation, notification centre, and the mobile
 * layout (bottom bar + scan-first affordance) that the reporting workflow is designed for.
 */

const NAV = [
  { to: '/', label: 'Dashboard', icon: '◧', exact: true, cap: 'dashboard.view', group: 'main' },
  { to: '/equipment', label: 'Equipment', icon: '⚕', cap: 'equipment.view', group: 'main' },
  { to: '/faults', label: 'Fault reports', icon: '⚑', cap: 'fault.create', group: 'main' },
  { to: '/my-reports', label: 'My reports', icon: '☰', cap: 'fault.view.own', group: 'main', reporterOnly: true },
  { to: '/work', label: 'Work queue', icon: '⚒', cap: 'fault.transition.technical', group: 'work' },
  { to: '/maintenance', label: 'Maintenance', icon: '◷', cap: 'maintenance.view', group: 'work' },
  { to: '/risk', label: 'Risk register', icon: '△', cap: 'risk.view', group: 'work' },
  { to: '/reports', label: 'Reports', icon: '▤', cap: 'report.generate', group: 'admin' },
  { to: '/users', label: 'Users', icon: '☺', cap: 'user.manage', group: 'admin' },
  { to: '/reference', label: 'Configuration', icon: '⚙', cap: 'meta.manage', group: 'admin' },
  { to: '/audit', label: 'Audit log', icon: '⌸', cap: 'audit.view', group: 'admin' },
];

export function AppShell({ children }) {
  const { user, can, logout, is, notice, clearNotice } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [inbox, setInbox] = useState([]);
  const [demo, setDemo] = useState(null);
  const [query, setQuery] = useState('');
  const [userOpen, setUserOpen] = useState(false);
  const bellRef = useRef(null);
  const userRef = useRef(null);

  const items = useMemo(() => {
    const visible = NAV.filter((n) => (n.cap ? can(n.cap) : true) && (!n.reporterOnly || (is('reporter') && !can('fault.view.any'))));
    return {
      main: visible.filter((n) => n.group === 'main' || n.group === 'work'),
      admin: visible.filter((n) => n.group === 'admin'),
      all: visible,
    };
  }, [can, is]);

  const refreshUnread = useCallback(async () => {
    try { setUnread((await notifications.unread()).unread ?? 0); } catch { /* silent: it is a background poll */ }
  }, []);

  useEffect(() => {
    refreshUnread();
    const id = setInterval(refreshUnread, 60_000);
    return () => clearInterval(id);
  }, [refreshUnread, location.pathname]);

  useEffect(() => {
    let alive = true;
    publicApi.config().then((c) => { if (alive) setDemo(c); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => { setMenuOpen(false); setBellOpen(false); }, [location.pathname]);

  useEffect(() => {
    if (!bellOpen && !userOpen) return undefined;
    const onDown = (e) => {
      if (bellOpen && bellRef.current && !bellRef.current.contains(e.target)) setBellOpen(false);
      if (userOpen && userRef.current && !userRef.current.contains(e.target)) setUserOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    notifications.list({ limit: 12 }).then((r) => setInbox(r.items ?? [])).catch(() => {});
    return () => document.removeEventListener('mousedown', onDown);
  }, [bellOpen]);

  const onFound = (tag) => { setScanOpen(false); navigate(`/e/${encodeURIComponent(tag)}`); };

  const submitSearch = (e) => {
    e.preventDefault();
    const term = query.trim();
    if (!term) return;
    const tag = parseTag(term);
    if (tag && /^[A-Z]{2,4}-[A-Z0-9]{2,8}-\d+$/i.test(tag)) navigate(`/e/${encodeURIComponent(tag)}`);
    else navigate(`/equipment?q=${encodeURIComponent(term)}`);
    setQuery('');
  };

  return (
    <div className="shell">
      <a className="skip-link" href="#main">Skip to main content</a>

      <aside className={cx('sidebar', menuOpen && 'sidebar--open')}>
        <div className="sidebar__brand">
          <Link to="/" className="brand" aria-label="BEM-FRS dashboard">
            <span className="brand__mark" aria-hidden="true">
              <svg viewBox="0 0 32 32" width="26" height="26"><path d="M3 17h5l2.4-7 3.3 13.4L17 13l2 4h10" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </span>
            <span className="brand__text">
              <strong>BEM-FRS</strong>
              <small>{demo?.department ?? 'Biomedical Engineering'}</small>
            </span>
          </Link>
          <IconButton label="Close menu" className="sidebar__close" onClick={() => setMenuOpen(false)}>×</IconButton>
        </div>

        <nav className="sidebar__nav" aria-label="Main navigation">
          <NavGroup items={items.main} />
          {items.admin.length ? (
            <>
              <p className="sidebar__group-label">Administration</p>
              <NavGroup items={items.admin} />
            </>
          ) : null}
        </nav>

        <div className="sidebar__foot">
          <Button tone="primary" className="sidebar__scan" icon="▣" onClick={() => setScanOpen(true)}>Scan equipment label</Button>
          <p className="sidebar__notice">{SAFETY_NOTICE.split('.')[0]}.</p>
        </div>
      </aside>
      {menuOpen ? <div className="scrim" onClick={() => setMenuOpen(false)} aria-hidden="true" /> : null}

      <div className="shell__main">
        <header className="topbar">
          <IconButton label="Open menu" className="topbar__menu" onClick={() => setMenuOpen(true)}>☰</IconButton>
          <form className="topbar__search" onSubmit={submitSearch} role="search">
            <span className="topbar__search-icon" aria-hidden="true">⌕</span>
            <input
              className="input topbar__search-input"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search equipment, asset tag, serial…"
              aria-label="Search equipment by name, tag or serial number"
            />
          </form>

          <div className="topbar__right">
            <IconButton label="Scan a QR label" className="topbar__scan" onClick={() => setScanOpen(true)}>▣</IconButton>
            <div className="bell" ref={bellRef}>
              <button type="button" className="bell__btn" onClick={() => setBellOpen((v) => !v)} aria-expanded={bellOpen} aria-haspopup="true"
                aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>
                <span aria-hidden="true">◍</span>
                {unread > 0 ? <span className="bell__count">{unread > 99 ? '99+' : unread}</span> : null}
              </button>
              {bellOpen ? (
                <div className="bell__panel" role="dialog" aria-label="Recent notifications">
                  <div className="bell__head">
                    <strong>Notifications</strong>
                    <Link to="/notifications">View all</Link>
                  </div>
                  {inbox.length === 0 ? <p className="bell__empty">Nothing waiting. That is usually good news.</p> : (
                    <ul className="bell__list">
                      {inbox.map((n) => (
                        <li key={n.id}>
                          <Link to={n.link ?? '/notifications'} className={cx('bell__item', n.unread && 'bell__item--unread')}>
                            <span className={cx('bell__tone', `bell__tone--${n.severity}`)} aria-hidden="true" />
                            <span className="bell__body">
                              <span className="bell__title">{n.title}</span>
                              <span className="bell__text">{(n.body ?? '').slice(0, 110)}</span>
                              <span className="bell__time">{relativeTime(n.createdAt)}</span>
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
            </div>

            <div className="usermenu" ref={userRef}>
              <button type="button" className="usermenu__btn" onClick={() => setUserOpen((v) => !v)} aria-expanded={userOpen} aria-haspopup="true" aria-label="Account menu">
                <span className="avatar" aria-hidden="true">{(user?.fullName ?? '?').split(' ').map((w) => w[0]).slice(0, 2).join('')}</span>
                <span className="usermenu__text">
                  <strong>{user?.fullName}</strong>
                  <small>{user?.roleLabel}</small>
                </span>
              </button>
              {userOpen ? (
                <div className="usermenu__panel">
                  <p className="usermenu__who">{user?.email}<br /><span className="muted">{user?.jobTitle ?? user?.department}</span></p>
                  <Link to="/profile">Profile &amp; security</Link>
                  <Link to="/profile?tab=sessions">Active sessions ({user?.activeSessions ?? '…'})</Link>
                  <button type="button" onClick={async () => { await logout(); navigate('/login'); }}>Sign out</button>
                </div>
              ) : null}
            </div>
          </div>
        </header>

        {notice ? (
          <div className="banner banner--warn" role="alert">
            <span>{notice}</span>
            <button type="button" onClick={clearNotice} aria-label="Dismiss message">×</button>
          </div>
        ) : null}
        {demo?.demoData ? (
          <div className="banner banner--demo">
            <strong>DEMO DATA</strong> — every item, fault and cost below is fictional sample data installed for evaluation.
            <Link to="/reference?tab=settings">Turn the banner off</Link>
          </div>
        ) : null}

        <main id="main" className="shell__content">{children}</main>

        <nav className="tabbar" aria-label="Primary">
          {items.main.slice(0, 4).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.exact} className={({ isActive }) => cx('tabbar__item', isActive && 'tabbar__item--active')}>
              <span aria-hidden="true">{n.icon}</span>
              <span>{n.label.split(' ')[0]}</span>
            </NavLink>
          ))}
          <button type="button" className="tabbar__item tabbar__item--scan" onClick={() => setScanOpen(true)}>
            <span aria-hidden="true">▣</span><span>Scan</span>
          </button>
        </nav>
      </div>

      <QrScanner open={scanOpen} onClose={() => setScanOpen(false)} onFound={onFound} />
    </div>
  );
}

function NavGroup({ items }) {
  return (
    <ul className="navlist">
      {items.map((n) => (
        <li key={n.to}>
          <NavLink to={n.to} end={n.exact} className={({ isActive }) => cx('navlink', isActive && 'navlink--active')}>
            <span className="navlink__icon" aria-hidden="true">{n.icon}</span>
            <span className="navlink__label">{n.label}</span>
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

export function PageHeader({ eyebrow, title, description, actions, back }) {
  return (
    <div className="page-head">
      <div className="page-head__main">
        {back ? <Link to={back.to} className="page-head__back">← {back.label}</Link> : null}
        {eyebrow ? <p className="page-head__eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        {description ? <p className="page-head__desc">{description}</p> : null}
      </div>
      {actions ? <div className="page-head__actions">{actions}</div> : null}
    </div>
  );
}
