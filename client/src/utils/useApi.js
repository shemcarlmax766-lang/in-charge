import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Data-fetching hook for read endpoints: loading / error / refresh, plus AbortController on
 * unmount and on dependency change (so a fast filter change cannot let a stale response
 * overwrite a newer one — the classic "old list flashes back" bug).
 */
export function useApi(fetcher, deps = [], { keepPrevious = false } = {}) {
  const [state, setState] = useState({ data: undefined, loading: true, error: null });
  const mounted = useRef(true);
  const generation = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const run = useCallback(async ({ silent = false } = {}) => {
    const gen = ++generation.current;
    const controller = new AbortController();
    if (!silent) setState((s) => ({ data: keepPrevious ? s.data : undefined, loading: true, error: null }));
    try {
      const data = await fetcher(controller.signal);
      if (!mounted.current || gen !== generation.current) return;
      setState({ data, loading: false, error: null });
    } catch (err) {
      if (!mounted.current || gen !== generation.current) return;
      if (err?.name === 'AbortError') return;
      setState({ data: keepPrevious ? state.data : undefined, loading: false, error: err });
    }
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    run();
    return () => generation.current += 1;
  }, [run]);

  const setData = useCallback((updater) => setState((s) => ({ ...s, data: typeof updater === 'function' ? updater(s.data) : updater })), []);
  return { ...state, refresh: run, setData, isLoading: state.loading && state.data === undefined };
}

/** Debounced value, used for filter inputs that drive network calls. */
export function useDebounced(value, delay = 400) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

/** URL query parameters as a reactive object (so filters survive a reload and can be shared). */
export function useQueryParams(defaults = {}) {
  const [params, setParamsState] = useState(() => readParams(defaults));
  const update = useCallback((patch) => setParamsState((prev) => {
    const next = { ...prev, ...patch };
    for (const k of Object.keys(next)) if (next[k] === '' || next[k] === null || next[k] === undefined) delete next[k];
    if (next.page === undefined) next.page = 1;
    writeParams(next);
    return next;
  }), []);
  const reset = useCallback(() => { writeParams({}); setParamsState({ ...defaults }); }, [defaults]);
  return [params, update, reset];
}

function readParams(defaults) {
  if (typeof window === 'undefined') return { ...defaults };
  const sp = new URLSearchParams(window.location.search);
  const out = {};
  for (const [k, v] of sp.entries()) out[k] = v;
  return out;
}

function writeParams(next) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(next)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const url = `${window.location.pathname}${sp.toString() ? `?${sp}` : ''}`;
  window.history.replaceState({}, '', url);
}

/** Window-width class helper for the table-or-cards decision (CSS handles the rest). */
export function useIsNarrow(breakpoint = 720) {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < breakpoint);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, [breakpoint]);
  return narrow;
}
