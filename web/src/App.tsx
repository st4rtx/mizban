import { useEffect, useState } from 'react';
import { AuthProvider, LiveProvider, ToastProvider, useAuth, useLiveStatus } from './hooks';
import { Icon, Logo, type IconName } from './ui';
import { ROLE_FA } from './fa';
import { Router, navigate, useRoute } from './router';
import Login from './pages/Login';
import Floor from './pages/Floor';
import OrderPage from './pages/Order';
import Kitchen from './pages/Kitchen';
import Report from './pages/Report';
import MenuAdmin from './pages/MenuAdmin';

const NAV: { path: string; label: string; icon: IconName; roles: string[] }[] = [
  { path: '/floor', label: 'سالن', icon: 'floor', roles: ['manager', 'floor'] },
  { path: '/kitchen', label: 'آشپزخانه', icon: 'kitchen', roles: ['manager', 'kitchen'] },
  { path: '/report', label: 'گزارش', icon: 'chart', roles: ['manager'] },
  { path: '/menu', label: 'منو', icon: 'menu', roles: ['manager'] },
];

function Shell() {
  const { me, logout, branchId, setBranchId } = useAuth();
  const route = useRoute();
  const live = useLiveStatus();
  const items = NAV.filter((n) => n.roles.includes(me!.user.role));
  const home = items[0].path;

  useEffect(() => {
    if (route.path === '/' || !items.some((n) => route.path.startsWith(n.path)) && !route.path.startsWith('/order/')) navigate(home, true);
  }, [route.path]); // eslint-disable-line react-hooks/exhaustive-deps

  const title = items.find((n) => route.path.startsWith(n.path))?.label ?? (route.path.startsWith('/order/') ? 'سفارش' : '');
  const branch = me!.branches.find((b) => b.id === branchId);

  return (
    <div className="shell">
      <nav className="rail" aria-label="منوی اصلی">
        <Logo />
        {items.map((n) => (
          <a key={n.path} href={n.path} className={route.path.startsWith(n.path) || (n.path === '/floor' && route.path.startsWith('/order/')) ? 'active' : ''}
            onClick={(e) => { e.preventDefault(); navigate(n.path); }}>
            <Icon name={n.icon} />{n.label}
          </a>
        ))}
        <div className="spacer" />
        <button className="nav" onClick={() => void logout()}><Icon name="logout" />خروج</button>
      </nav>
      <div className="main">
        <header className="topbar">
          <h1>{title}</h1>
          {me!.branches.length > 1 ? (
            <select className="select" value={branchId} onChange={(e) => setBranchId(e.target.value)} aria-label="شعبه">
              {me!.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          ) : <span className="chip">{branch?.name}</span>}
          <span className="grow" />
          <span className={`live ${live ? '' : 'off'}`}><i />{live ? 'زنده' : 'قطع'}</span>
          <div className="who"><b>{me!.user.name}</b>{ROLE_FA[me!.user.role]} · {me!.restaurant.name}</div>
        </header>
        <main className="content">
          <Router
            routes={[
              { match: /^\/floor$/, el: () => <Floor /> },
              { match: /^\/order\/([0-9a-f-]+)$/, el: (m) => <OrderPage id={m[1]} /> },
              { match: /^\/kitchen$/, el: () => <Kitchen /> },
              { match: /^\/report$/, el: () => <Report /> },
              { match: /^\/menu$/, el: () => <MenuAdmin /> },
            ]}
          />
        </main>
      </div>
    </div>
  );
}

function Gate() {
  const { me, loading } = useAuth();
  const [ready, setReady] = useState(false);
  useEffect(() => { if (!loading) setReady(true); }, [loading]);
  if (!ready) return null;
  if (!me) return <Login />;
  return (
    <LiveProvider>
      <Shell />
    </LiveProvider>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </ToastProvider>
  );
}
