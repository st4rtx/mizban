import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { minutesSince, toFa } from '../fa';
import { useAuth, useLoad, useNow, useToast } from '../hooks';
import type { ItemStatus, KitchenItem } from '../types';
import { Empty, Icon, Skeleton } from '../ui';

const NEXT: Partial<Record<ItemStatus, ItemStatus>> = { new: 'preparing', preparing: 'ready' };
const COLS: { key: ItemStatus; cls: string; title: string; verb: string }[] = [
  { key: 'new', cls: 'n', title: 'جدید', verb: 'شروع تهیه' },
  { key: 'preparing', cls: 'p', title: 'در حال تهیه', verb: 'آماده شد' },
  { key: 'ready', cls: 'r', title: 'آماده تحویل', verb: '' },
];

function beep() {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.45);
  } catch { /* audio blocked until first tap; the visual is the primary signal */ }
}

export default function Kitchen() {
  const { branchId, me } = useAuth();
  const toast = useToast();
  const now = useNow(15000);
  const [station, setStation] = useState<'all' | 'kitchen' | 'bar'>(() => (localStorage.getItem('mz_station') as 'all') || 'all');
  const [sound, setSound] = useState(() => localStorage.getItem('mz_sound') !== 'off');
  const { data, loading, error, reload, setData } = useLoad(
    () => api.get<{ items: KitchenItem[] }>(`/api/kitchen?branchId=${branchId}${station === 'all' ? '' : `&station=${station}`}`),
    [branchId, station],
    10000,
  );
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => { try { localStorage.setItem('mz_station', station); } catch { /* ignore */ } }, [station]);
  useEffect(() => { try { localStorage.setItem('mz_sound', sound ? 'on' : 'off'); } catch { /* ignore */ } }, [sound]);

  // Ping when a ticket we have not seen before arrives (not on first load).
  useEffect(() => {
    if (!data) return;
    const ids = new Set(data.items.filter((i) => i.status === 'new').map((i) => i.id));
    if (seen.current && sound && [...ids].some((id) => !seen.current!.has(id))) beep();
    seen.current = ids;
  }, [data, sound]);

  async function advance(items: KitchenItem[]) {
    // optimistic: move the cards now, repair from the server if the tap lost a race
    const targets = items.filter((i) => NEXT[i.status]);
    setData((d) => d && { items: d.items.map((i) => (targets.some((t) => t.id === i.id) ? { ...i, status: NEXT[i.status]! } : i)) } as never);
    const results = await Promise.allSettled(targets.map((i) => api.patch(`/api/order-items/${i.id}/status`, { to: NEXT[i.status], version: i.version })));
    const lost = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    if (lost.length) toast((lost[0].reason as ApiError).code === 'item_changed' ? 'یک آیتم همزمان تغییر کرد؛ صفحه به‌روز شد' : (lost[0].reason as ApiError).message, 'err');
    void reload();
  }
  async function back(item: KitchenItem) {
    const to = item.status === 'ready' ? 'preparing' : 'new';
    try { await api.patch(`/api/order-items/${item.id}/status`, { to, version: item.version }); } catch (e) { toast((e as ApiError).message, 'err'); }
    void reload();
  }

  const items = data?.items ?? [];
  const grouped = useMemo(() => {
    const out: Record<string, { orderId: string; num: number; label: string; kind: string; since: string; items: KitchenItem[] }[]> = { new: [], preparing: [], ready: [] };
    for (const col of COLS) {
      const byOrder = new Map<string, KitchenItem[]>();
      for (const i of items.filter((x) => x.status === col.key)) byOrder.set(i.orderId, [...(byOrder.get(i.orderId) ?? []), i]);
      out[col.key] = [...byOrder.values()].map((list) => ({
        orderId: list[0].orderId, num: list[0].orderNumber, kind: list[0].kind,
        label: list[0].kind === 'takeaway' ? 'بیرون‌بر' : toFa(list[0].tableLabel ?? ''),
        since: list.reduce((a, b) => (a < b.createdAt ? a : b.createdAt), list[0].createdAt), items: list,
      })).sort((a, b) => a.since.localeCompare(b.since));
    }
    return out;
  }, [items]);

  if (loading && !data) return <div className="kds">{[0, 1, 2].map((i) => <Skeleton key={i} h={300} />)}</div>;
  if (error && !data) return <Empty title="بارگذاری نشد" hint={error.message} />;

  return (
    <>
      <div className="kbar">
        <div className="seg" role="tablist" aria-label="بخش">
          {([['all', 'همه'], ['kitchen', 'آشپزخانه'], ['bar', 'بار']] as const).map(([k, l]) => <button key={k} className={station === k ? 'on' : ''} onClick={() => setStation(k)}>{l}</button>)}
        </div>
        <button className={`btn sm ${sound ? '' : 'danger'}`} onClick={() => { setSound(!sound); if (!sound) beep(); }}><Icon name="bell" />{sound ? 'صدا روشن' : 'صدا خاموش'}</button>
        <span className="muted">{me?.user.role === 'kitchen' ? 'روی هر آیتم بزنید تا به مرحله بعد برود.' : ''}</span>
      </div>
      <div className="kds">
        {COLS.map((col) => (
          <section key={col.key} className={`kcol ${col.cls}`}>
            <h2><i />{col.title}<b>{toFa(grouped[col.key].reduce((s, g) => s + g.items.length, 0))}</b></h2>
            <div className="stack">
              {grouped[col.key].map((g) => {
                const min = minutesSince(g.since, now);
                const cls = col.key === 'ready' ? (min > 10 ? 'warn' : '') : min >= 20 ? 'late' : min >= 12 ? 'warn' : '';
                return (
                  <article key={g.orderId} className={`card tk ${cls}`}>
                    <div className="th">
                      <span className="tn">{g.label}<small>#{toFa(g.num)}</small></span>
                      <span className="timer num"><Icon name="clock" size={14} /> {toFa(min)} دقیقه</span>
                    </div>
                    {g.items.map((i) => (
                      <button key={i.id} className="kitem" onClick={() => (NEXT[i.status] ? void advance([i]) : void back(i))} aria-label={`${i.name}، ${col.verb || 'برگرداندن به تهیه'}`}>
                        <span className="q num">{toFa(i.qty)}</span>
                        <span><span className="nm">{i.name}</span>{i.note && <><br /><span className="nt">{i.note}</span></>}{i.round > 1 && <><br /><span className="muted" style={{ fontSize: 12 }}>ارسال {toFa(i.round)}</span></>}</span>
                        <span className="go">{col.verb ? <Icon name="chevron" /> : <span className="chip ready">تحویل با گارسون</span>}</span>
                      </button>
                    ))}
                    {col.verb && g.items.length > 1 && <button className="all" onClick={() => void advance(g.items)}>همه: {col.verb}</button>}
                  </article>
                );
              })}
              {grouped[col.key].length === 0 && <div className="empty" style={{ padding: 24 }}>خالی</div>}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
