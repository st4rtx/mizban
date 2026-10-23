/**
 * Docs:
 * - Page: /docs/features/menu-and-floor-setup.md
 * Manager-only: how many tables the branch has and which zones they sit in.
 */
import { useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import { toFa } from '../fa';
import { useAuth, useLoad, useToast } from '../hooks';
import type { AdminTable } from '../types';
import { Empty, Icon, Modal, Skeleton } from '../ui';

const NEW_ZONE = '__new__';

function ZonePicker({ zones, value, onChange }: { zones: string[]; value: string; onChange: (v: string) => void }) {
  const isNew = value === NEW_ZONE || !zones.includes(value);
  const [draft, setDraft] = useState(isNew && value !== NEW_ZONE ? value : '');
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <select className="select" style={{ width: '100%', minHeight: 46 }} value={isNew ? NEW_ZONE : value} aria-label="بخش"
        onChange={(e) => (e.target.value === NEW_ZONE ? (onChange(draft || NEW_ZONE), undefined) : onChange(e.target.value))}>
        {zones.map((z) => <option key={z} value={z}>{z}</option>)}
        <option value={NEW_ZONE}>+ بخش جدید…</option>
      </select>
      {isNew && (
        <input className="input" placeholder="نام بخش جدید (مثلاً بام، حیاط، طبقه بالا)" maxLength={40} value={draft} autoFocus
          onChange={(e) => { setDraft(e.target.value); onChange(e.target.value || NEW_ZONE); }} />
      )}
    </div>
  );
}

function Counter({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange: (n: number) => void; label: string }) {
  return (
    <div className="stepper lg" role="group" aria-label={label}>
      <button type="button" onClick={() => onChange(Math.max(min, value - 1))} aria-label="کم کردن"><Icon name="minus" /></button>
      <b className="num">{toFa(value)}</b>
      <button type="button" onClick={() => onChange(Math.min(max, value + 1))} aria-label="زیاد کردن"><Icon name="plus" /></button>
    </div>
  );
}

export default function Tables() {
  const { branchId } = useAuth();
  const toast = useToast();
  const { data, loading, error, reload } = useLoad(() => api.get<{ tables: AdminTable[] }>(`/api/admin/tables?branchId=${branchId}`), [branchId], 30000);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AdminTable | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  const tables = data?.tables ?? [];
  const zones = useMemo(() => [...new Set(tables.map((t) => t.zone))], [tables]);
  const active = tables.filter((t) => t.active).length;
  const nextNumber = Math.max(0, ...tables.map((t) => (/^\d{1,6}$/.test(t.label) ? Number(t.label) : 0))) + 1;

  if (loading && !data) return <div className="tables">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} h={92} />)}</div>;
  if (error && !data) return <Empty title="بارگذاری نشد" hint={error.message} />;

  return (
    <>
      <div className="toolbar">
        <span style={{ fontWeight: 700, fontSize: 17 }}>{toFa(active)} میز فعال در {toFa(new Set(tables.filter((t) => t.active).map((t) => t.zone)).size)} بخش</span>
        {tables.length > active && <span className="hint">({toFa(tables.length - active)} میز غیرفعال)</span>}
        <span className="grow" />
        <button className="btn primary" onClick={() => setAdding(true)}><Icon name="plus" />افزودن میز</button>
      </div>
      <p className="hint" style={{ marginBottom: 16 }}>روی هر میز بزنید تا شماره، بخش یا ظرفیتش را عوض کنید. میز حذف نمی‌شود، «غیرفعال» می‌شود تا سفارش‌های قدیمی سالم بمانند.</p>

      {zones.map((z) => {
        const list = tables.filter((t) => t.zone === z);
        return (
          <section className="zone" key={z}>
            <div className="zonebar">
              <h2>{z}</h2><span className="count">{toFa(list.filter((t) => t.active).length)} میز</span>
              <button className="btn sm" onClick={() => setRenaming(z)}>تغییر نام بخش</button>
            </div>
            <div className="tables">
              {list.map((t) => (
                <button key={t.id} className={`tbl tadm ${t.active ? 'free' : 'inactive'}`} onClick={() => setEditing(t)} aria-label={`میز ${t.label}، ${t.active ? 'فعال' : 'غیرفعال'}`}>
                  <span className="no" style={{ color: t.active ? 'var(--ink)' : 'var(--ink-3)' }}>{toFa(t.label)}</span>
                  <span className="meta"><Icon name="users" />{toFa(t.seats)} نفره</span>
                  {!t.active && <span className="chip">غیرفعال</span>}
                  {t.busy && <span className="chip preparing">سفارش باز</span>}
                </button>
              ))}
            </div>
          </section>
        );
      })}
      {tables.length === 0 && <Empty title="این شعبه هنوز میزی ندارد" hint="با «افزودن میز» شروع کنید؛ می‌توانید چند میز را یک‌جا بسازید." />}

      {adding && <AddModal zones={zones} nextNumber={nextNumber} branchId={branchId} onClose={() => setAdding(false)} onDone={() => { setAdding(false); void reload(); }} />}
      {editing && <EditModal table={editing} zones={zones} onClose={() => setEditing(null)} onDone={() => { setEditing(null); void reload(); }} />}
      {renaming && <RenameModal zone={renaming} branchId={branchId} onClose={() => setRenaming(null)} onDone={() => { setRenaming(null); void reload(); }} />}
    </>
  );

}

