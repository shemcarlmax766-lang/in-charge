import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { auth, setCsrf, setBearer, setUnauthorizedHandler } from '../api/client.js';

const AuthContext = createContext(null);

/**
 * Session state for the whole app.
 *
 * The user object (including `capabilities`) comes from the server; this context only caches
 * it for rendering.  Hiding a button is a courtesy, never a control — every route re-checks
 * on the server (docs/SECURITY.md).
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | anonymous | authenticated
  const [notice, setNotice] = useState(null);

  const applySession = useCallback((session) => {
    setBearer(session?.token ?? null);
    setCsrf(session?.csrfToken ?? null);
    setUser(session?.user ?? session ?? null);
  }, []);

  const bootstrap = useCallback(async () => {
    try {
      const me = await auth.me();
      setCsrf(me.csrfToken ?? null);
      setUser(me);
      setStatus('authenticated');
    } catch (err) {
      setCsrf(null);
      setUser(null);
      setStatus('anonymous');
    }
  }, []);

  useEffect(() => {
    bootstrap();
    // A 401 from anywhere means the session expired: show why, then hand back to the login
    // screen. Without this the user stares at a spinner that never finishes.
    setUnauthorizedHandler(() => {
      setStatus((current) => {
        if (current !== 'authenticated') return current;
        setNotice('Your session expired. Sign in again to continue where you left off.');
        setUser(null);
        setCsrf(null);
        setBearer(null);
        return 'anonymous';
      });
    });
    return () => setUnauthorizedHandler(null);
  }, [bootstrap]);

  const login = useCallback(async ({ email, password, remember }) => {
    const session = await auth.login(email, password, !!remember);
    applySession(session);
    setNotice(null);
    setStatus('authenticated');
    return session;
  }, [applySession]);

  const logout = useCallback(async () => {
    try { await auth.logout(); } catch { /* the local state below is what matters */ }
    setUser(null);
    setCsrf(null);
    setBearer(null);
    setStatus('anonymous');
  }, []);

  const refresh = useCallback(async () => {
    try { setUser(await auth.me()); } catch { /* keep the stale user; the next call will 401 */ }
  }, []);

  const value = useMemo(() => ({
    user,
    status,
    notice,
    clearNotice: () => setNotice(null),
    login,
    logout,
    refresh,
    isAuthenticated: status === 'authenticated' && !!user,
    /** UI-level permission check. Mirrors the server, never replaces it. */
    can: (capability) => !!user?.capabilities?.includes(capability),
    is: (role) => user?.roleCode === role,
    role: user?.roleCode ?? null,
  }), [user, status, notice, login, logout, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
