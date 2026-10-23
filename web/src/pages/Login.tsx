import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { ROLE_FA } from '../fa';
import { useAuth } from '../hooks';
import type { Role } from '../types';

interface Demo { username: string; password: string; label: string; role: Role; note: string }

/** Eight-point star lattice: the tile-work of a Persian mosque ceiling, drawn once and repeated. */
function Tiles() {
  return (
    <svg className="tiles" aria-hidden="true">
      <defs>
        <pattern id="girih" width="96" height="96" patternUnits="userSpaceOnUse">
          <path d="M48 6l9 14 16-3-3 16 14 9-14 9 3 16-16-3-9 14-9-14-16 3 3-16-14-9 14-9-3-16 16 3z" fill="none" stroke="#0e9594" strokeWidth="1.4" opacity="0.55" />
          <path d="M48 26l5 8 9 1-6 7 2 9-10-4-10 4 2-9-6-7 9-1z" fill="#0e9594" opacity="0.12" />
          <circle cx="0" cy="0" r="6" fill="#27408b" opacity="0.5" />
          <circle cx="96" cy="0" r="6" fill="#27408b" opacity="0.5" />
          <circle cx="0" cy="96" r="6" fill="#27408b" opacity="0.5" />
          <circle cx="96" cy="96" r="6" fill="#27408b" opacity="0.5" />
          <path d="M0 48h14M82 48h14M48 0v14M48 82v14" stroke="#e0a000" strokeWidth="2" opacity="0.55" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#girih)" />
    </svg>
  );
}

export default function Login() {
  const { refresh } = useAuth();
  const [username, setU] = useState('');
  const [password, setP] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState<Demo[]>([]);
  useEffect(() => { api.get<{ accounts: Demo[] }>('/api/auth/demo').then((d) => setDemo(d.accounts)).catch(() => undefined); }, []);

  async function submit(e?: FormEvent, creds = { username, password }) {
    e?.preventDefault();
    setBusy(true); setErr('');
    try {
      await api.post('/api/auth/login', creds);
      await refresh();
    } catch (x) {
      setErr((x as ApiError).message);
    } finally { setBusy(false); }
  }

  return (
    <div className="login">
      <section className="art">
        <Tiles />
        <div className="veil" />
        <div className="copy">
          <h1>میزبان</h1>
          <p>از ثبت سفارش سر میز تا آشپزخانه و صندوق، همه روی یک صفحه. بدون کاغذ، بدون «میز ۷ چی گفت؟».</p>
        </div>
      </section>
      <section className="form">
        <div>
          <h2>ورود به سیستم</h2>
          <p className="muted">با حساب کاربری خودتان وارد شوید.</p>
        </div>
        <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
          <label className="field"><span>نام کاربری</span>
            <input className="input" value={username} onChange={(e) => setU(e.target.value)} autoComplete="username" autoCapitalize="none" dir="ltr" style={{ textAlign: 'right' }} required />
          </label>
          <label className="field"><span>رمز عبور</span>
            <input className="input" type="password" value={password} onChange={(e) => setP(e.target.value)} autoComplete="current-password" dir="ltr" style={{ textAlign: 'right' }} required />
          </label>
          {err && <div className="toast err" role="alert" style={{ animation: 'none' }}>{err}</div>}
          <button className="btn primary big" disabled={busy}>{busy ? 'در حال ورود…' : 'ورود'}</button>
        </form>
        {demo.length > 0 && (
          <div className="demo">
            <p className="muted" style={{ fontSize: 13 }}>حساب‌های نمایشی (برای بررسی؛ رمز همه <b dir="ltr">demo1234</b>)</p>
            {demo.map((d) => (
              <button key={d.username} type="button" disabled={busy} onClick={() => void submit(undefined, { username: d.username, password: d.password })}>
                <span className={`role ${d.role}`}>{ROLE_FA[d.role]}</span>
                <span><b>{d.label}</b><small>{d.note}</small></span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
