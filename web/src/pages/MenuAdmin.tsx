import { useState } from 'react';
import { api, ApiError } from '../api';
import { toFa, toman } from '../fa';
import { useLoad, useToast } from '../hooks';
import type { MenuCategory } from '../types';
import { Empty, Skeleton } from '../ui';
import { parseAmount } from './Checkout';

export default function MenuAdmin() {
  const toast = useToast();
  const { data, loading, reload, setData } = useLoad(() => api.get<{ categories: MenuCategory[] }>('/api/menu'), [], 30000);
  const [prices, setPrices] = useState<Record<string, string>>({});

  async function patch(id: string, body: { available?: boolean; price?: number }) {
    try {
      await api.patch(`/api/menu/items/${id}`, body);
      setData((d) => d && { categories: d.categories.map((c) => ({ ...c, items: c.items.map((i) => (i.id === id ? { ...i, ...body } : i)) })) });
      if (body.price !== undefined) { setPrices((p) => { const n = { ...p }; delete n[id]; return n; }); toast('قیمت ذخیره شد؛ سفارش‌های قبلی تغییر نمی‌کنند', 'ok'); }
      else toast(body.available ? 'دوباره قابل سفارش است' : 'به‌عنوان «تمام شد» علامت خورد', 'ok');
    } catch (e) { toast((e as ApiError).message, 'err'); void reload(); }
  }

  if (loading && !data) return <Skeleton h={400} />;
  if (!data?.categories.length) return <Empty title="منو خالی است" />;
  return (
    <div style={{ display: 'grid', gap: 16, maxWidth: 860 }}>
      <p className="muted">اگر چیزی تمام شد، همین‌جا خاموشش کنید؛ همان لحظه از منوی گارسون‌ها بسته می‌شود. تغییر قیمت فقط روی سفارش‌های بعدی اثر دارد.</p>
      {data.categories.map((c) => (
        <section key={c.id} className="card panel">
          <h2>{c.icon} {c.name} <span className="muted" style={{ fontWeight: 500, fontSize: 13 }}>({toFa(c.items.length)})</span></h2>
          {c.items.map((i) => {
            const draft = prices[i.id];
            const dirty = draft !== undefined && parseAmount(draft) !== i.price;
            return (
              <div key={i.id} className={`mrow ${i.available ? '' : 'off'}`}>
                <button className={`switch ${i.available ? 'on' : ''}`} role="switch" aria-checked={i.available} aria-label={`موجود بودن ${i.name}`} onClick={() => void patch(i.id, { available: !i.available })} />
                <div><div className="nm" style={{ fontWeight: 600 }}>{i.name}</div><div className="muted" style={{ fontSize: 12.5 }}>{i.station === 'bar' ? 'بار' : 'آشپزخانه'} · {toFa(i.prepMinutes)} دقیقه · {toman(i.price)}</div></div>
                <input className="input price-in num" inputMode="numeric" aria-label={`قیمت ${i.name}`} value={draft ?? String(i.price)} onChange={(e) => setPrices((p) => ({ ...p, [i.id]: e.target.value.replace(/[^\d۰-۹]/g, '') }))} />
                {dirty ? <button className="btn sm primary" onClick={() => void patch(i.id, { price: parseAmount(draft!) })}>ذخیره</button> : <span />}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