/* Modals live at module level on purpose: defined inside Tables they would remount on every live refresh and lose what the manager is typing. */

function AddModal(p: { zones: string[]; nextNumber: number; branchId: string; onClose: () => void; onDone: () => void }) {
  const [zone, setZone] = useState(p.zones[0] ?? NEW_ZONE);
  const [count, setCount] = useState(1);
  const [seats, setSeats] = useState(4);
  const [label, setLabel] = useState('');
  const toast = useToast();
  const fail = (e: unknown) => toast((e as ApiError).message, 'err');
  const [busy, setBusy] = useState(false);
  const zoneName = zone === NEW_ZONE ? '' : zone.trim();
  const from = p.nextNumber, to = p.nextNumber + count - 1;
  async function save() {
    setBusy(true);
    try {
      const r = await api.post<{ tables: AdminTable[] }>('/api/admin/tables', { branchId: p.branchId, zone: zoneName, seats, count, label: count === 1 && label.trim() ? label.trim() : undefined });
      toast(r.tables.length === 1 ? `میز ${toFa(r.tables[0].label)} اضافه شد` : `${toFa(r.tables.length)} میز اضافه شد`, 'ok');
      p.onDone();
    } catch (e) { fail(e); } finally { setBusy(false); }
  }
  return (
    <Modal title="افزودن میز" onClose={p.onClose}>
      <label className="field"><span>بخش</span><ZonePicker zones={p.zones} value={zone} onChange={setZone} /></label>
      <div className="field"><span>چند میز؟</span><Counter value={count} min={1} max={50} onChange={setCount} label="تعداد میز" /></div>
      <div className="field"><span>هر میز چند نفره است؟</span><Counter value={seats} min={1} max={40} onChange={setSeats} label="ظرفیت" /></div>
      {count === 1 ? (
        <label className="field"><span>شماره یا نام میز (اختیاری)</span><input className="input" value={label} maxLength={10} placeholder={`خودکار: ${toFa(from)}`} onChange={(e) => setLabel(e.target.value)} /></label>
      ) : <p className="hint">شماره‌ها خودکار ادامه پیدا می‌کنند: میز {toFa(from)} تا {toFa(to)}.</p>}
      <button className="btn primary big" disabled={busy || !zoneName} onClick={() => void save()}>{busy ? 'در حال ساخت…' : count === 1 ? 'افزودن میز' : `افزودن ${toFa(count)} میز`}</button>
    </Modal>
  );
}
function EditModal(p: { table: AdminTable; zones: string[]; onClose: () => void; onDone: () => void }) {
  const t = p.table;
  const [label, setLabel] = useState(t.label);
  const [zone, setZone] = useState(t.zone);
  const [seats, setSeats] = useState(t.seats);
  const toast = useToast();
  const fail = (e: unknown) => toast((e as ApiError).message, 'err');
  const [busy, setBusy] = useState(false);
  const zoneName = zone === NEW_ZONE ? '' : zone.trim();
  async function patch(body: object, ok: string) {
    setBusy(true);
    try { await api.patch(`/api/admin/tables/${t.id}`, body); toast(ok, 'ok'); p.onDone(); } catch (e) { fail(e); } finally { setBusy(false); }
  }
  return (
    <Modal title={`میز ${toFa(t.label)}`} onClose={p.onClose}>
      <label className="field"><span>شماره یا نام میز</span><input className="input" value={label} maxLength={10} onChange={(e) => setLabel(e.target.value)} /></label>
      <label className="field"><span>بخش</span><ZonePicker zones={p.zones} value={zone} onChange={setZone} /></label>
      <div className="field"><span>ظرفیت</span><Counter value={seats} min={1} max={40} onChange={setSeats} label="ظرفیت" /></div>
      <button className="btn primary big" disabled={busy || !label.trim() || !zoneName} onClick={() => void patch({ label: label.trim(), zone: zoneName, seats }, 'ذخیره شد')}>ذخیره</button>
      {t.active ? (
        <button className="btn danger" disabled={busy || t.busy} onClick={() => void patch({ active: false }, 'میز از سالن برداشته شد')}>
          {t.busy ? 'سفارش باز دارد؛ اول تسویه کنید' : 'برداشتن از سالن (غیرفعال)'}
        </button>
      ) : <button className="btn" disabled={busy} onClick={() => void patch({ active: true }, 'میز دوباره فعال شد')}>فعال کردن دوباره</button>}
    </Modal>
  );
}
function RenameModal(p: { zone: string; branchId: string; onClose: () => void; onDone: () => void }) {
  const [to, setTo] = useState(p.zone);
  const toast = useToast();
  const fail = (e: unknown) => toast((e as ApiError).message, 'err');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try { await api.patch('/api/admin/zones', { branchId: p.branchId, from: p.zone, to: to.trim() }); toast('نام بخش عوض شد', 'ok'); p.onDone(); } catch (e) { fail(e); } finally { setBusy(false); }
  }
  return (
    <Modal title={`تغییر نام «${p.zone}»`} onClose={p.onClose}>
      <label className="field"><span>نام جدید</span><input className="input" value={to} maxLength={40} autoFocus onChange={(e) => setTo(e.target.value)} /></label>
      <p className="hint">اگر نامی را بدهید که بخش دیگری دارد، دو بخش یکی می‌شوند.</p>
      <button className="btn primary big" disabled={busy || !to.trim() || to.trim() === p.zone} onClick={() => void save()}>تغییر نام</button>
    </Modal>
  );
}
