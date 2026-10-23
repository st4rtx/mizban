import { useRef, useState } from 'react';
import { api, ApiError, uid } from '../api';
import { clock, jalaliLong, METHOD_FA, num, toFa, toman } from '../fa';
import { useToast } from '../hooks';
import { navigate } from '../router';
import type { Me, Order } from '../types';
import { Icon, Modal } from '../ui';

const toAscii = (s: string) => s.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[^\d]/g, '');
export const parseAmount = (s: string) => Number(toAscii(s) || 0);

export function Receipt({ order, restaurant }: { order: Order; restaurant: string }) {
  return (
    <div className="receipt">
      <h2>{restaurant}</h2>
      <p style={{ textAlign: 'center' }}>{jalaliLong(order.closedAt ?? order.openedAt)} · {clock(order.closedAt ?? order.openedAt)}<br />
        {order.kind === 'takeaway' ? 'بیرون‌بر' : `میز ${toFa(order.tableLabel ?? '')}`} · شماره {toFa(order.number)}</p>
      <hr />
      <table><tbody>
        {order.items.filter((i) => i.status !== 'void').map((i) => (
          <tr key={i.id}><td>{i.name} × {toFa(i.qty)}</td><td style={{ textAlign: 'left' }}>{num(i.qty * i.unitPrice)}</td></tr>
        ))}
      </tbody></table>
      <hr />
      <table><tbody>
        <tr><td>جمع</td><td style={{ textAlign: 'left' }}>{num(order.totals.subtotal)}</td></tr>
        {order.totals.discount > 0 && <tr><td>تخفیف</td><td style={{ textAlign: 'left' }}>-{num(order.totals.discount)}</td></tr>}
        {order.totals.service > 0 && <tr><td>سرویس</td><td style={{ textAlign: 'left' }}>{num(order.totals.service)}</td></tr>}
        <tr><td>مالیات بر ارزش افزوده</td><td style={{ textAlign: 'left' }}>{num(order.totals.vat)}</td></tr>
        <tr><td><b>قابل پرداخت</b></td><td style={{ textAlign: 'left' }}><b>{num(order.totals.total)}</b></td></tr>
      </tbody></table>
      <hr />
      {order.payments.map((p) => <p key={p.id} style={{ margin: 0 }}>{METHOD_FA[p.method]}: {num(p.amount)}</p>)}
      <p style={{ textAlign: 'center' }}>از حضور شما سپاسگزاریم</p>
    </div>
  );
}

export function CheckoutModal({ order, me, onClose, onUpdate }: { order: Order; me: Me; onClose: () => void; onUpdate: (o: Order) => void }) {
  const toast = useToast();
  const [method, setMethod] = useState<'cash' | 'card' | 'transfer'>('card');
  const [amountText, setAmountText] = useState('');
  const [busy, setBusy] = useState(false);
  const key = useRef(uid());
  const paid = order.status === 'paid';
  const amount = amountText === '' ? order.remaining : parseAmount(amountText);
  const split = (n: number) => setAmountText(String(Math.min(order.remaining, Math.ceil(order.totals.total / n / 1000) * 1000)));

  async function submit() {
    if (amount < 1 || amount > order.remaining) { toast('مبلغ باید بین ۱ و مانده حساب باشد', 'err'); return; }
    setBusy(true);
    try {
      const r = await api.post<{ order: Order }>(`/api/orders/${order.id}/payments`, { method, amount, orderVersion: order.version, idempotencyKey: key.current });
      key.current = uid();
      setAmountText('');
      onUpdate(r.order);
      toast(r.order.status === 'paid' ? 'تسویه شد. میز آزاد شد.' : `${toman(amount)} ثبت شد`, 'ok');
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'bill_changed' && err.details?.current) {
        onUpdate(err.details.current);
        setAmountText('');
        toast('صورتحساب همین الان تغییر کرد. مبلغ جدید را بررسی و دوباره تأیید کنید.', 'err');
      } else if (err.details?.current) {
        onUpdate(err.details.current);
        toast(err.message, 'err');
      } else toast(err.message, 'err'); // a network failure keeps the same idempotency key, so retrying cannot double-charge
    } finally { setBusy(false); }
  }

  return (
    <Modal title={paid ? 'تسویه شد' : 'تسویه حساب'} onClose={onClose}>
      <div className="pay-total">
        <div className="muted">{paid ? 'مبلغ پرداخت‌شده' : order.paidAmount > 0 ? 'مانده حساب' : 'مبلغ قابل پرداخت'}</div>
        <div className="big num">{toman(paid ? order.totals.total : order.remaining)}</div>
      </div>
      <div className="sum">
        <div><span>جمع آیتم‌ها</span><span className="num">{toman(order.totals.subtotal)}</span></div>
        {order.totals.discount > 0 && <div className="disc"><span>تخفیف</span><span className="num">-{toman(order.totals.discount)}</span></div>}
        {order.totals.service > 0 && <div><span>سرویس ({toFa(me.restaurant.servicePct)}٪)</span><span className="num">{toman(order.totals.service)}</span></div>}
        <div><span>مالیات بر ارزش افزوده ({toFa(me.restaurant.vatPct)}٪)</span><span className="num">{toman(order.totals.vat)}</span></div>
        <div className="grand"><span>جمع کل</span><span className="num">{toman(order.totals.total)}</span></div>
      </div>
      {order.payments.length > 0 && (
        <div className="pay-list">
          {order.payments.map((p) => <div className="row between" key={p.id}><span>{METHOD_FA[p.method]} · {p.byName}</span><b className="num">{toman(p.amount)}</b></div>)}
        </div>
      )}
      {!paid ? (
        <>
          <div className="methods" role="radiogroup" aria-label="روش پرداخت">
            {(['card', 'cash', 'transfer'] as const).map((m) => (
              <button key={m} className={method === m ? 'on' : ''} onClick={() => setMethod(m)} role="radio" aria-checked={method === m}>
                <Icon name={m} />{METHOD_FA[m]}
              </button>
            ))}
          </div>
          <label className="field"><span>مبلغ این پرداخت (تومان)</span>
            <input className="input num" inputMode="numeric" value={amountText === '' ? '' : num(amount)} placeholder={num(order.remaining)} onChange={(e) => setAmountText(toAscii(e.target.value))} style={{ fontSize: 22, fontWeight: 700, minHeight: 56 }} />
          </label>
          <div className="quick">
            <button className="btn sm" onClick={() => setAmountText('')}>کل مانده</button>
            {[2, 3, 4, 5].map((n) => <button key={n} className="btn sm" onClick={() => split(n)}>تقسیم بر {toFa(n)}</button>)}
          </div>
          <button className="btn primary big" onClick={() => void submit()} disabled={busy || amount < 1}>
            {busy ? 'در حال ثبت…' : amount === order.remaining ? `ثبت پرداخت و بستن میز` : `ثبت ${toman(amount)} ${METHOD_FA[method]}`}
          </button>
          <p className="muted" style={{ fontSize: 12.5 }}>پرداخت فقط ثبت می‌شود؛ مبلغ را روی کارتخوان هم بزنید.</p>
        </>
      ) : (
        <>
          <button className="btn" onClick={() => window.print()}><Icon name="print" />چاپ رسید</button>
          <button className="btn primary big" onClick={() => navigate('/floor')}>بازگشت به سالن</button>
        </>
      )}
    </Modal>
  );
}

