import { useEffect, useState, type ReactNode } from 'react';

const listeners = new Set<() => void>();
export function navigate(path: string, replace = false) {
  if (location.pathname === path) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', path);
  listeners.forEach((f) => f());
}
export function useRoute() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const f = () => setPath(location.pathname);
    listeners.add(f);
    window.addEventListener('popstate', f);
    return () => { listeners.delete(f); window.removeEventListener('popstate', f); };
  }, []);
  return { path };
}
export function Router({ routes }: { routes: { match: RegExp; el: (m: RegExpMatchArray) => ReactNode }[] }) {
  const { path } = useRoute();
  for (const r of routes) {
    const m = path.match(r.match);
    if (m) return <>{r.el(m)}</>;
  }
  return null;
}
