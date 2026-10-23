import { useState } from 'react';
import { api, ApiError } from '../api';
import { num, toFa, toman } from '../fa';
import { useLoad, useToast } from '../hooks';
import type { MenuCategory } from '../types';
import { Empty, Icon, Modal, Skeleton } from '../ui';
import { parseAmount } from './Checkout';

export default function MenuAdmin() {
  const toast = useToast();
  const { data, loading, reload, setData } = useLoad(() => api.get<{ categories: MenuCategory[] }>('/api/menu'), [], 30000);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [modal, setModal] = useState<'item' | 'category' | null>(null);

  async function patch(id: string, body: { available?: boolean; price?: number }) {
    try {
      await api.patch(`/api/menu/items/${id}`, body);
      setData((d) => d && { categories: d.categories.map((c) => ({ ...c, items: c.items.map((i) => (i.id === id ? { ...i, ...body } : i)) })) });
      if (body.price !== undefined) { setPrices((p) => { const n = { ...p }; delete n[id]; return n; }); toast('قیمت ذخیره شد؛ سفارش‌های قبلی تغییر نمی‌کنند', 'ok'); }
      else toast(body.available ? 'دوباره قابل سفارش است' : 'به‌عنوان «تمام شد» علامت خورد', 'ok');
    } catch (e) { toast((e as ApiError).message, 'err'); void reload(); }
  }

  if (loading && !data) return <Skeleton h={400} />;
  if (!data?.categories.length) {
    return (
      <>
        <Empty title="منو خالی است" hint="اول یک دسته بسازید (مثلاً پیش‌غذا یا نوشیدنی)، بعد آیتم‌ها را اضافه کنید." />
        <div style={{ textAlign: 'center' }}><button className="btn primary" onClick={() => setModal('category')}><Icon name="plus" />ساخت اولین دسته</button></div>
        {modal === 'category' && <NewCategoryModal onClose={() => setModal(null)} onDone={() => { setModal(null); void reload(); }} />}
      </>
    );
  }
  return (
    <div style={{ display: 'grid', gap: 16, maxWidth: 860 }}>
      <div className="toolbar" style={{ marginBottom: 0 }}>
        <button className="btn primary" onClick={() => setModal('item')}><Icon name="plus" />آیتم جدید</button>
        <button className="btn" onClick={() => setModal('category')}><Icon name="plus" />دستهٔ جدید</button>
      </div>
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
      {modal === 'item' && <NewItemModal categories={data.categories} onClose={() => setModal(null)} onDone={() => { setModal(null); void reload(); }} />}
      {modal === 'category' && <NewCategoryModal onClose={() => setModal(null)} onDone={() => { setModal(null); void reload(); }} />}
    </div>
  );
}

/* Modals live at module level on purpose: inside MenuAdmin they would remount on every live refresh and wipe the form. */
function NewItemModal({ categories, onClose, onDone }: { categories: MenuCategory[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '');
  const [name, setName] = useState('');
  const [priceText, setPriceText] = useState('');
  const [station, setStation] = useState<'kitchen' | 'bar'>('kitchen');
  const [prep, setPrep] = useState('10');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const price = parseAmount(priceText);
  const prepMinutes = Math.min(120, Math.max(1, parseAmount(prep) || 10));
  async function save() {
    setBusy(true);
    try {
      await api.post('/api/menu/items', { categoryId, name, price, station, prepMinutes, description: description.trim() || null });
      toast(`«${name.trim()}» به منو اضافه شد و همین حالا قابل سفارش است`, 'ok');
      onDone();
    } catch (e) { toast((e as ApiError).message, 'err'); } finally { setBusy(false); }
  }
  return (
    <Modal title="آیتم جدید" onClose={onClose}>
      <label className="field"><span>دسته</span>
        <select className="select" style={{ width: '100%', minHeight: 46 }} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.icon ? `${c.icon} ` : ''}{c.name}</option>)}
        </select>
      </label>
      <label className="field"><span>نام آیتم</span><input className="input" value={name} maxLength={80} autoFocus placeholder="مثلاً: لوبیاپلو با ماهیچه" onChange={(e) => setName(e.target.value)} /></label>
      <label className="field"><span>قیمت (تومان)</span>
        <input className="input num" inputMode="numeric" value={priceText ? num(price) : ''} placeholder="۰" onChange={(e) => setPriceText(e.target.value)} style={{ fontSize: 20, fontWeight: 700, minHeight: 52 }} />
      </label>
      <div className="field"><span>از کجا بیرون می‌آید؟</span>
        <div className="seg" style={{ justifySelf: 'start' }}>
          <button type="button" className={station === 'kitchen' ? 'on' : ''} onClick={() => setStation('kitchen')}>آشپزخانه</button>
          <button type="button" className={station === 'bar' ? 'on' : ''} onClick={() => setStation('bar')}>بار</button>
        </div>
      </div>
      <label className="field"><span>زمان آماده‌سازی (دقیقه)</span><input className="input num" inputMode="numeric" value={toFa(prep)} onChange={(e) => setPrep(e.target.value)} style={{ maxWidth: 140 }} /></label>
      <label className="field"><span>توضیح (اختیاری)</span><input className="input" value={description} maxLength={200} placeholder="مثلاً: با برنج ایرانی و ماست" onChange={(e) => setDescription(e.target.value)} /></label>
      <button className="btn primary big" disabled={busy || !categoryId || !name.trim() || priceText === ''} onClick={() => void save()}>{busy ? 'در حال افزودن…' : 'افزودن به منو'}</button>
      <p className="hint">آیتم بعد از افزودن حذف نمی‌شود؛ اگر تمام شد، «موجود است» را خاموش کنید.</p>
    </Modal>
  );
}

const ICONS = ['🍽️', '🥗', '🍢', '🍲', '🍛', '🍔', '🍕', '🍳', '☕', '🫖', '🥤', '🍰', '🍯', '🍨'];
function NewCategoryModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [icon, setIcon] = useState(ICONS[0]);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try { await api.post('/api/menu/categories', { name, icon }); toast(`دستهٔ «${name.trim()}» ساخته شد`, 'ok'); onDone(); }
    catch (e) { toast((e as ApiError).message, 'err'); } finally { setBusy(false); }
  }
  return (
    <Modal title="دستهٔ جدید" onClose={onClose}>
      <label className="field"><span>نام دسته</span><input className="input" value={name} maxLength={60} autoFocus placeholder="مثلاً: غذای روز" onChange={(e) => setName(e.target.value)} /></label>
      <div className="field"><span>نشان</span>
        <div className="emoji-row" role="radiogroup" aria-label="نشان دسته">
          {ICONS.map((i) => <button key={i} type="button" role="radio" aria-checked={icon === i} className={icon === i ? 'on' : ''} onClick={() => setIcon(i)}>{i}</button>)}
        </div>
      </div>
      <button className="btn primary big" disabled={busy || !name.trim()} onClick={() => void save()}>{busy ? 'در حال ساخت…' : 'ساخت دسته'}</button>
    </Modal>
  );
}
