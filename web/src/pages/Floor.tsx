import { useState } from 'react';
import { api, ApiError, uid } from '../api';
import { clock, dur, minutesSince, toFa, toman } from '../fa';
import { useAuth, useLoad, useNow, useToast } from '../hooks';
import { navigate } from '../router';
import type { FloorOrder, FloorTable, Order } from '../types';
import { Empty, Icon, Modal, Skeleton } from '../ui';

function Pips({ c }: { c: FloorOrder['counts'] }) {
  const parts: [keyof typeof c, string][] = [['new', 'n'], ['preparing', 'p'], ['ready', 'r'], ['served', 's']];
  const total = parts.reduce((s, [k]) => s + c[k], 0) || 1;
  return (
    <div className="pip" aria-hidden="true">
      {parts.map(([k, cls]) => (c[k] ? <i key={k} className={cls} style={{ flex: c[k] / total }} /> : null))}
    </div>
  );
}

function tableState(o: FloorOrder | null) {
  if (!o) return 'free';
  if (o.billRequestedAt) return 'bill';
  if (o.counts.ready > 0) return 'ready';
  return 'busy';
}

export default function Floor() {
  const { branchId, me } = useAuth();
  const toast = useToast();
  const now = useNow();
  const { data, loading, error } = useLoad(() => api.get<{ tables: FloorTable[]; takeaway: FloorOrder[] }>(`/api/floor?branchId=${branchId}`), [branchId]);
  const [guestsFor, setGuestsFor] = useState<FloorTable | null>(null);
  const [busy, setBusy] = useState(false);

  async function open(kind: 'dine_in' | 'takeaway', tableId: string | null, guests: number) {
    setBusy(true);
    try {
      const r = await api.post<{ order: Order }>('/api/orders', { branchId, tableId, kind, guests });
      navigate(`/order/${r.order.id}`);
    } catch (e) { toast((e as ApiError).message, 'err'); } finally { setBusy(false); }
  }

  if (loading && !data) return <div className="tables">{Array.from({ length: 12 }, (_, i) => <Skeleton key={i} h={124} />)}</div>;
  if (error && !data) return <Empty title="بارگذاری نشد" hint={error.message} />;
  const tables = data?.tables ?? [];
  const zones = [...new Set(tables.map((t) => t.zone))];
  const occupied = tables.filter((t) => t.order).length;

  return (
    <>
      <div className="row between" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
        <div className="legend">
          <span><i style={{ background: 'var(--lapis)' }} />جدید</span>
          <span><i style={{ background: 'var(--saffron)' }} />در حال تهیه</span>
          <span><i style={{ background: 'var(--pesteh)' }} />آماده تحویل</span>
          <span><i style={{ background: 'var(--line-strong)' }} />سرو شده</span>
        </div>
        <span className="muted">{toFa(occupied)} از {toFa(tables.length)} میز پر است</span>
      </div>

      <section className="zone">
        <h2>بیرون‌بر</h2>
        <div className="takeaway">
          <button className="tbl free" onClick={() => void open('takeaway', null, 1)} disabled={busy} style={{ minWidth: 150, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="bag" size={28} /><b>سفارش بیرون‌بر</b><span className="muted" style={{ fontSize: 12 }}>جدید</span>
          </button>
          {(data?.takeaway ?? []).map((o) => (
            <button key={o.id} className={`tbl ${tableState(o)}`} onClick={() => navigate(`/order/${o.id}`)}>
              <span className="no">#{toFa(o.number)}</span>
              <span className="meta"><Icon name="clock" />{dur(minutesSince(o.openedAt, now))}</span>
              <Pips c={o.counts} />
              <span className="total num">{toman(o.total)}</span>
            </button>
          ))}
        </div>
      </section>

      {zones.map((z) => (
        <section className="zone" key={z}>
          <h2>{z}</h2>
          <div className="tables">
            {tables.filter((t) => t.zone === z).map((t) => {
              const st = tableState(t.order);
              return (
                <button key={t.id} className={`tbl ${st}`} disabled={busy}
                  onClick={() => (t.order ? navigate(`/order/${t.order.id}`) : setGuestsFor(t))}
                  aria-label={`میز ${t.label}${t.order ? '، اشغال' : '، خالی'}`}>
                  <span className="no">{toFa(t.label)}</span>
                  {t.order ? (
                    <>
                      {t.order.billRequestedAt && <span className="chip alert flag">صورتحساب</span>}
                      {!t.order.billRequestedAt && t.order.counts.ready > 0 && <span className="chip ready flag">{toFa(t.order.counts.ready)} آماده</span>}
                      <span className="meta"><Icon name="clock" />{dur(minutesSince(t.order.openedAt, now))} · از {clock(t.order.openedAt)}</span>
                      <Pips c={t.order.counts} />
                      <span className="total num">{toman(t.order.total)}</span>
                    </>
                  ) : (
                    <span className="meta"><Icon name="users" />{toFa(t.seats)} نفره</span>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      ))}
      {tables.length === 0 && <Empty title="میزی تعریف نشده" hint={me?.user.role === 'manager' ? 'ابتدا میزهای شعبه را اضافه کنید.' : 'با مدیر تماس بگیرید.'} />}

      {guestsFor && (
        <Modal title={`میز ${toFa(guestsFor.label)}: چند نفر هستند؟`} onClose={() => setGuestsFor(null)}>
          <div className="quick">
            {Array.from({ length: Math.min(guestsFor.seats + 2, 10) }, (_, i) => i + 1).map((g) => (
              <button key={g} className="btn" style={{ flex: '1 0 64px', minHeight: 64, fontSize: 22, fontWeight: 900 }} disabled={busy}
                onClick={() => { const t = guestsFor; setGuestsFor(null); void open('dine_in', t.id, g); }}>{toFa(g)}</button>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}