export function DiscountModal({ order, me, onClose, onUpdate }: { order: Order; me: Me; onClose: () => void; onUpdate: (o: Order) => void }) {
  const toast = useToast();
  const isMgr = me.user.role === 'manager';
  const [kind, setKind] = useState<'percent' | 'amount'>(order.discount?.kind ?? 'percent');
  const [value, setValue] = useState(order.discount ? String(order.discount.value) : '');
  const [reason, setReason] = useState(order.discount?.reason ?? '');
  const [busy, setBusy] = useState(false);
  const v = parseAmount(value);
  const effPct = kind === 'percent' ? v : order.totals.subtotal ? (v / order.totals.subtotal) * 100 : 0;
  const over = !isMgr && effPct > order.floorDiscountMaxPct;

  async function save(clear = false) {
    setBusy(true);
    try {
      const r = await api.put<{ order: Order }>(`/api/orders/${order.id}/discount`, clear ? { kind: null, value: 0, version: order.version } : { kind, value: v, reason, version: order.version });
      onUpdate(r.order);
      toast(clear ? 'تخفیف برداشته شد' : 'تخفیف اعمال شد', 'ok');
      onClose();
    } catch (e) {
      const err = e as ApiError;
      if (err.details?.current) onUpdate(err.details.current);
      toast(err.message, 'err');
    } finally { setBusy(false); }
  }

  return (
    <Modal title="تخفیف" onClose={onClose}>
      <div className="seg" style={{ justifySelf: 'start' }}>
        <button className={kind === 'percent' ? 'on' : ''} onClick={() => setKind('percent')}>درصد</button>
        <button className={kind === 'amount' ? 'on' : ''} onClick={() => setKind('amount')}>مبلغ (تومان)</button>
      </div>
      <label className="field"><span>{kind === 'percent' ? 'درصد تخفیف' : 'مبلغ تخفیف'}</span>
        <input className="input num" inputMode="numeric" value={value ? num(v) : ''} onChange={(e) => setValue(toAscii(e.target.value))} style={{ fontSize: 22, fontWeight: 700, minHeight: 56 }} autoFocus />
      </label>
      {!isMgr && <p className="muted" style={{ fontSize: 13 }}>سقف تخفیف شما {toFa(order.floorDiscountMaxPct)}٪ است. بیشتر از آن را مدیر اعمال می‌کند.</p>}
      <div className="quick">
        {['مشتری دائمی', 'تأخیر در سرو', 'تولد', 'جبران اشتباه'].map((r) => <button key={r} className={`btn sm ${reason === r ? 'primary' : ''}`} onClick={() => setReason(r)}>{r}</button>)}
      </div>
      <label className="field"><span>دلیل (ثبت می‌شود)</span><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} /></label>
      {over && <div className="flag-row high">این مقدار از سقف مجاز شما بیشتر است.</div>}
      <button className="btn primary big" disabled={busy || v < 1 || reason.trim().length < 2 || over} onClick={() => void save()}>اعمال تخفیف</button>
      {order.discount && <button className="btn danger" disabled={busy} onClick={() => void save(true)}>برداشتن تخفیف</button>}
    </Modal>
  );
}

export function VoidModal({ name, needReason, onClose, onConfirm }: { name: string; needReason: boolean; onClose: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <Modal title={`لغو «${name}»`} onClose={onClose}>
      {needReason && <p className="muted">این آیتم قبلاً به آشپزخانه رفته. دلیل لغو ثبت و به مدیر گزارش می‌شود.</p>}
      <div className="quick">
        {['شکایت مشتری', 'اشتباه ثبت شد', 'تمام شد', 'تأخیر زیاد'].map((r) => <button key={r} className={`btn sm ${reason === r ? 'primary' : ''}`} onClick={() => setReason(r)}>{r}</button>)}
      </div>
      <label className="field"><span>دلیل</span><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} /></label>
      <button className="btn danger big" disabled={needReason && reason.trim().length < 2} onClick={() => onConfirm(reason)}>لغو آیتم</button>
    </Modal>
  );
}
