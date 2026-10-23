import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, uid } from '../api';
import { dur, minutesSince, STATUS_FA, toFa, toman } from '../fa';
import { useAuth, useLoad, useNow, useToast } from '../hooks';
import { navigate } from '../router';
import type { MenuCategory, Order, OrderItem } from '../types';
import { Empty, Icon, Skeleton } from '../ui';
import { CheckoutModal, DiscountModal, Receipt, VoidModal } from './Checkout';

interface CartLine { menuItemId: string; name: string; price: number; station: 'kitchen' | 'bar'; qty: number; note: string }

const loadCart = (id: string): CartLine[] => { try { return JSON.parse(sessionStorage.getItem(`mz_cart_${id}`) ?? '[]'); } catch { return []; } };

export default function OrderPage({ id }: { id: string }) {
  const { me } = useAuth();
  const toast = useToast();
  const now = useNow();
  const { data, error, setData, reload } = useLoad(() => api.get<{ order: Order }>(`/api/orders/${id}`), [id]);
  const menu = useLoad(() => api.get<{ categories: MenuCategory[] }>('/api/menu'), [], 60000);
  const order = data?.order ?? null;
  const [cart, setCart] = useState<CartLine[]>(() => loadCart(id));
  const [cat, setCat] = useState<string>('');
  const [q, setQ] = useState('');
  const [sheet, setSheet] = useState(false);
  const [modal, setModal] = useState<'pay' | 'discount' | null>(null);
  const [voiding, setVoiding] = useState<OrderItem | null>(null);
  const [sending, setSending] = useState(false);
  const requestId = useRef<{ id: string; sig: string } | null>(null);

  useEffect(() => { try { sessionStorage.setItem(`mz_cart_${id}`, JSON.stringify(cart)); } catch { /* ignore */ } }, [cart, id]);
  const cats = menu.data?.categories ?? [];
  useEffect(() => { if (!cat && cats.length) setCat(cats[0].id); }, [cats, cat]);

  const updateOrder = (o: Order) => setData({ order: o });
  const readOnly = !order || order.status !== 'open';
  const isMgr = me!.user.role === 'manager';

  const visible = useMemo(() => {
    const term = q.trim();
    if (term) return cats.flatMap((c) => c.items).filter((i) => i.name.includes(term));
    return cats.find((c) => c.id === cat)?.items ?? [];
  }, [cats, cat, q]);

  const qtyOf = (menuItemId: string) => cart.find((l) => l.menuItemId === menuItemId)?.qty ?? 0;
  function add(m: { id: string; name: string; price: number; station: 'kitchen' | 'bar' }, delta = 1) {
    setCart((c) => {
      const i = c.findIndex((l) => l.menuItemId === m.id);
      if (i < 0) return delta > 0 ? [...c, { menuItemId: m.id, name: m.name, price: m.price, station: m.station, qty: 1, note: '' }] : c;
      const qty = c[i].qty + delta;
      return qty <= 0 ? c.filter((_, j) => j !== i) : c.map((l, j) => (j === i ? { ...l, qty: Math.min(qty, 99) } : l));
    });
  }
  const cartTotal = cart.reduce((s, l) => s + l.qty * l.price, 0);
  const cartCount = cart.reduce((s, l) => s + l.qty, 0);

  async function send() {
    if (!cart.length || sending) return;
    const sig = JSON.stringify(cart);
    // same cart = same request id: a retry after a dropped connection can never create the dishes twice
    if (requestId.current?.sig !== sig) requestId.current = { id: uid(), sig };
    setSending(true);
    try {
      const r = await api.post<{ order: Order }>(`/api/orders/${id}/items`, {
        requestId: requestId.current.id,
        items: cart.map((l) => ({ menuItemId: l.menuItemId, qty: l.qty, note: l.note.trim() || null })),
      });
      updateOrder(r.order);
      setCart([]);
      requestId.current = null;
      setSheet(false);
      toast('به آشپزخانه و بار ارسال شد', 'ok');
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'item_unavailable') {
        const gone: string[] = err.details?.current?.unavailableIds ?? [];
        setCart((c) => c.filter((l) => !gone.includes(l.menuItemId)));
        void menu.reload();
      } else if (err.details?.current) updateOrder(err.details.current);
      toast(err.message, 'err');
    } finally { setSending(false); }
  }

  async function setStatus(item: OrderItem, to: 'served') {
    try {
      const r = await api.patch<{ order: Order }>(`/api/order-items/${item.id}/status`, { to, version: item.version });
      updateOrder(r.order);
    } catch (e) {
      toast((e as ApiError).message, 'err');
      void reload();
    }
  }
  async function voidIt(item: OrderItem, reason: string) {
    setVoiding(null);
    try {
      const r = await api.post<{ order: Order }>(`/api/order-items/${item.id}/void`, { reason: reason || null, version: item.version });
      updateOrder(r.order);
      toast('آیتم لغو شد');
    } catch (e) {
      toast((e as ApiError).message, 'err');
      void reload();
    }
  }
  async function billRequest() {
    try { updateOrder((await api.post<{ order: Order }>(`/api/orders/${id}/bill-request`)).order); toast('صورتحساب درخواست شد', 'ok'); }
    catch (e) { toast((e as ApiError).message, 'err'); }
  }
  async function voidOrder() {
    const reason = window.prompt?.('دلیل ابطال سفارش:') ?? '';
    if (reason.trim().length < 2) return;
    try { updateOrder((await api.post<{ order: Order }>(`/api/orders/${id}/void`, { reason })).order); navigate('/floor'); }
    catch (e) { toast((e as ApiError).message, 'err'); }
  }

  if (error && !order) return <Empty title="سفارش پیدا نشد" hint={error.message} />;
  if (!order) return <Skeleton h={400} />;

  const rounds = [...new Set(order.items.map((i) => i.round))];
  const unsentBadge = cartCount ? <span className="chip new">{toFa(cartCount)} در انتظار ارسال</span> : null;

  return (
    <div className="order">
      <section className="menu-pane">
        <div className="row" style={{ marginBottom: 10 }}>
          <button className="btn sm" onClick={() => navigate('/floor')}><Icon name="chevron" />سالن</button>
          <input className="input" placeholder="جستجوی آیتم…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 360 }} aria-label="جستجو در منو" />
        </div>
        {!q && (
          <div className="cats" role="tablist">
            {cats.map((c) => <button key={c.id} role="tab" aria-selected={cat === c.id} className={cat === c.id ? 'on' : ''} onClick={() => setCat(c.id)}><span>{c.icon}</span>{c.name}</button>)}
          </div>
        )}
        {menu.loading && !cats.length ? <div className="items">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} h={140} />)}</div> : (
          <div className="items">
            {visible.map((m) => {
              const n = qtyOf(m.id);
              const icon = cats.find((c) => c.items.some((x) => x.id === m.id))?.icon;
              return (
                <button key={m.id} className={`mi ${m.station === 'bar' ? 'bar' : ''} ${m.available && !readOnly ? '' : 'off'}`} onClick={() => add(m)} disabled={!m.available || readOnly} aria-label={`${m.name}، ${toman(m.price)}`}>
                  {n > 0 && <span className="qty">{toFa(n)}</span>}
                  <span className="ico">{icon}</span>
                  <span className="name">{m.name}</span>
                  <span className="price num">{m.available ? toman(m.price) : 'تمام شد'}</span>
                </button>
              );
            })}
            {visible.length === 0 && <Empty title="چیزی پیدا نشد" />}
          </div>
        )}
      </section>

      {cartCount > 0 && !sheet && (
        <button className="cartbar" onClick={() => setSheet(true)}><span>سفارش را ببین ({toFa(cartCount)})</span><span className="num">{toman(cartTotal)}</span></button>
      )}

      <aside className={`ticket card ${sheet ? 'open' : ''}`} aria-label="صورت سفارش">
        <div className="head row between">
          <div>
            <h2>{order.kind === 'takeaway' ? `بیرون‌بر #${toFa(order.number)}` : `میز ${toFa(order.tableLabel ?? '')}`}</h2>
            <span className="muted" style={{ fontSize: 13 }}>{order.tableZone ? `${order.tableZone} · ` : ''}{toFa(order.guests)} نفر · {dur(minutesSince(order.openedAt, now))} · {order.openedByName}</span>
          </div>
          <button className="x" style={{ display: sheet ? 'grid' : 'none' }} onClick={() => setSheet(false)} aria-label="بستن"><Icon name="x" /></button>
        </div>
        <div className="scroll">
          {order.status === 'paid' && <div className="flag-row info" style={{ margin: '10px 0' }}>این سفارش تسویه شده است.</div>}
          {order.status === 'void' && <div className="flag-row high" style={{ margin: '10px 0' }}>این سفارش ابطال شده است.</div>}
          {cart.length > 0 && (
            <>
              <div className="sec-title">در انتظار ارسال {unsentBadge}</div>
              <div className="draft">
                {cart.map((l) => (
                  <div className="line" key={l.menuItemId}>
                    <span className="nm">{l.name}</span>
                    <span className="num">{toman(l.qty * l.price)}</span>
                    <div className="act">
                      <div className="stepper">
                        <button onClick={() => add({ id: l.menuItemId, name: l.name, price: l.price, station: l.station }, -1)} aria-label="کم کردن"><Icon name="minus" /></button>
                        <b>{toFa(l.qty)}</b>
                        <button onClick={() => add({ id: l.menuItemId, name: l.name, price: l.price, station: l.station }, 1)} aria-label="زیاد کردن"><Icon name="plus" /></button>
                      </div>
                      <input className="input" style={{ flex: 1, minHeight: 40, minWidth: 120 }} placeholder="توضیح (مثلاً بدون پیاز)" maxLength={120} value={l.note}
                        onChange={(e) => setCart((c) => c.map((x) => (x.menuItemId === l.menuItemId ? { ...x, note: e.target.value } : x)))} />
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          {rounds.map((r) => (
            <div key={r}>
              <div className="sec-title">ارسال {toFa(r)}</div>
              {order.items.filter((i) => i.round === r).map((i) => (
                <div className="line" key={i.id}>
                  <span className="nm">{toFa(i.qty)}× {i.name}</span>
                  <span className={`num ${i.status === 'void' ? 'muted' : ''}`} style={i.status === 'void' ? { textDecoration: 'line-through' } : undefined}>{toman(i.qty * i.unitPrice)}</span>
                  {i.note && <span className="nt">{i.note}</span>}
                  <div className="act">
                    <span className={`chip ${i.status}`}>{STATUS_FA[i.status]}</span>
                    {i.status === 'void' && i.voidReason && <span className="muted" style={{ fontSize: 12.5 }}>{i.voidReason}</span>}
                    {!readOnly && i.status === 'ready' && <button className="btn sm primary" onClick={() => void setStatus(i, 'served')}><Icon name="check" />سرو شد</button>}
                    {!readOnly && i.status !== 'void' && (isMgr || i.status === 'new') && (
                      <button className="btn sm danger" onClick={() => (i.status === 'new' ? void voidIt(i, '') : setVoiding(i))}>لغو</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ))}
          {order.items.length === 0 && cart.length === 0 && <Empty title="هنوز چیزی ثبت نشده" hint="از منو آیتم‌ها را انتخاب کنید." />}
        </div>
        <div className="foot">
          <div className="sum">
            <div><span>جمع</span><span className="num">{toman(order.totals.subtotal)}</span></div>
            {order.totals.discount > 0 && <div className="disc"><span>تخفیف{order.discount?.reason ? ` (${order.discount.reason})` : ''}</span><span className="num">-{toman(order.totals.discount)}</span></div>}
            {order.totals.service > 0 && <div><span>سرویس ({toFa(me!.restaurant.servicePct)}٪)</span><span className="num">{toman(order.totals.service)}</span></div>}
            <div><span>ارزش افزوده ({toFa(me!.restaurant.vatPct)}٪)</span><span className="num">{toman(order.totals.vat)}</span></div>
            <div className="grand"><span>قابل پرداخت</span><span className="num">{toman(order.totals.total)}</span></div>
          </div>
          {cart.length > 0 && !readOnly && (
            <button className="btn primary big" disabled={sending} onClick={() => void send()}>{sending ? 'در حال ارسال…' : `ارسال به آشپزخانه و بار (${toFa(cartCount)})`}</button>
          )}
          {order.status === 'open' && (
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <button className={`btn ${cart.length ? '' : 'ink'}`} style={{ flex: 1 }} disabled={order.items.every((i) => i.status === 'void') || cart.length > 0} onClick={() => setModal('pay')}><Icon name="receipt" />تسویه</button>
              <button className="btn" onClick={() => setModal('discount')}><Icon name="tag" />تخفیف</button>
              {order.kind === 'dine_in' && <button className="btn" disabled={!!order.billRequestedAt} onClick={() => void billRequest()}><Icon name="bell" />{order.billRequestedAt ? 'درخواست شد' : 'صورتحساب'}</button>}
            </div>
          )}
          {order.status === 'paid' && <button className="btn" onClick={() => setModal('pay')}><Icon name="print" />رسید</button>}
          {isMgr && order.status === 'open' && order.payments.length === 0 && <button className="btn danger sm" onClick={() => void voidOrder()}>ابطال کل سفارش</button>}
          {cart.length > 0 && !readOnly && <button className="btn sm" onClick={() => setCart([])}>پاک کردن انتخاب‌ها</button>}
        </div>
      </aside>

      {modal === 'pay' && <CheckoutModal order={order} me={me!} onClose={() => setModal(null)} onUpdate={updateOrder} />}
      {modal === 'discount' && <DiscountModal order={order} me={me!} onClose={() => setModal(null)} onUpdate={updateOrder} />}
      {voiding && <VoidModal name={voiding.name} needReason={voiding.status !== 'new'} onClose={() => setVoiding(null)} onConfirm={(r) => void voidIt(voiding, r)} />}
      <Receipt order={order} restaurant={me!.restaurant.name} />
    </div>
  );
}
