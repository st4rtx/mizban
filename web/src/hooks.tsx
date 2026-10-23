import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, onUnauthorized } from './api';
import type { Me } from './types';

/* ---------- toasts ---------- */
type Toast = { id: number; text: string; kind: 'info' | 'err' | 'ok' };
const ToastCtx = createContext<(text: string, kind?: Toast['kind']) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setList((l) => [...l.slice(-2), { id, text, kind }]);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), kind === 'err' ? 5000 : 3000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {list.map((t) => <div key={t.id} className={`toast ${t.kind === 'info' ? '' : t.kind}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------- auth ---------- */
interface AuthState { me: Me | null; loading: boolean; refresh: () => Promise<void>; logout: () => Promise<void>; branchId: string; setBranchId: (id: string) => void }
const AuthCtx = createContext<AuthState>(null as never);
export const useAuth = () => useContext(AuthCtx);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [branch, setBranch] = useState<string>(() => { try { return localStorage.getItem('mz_branch') ?? ''; } catch { return ''; } });
  const refresh = useCallback(async () => {
    try { setMe(await api.get<Me>('/api/auth/me')); } catch { setMe(null); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); const off = onUnauthorized(() => setMe(null)); return () => { off(); }; }, [refresh]);
  const logout = useCallback(async () => { await api.post('/api/auth/logout').catch(() => undefined); setMe(null); }, []);
  const valid = me?.branches.find((b) => b.id === branch)?.id ?? me?.branches[0]?.id ?? '';
  const setBranchId = (id: string) => { setBranch(id); try { localStorage.setItem('mz_branch', id); } catch { /* storage may be blocked */ } };
  return <AuthCtx.Provider value={{ me, loading, refresh, logout, branchId: valid, setBranchId }}>{children}</AuthCtx.Provider>;
}

/* ---------- live updates (SSE) ---------- */
const LiveCtx = createContext<{ connected: boolean; subscribe: (fn: () => void) => () => void }>({ connected: false, subscribe: () => () => undefined });
export function LiveProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const subs = useRef(new Set<() => void>());
  useEffect(() => {
    let es: EventSource | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const fire = () => { clearTimeout(timer); timer = setTimeout(() => subs.current.forEach((f) => f()), 120); };

    // Plan B when a proxy/CDN buffers the event stream: long-poll /api/changes (each response is complete).
    const longPoll = async () => {
      while (!stopped) {
        try {
          const r = await fetch('/api/changes', { credentials: 'same-origin' });
          if (!r.ok) throw new Error(String(r.status));
          setConnected(true);
          if ((await r.json()).changed) fire();
        } catch {
          setConnected(false);
          await new Promise((res) => setTimeout(res, 3000));
        }
      }
    };

    es = new EventSource('/api/events');
    es.onopen = () => { clearTimeout(fallback); setConnected(true); fire(); }; // refetch on every (re)connect: we may have missed events
    es.onerror = () => setConnected(false);
    es.addEventListener('order', fire);
    es.addEventListener('menu', fire);
    fallback = setTimeout(() => { es?.close(); es = null; void longPoll(); }, 5000); // stream never opened: switch transport

    return () => { stopped = true; clearTimeout(timer); clearTimeout(fallback); es?.close(); };
  }, []);
  const subscribe = useCallback((fn: () => void) => { subs.current.add(fn); return () => { subs.current.delete(fn); }; }, []);
  return <LiveCtx.Provider value={{ connected, subscribe }}>{children}</LiveCtx.Provider>;
}
export const useLiveStatus = () => useContext(LiveCtx).connected;

/** Fetch + keep fresh: refetch on live events, on a slow poll (belt and braces), and when the tab returns. */
export function useLoad<T>(fetcher: () => Promise<T>, deps: unknown[], pollMs = 20000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const live = useContext(LiveCtx);
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const my = ++seq.current;
    try {
      const d = await fetchRef.current();
      if (my === seq.current) { setData(d); setError(null); }
    } catch (e) {
      if (my === seq.current) setError(e as ApiError);
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    setLoading(true);
    void reload();
    const off = live.subscribe(() => void reload());
    const poll = pollMs ? setInterval(() => void reload(), pollMs) : undefined;
    const vis = () => { if (document.visibilityState === 'visible') void reload(); };
    document.addEventListener('visibilitychange', vis);
    return () => { off(); clearInterval(poll); document.removeEventListener('visibilitychange', vis); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, loading, reload, setData };
}

/** Re-render every `ms` so elapsed-time labels stay honest. */
export function useNow(ms = 20000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}
