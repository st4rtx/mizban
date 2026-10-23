import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { businessDay, dayToDate, faPercent, jalaliLong, METHOD_FA, num, toFa, toman } from '../fa';
import { useAuth, useLoad } from '../hooks';
import { Empty, Icon, Skeleton } from '../ui';

interface Metrics {
  summary: { orders: number; sales: number; subtotal: number; discount: number; guests: number; avgTicket: number };
  hourly: { hour: number; sales: number; orders: number }[];
  topItems: { name: string; qty: number; revenue: number }[];
  paymentMix: { method: 'cash' | 'card' | 'transfer'; amount: number }[];
  discounts: { by: string; orders: number; amount: number; maxPct: number }[];
  voids: { total: number; afterCooking: number; value: number };
  kitchen: { station: string; avgMinutes: number; p90Minutes: number; items: number }[];
  baseline: { weekdayAvgSales: number | null; samples: number };
}
interface Anomaly { code: string; severity: 'info' | 'warn' | 'high'; text: string }
interface Brief { source: 'ai' | 'template'; text: string; generatedAt: string }
const MIX_COLOR = { card: 'var(--firouzeh)', cash: 'var(--saffron)', transfer: 'var(--lapis)' } as const;

export default function Report() {
  const { branchId } = useAuth();
  const [offset, setOffset] = useState(-1); // default: yesterday, a finished business day
  const day = businessDay(offset);
  const { data, loading, error } = useLoad(() => api.get<{ metrics: Metrics; anomalies: Anomaly[] }>(`/api/reports/day?branchId=${branchId}&date=${day}`), [branchId, day], 60000);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [briefErr, setBriefErr] = useState('');
  const [briefBusy, setBriefBusy] = useState(false);

  async function loadBrief() {
    setBriefBusy(true); setBriefErr('');
    try { setBrief(await api.post<Brief>('/api/reports/day/brief', { branchId, date: day })); }
    catch (e) { setBriefErr((e as ApiError).message); }
    finally { setBriefBusy(false); }
  }
  useEffect(() => { setBrief(null); void loadBrief(); }, [branchId, day]); // eslint-disable-line react-hooks/exhaustive-deps

  const m = data?.metrics;
  const base = m?.baseline.weekdayAvgSales;
  const delta = m && base ? Math.round(((m.summary.sales - base) / base) * 100) : null;
  const peak = m?.hourly.reduce((a, b) => (b.sales > a.sales ? b : a), { hour: -1, sales: 0, orders: 0 });
  const hours = m && m.hourly.length ? Array.from({ length: m.hourly[m.hourly.length - 1].hour - m.hourly[0].hour + 1 }, (_, i) => m.hourly[0].hour + i) : [];
  const maxSales = Math.max(1, ...(m?.hourly.map((h) => h.sales) ?? [1]));
  const maxQty = Math.max(1, ...(m?.topItems.map((t) => t.qty) ?? [1]));
  const mixTotal = m?.paymentMix.reduce((s, p) => s + p.amount, 0) || 1;

  return (
    <div>
      <div className="row between" style={{ marginBottom: 16, flexWrap: 'wrap' }}>
        <div className="daynav">
          <button className="btn" onClick={() => setOffset(offset - 1)} aria-label="روز قبل" style={{ transform: 'scaleX(-1)' }}><Icon name="chevron" /></button>
          <div style={{ minWidth: 190, textAlign: 'center', fontWeight: 700 }}>{jalaliLong(dayToDate(day))}</div>
          <button className="btn" onClick={() => setOffset(Math.min(0, offset + 1))} disabled={offset >= 0} aria-label="روز بعد"><Icon name="chevron" /></button>
        </div>
        <span className="muted" style={{ fontSize: 13 }}>روز کاری از ۴ صبح تا ۴ صبح روز بعد حساب می‌شود</span>
      </div>

      <section className="card panel brief" style={{ marginBottom: 16 }}>
        <div className="row between" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0, display: 'flex', gap: 8, alignItems: 'center' }}><Icon name="sparkle" size={20} /> خلاصه روز برای مدیر</h2>
          <button className="btn sm" onClick={() => void loadBrief()} disabled={briefBusy}><Icon name="refresh" />{briefBusy ? 'در حال نوشتن…' : 'بازنویسی'}</button>
        </div>
        {briefBusy && !brief ? <div style={{ display: 'grid', gap: 10 }}><Skeleton h={16} /><Skeleton h={16} w="92%" /><Skeleton h={16} w="70%" /></div>
          : brief ? (<>
            <p>{brief.text}</p>
            <div className="src" style={{ marginTop: 8 }}>{brief.source === 'ai' ? 'متن را هوش مصنوعی از روی همین اعداد نوشته؛ اعداد را سیستم حساب کرده.' : 'گزارش خودکار ساده (سرویس هوش مصنوعی در دسترس نبود یا خروجی‌اش تأیید نشد).'}</div>
          </>) : briefErr ? <p className="muted">{briefErr}</p> : null}
        {data && data.anomalies.length > 0 && (
          <div className="flags">
            {data.anomalies.map((a) => <div key={a.code + a.text} className={`flag-row ${a.severity}`}>{a.text}</div>)}
          </div>
        )}
      </section>

      {loading && !m ? <div className="kpis">{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={96} />)}</div>
        : error && !m ? <Empty title="گزارش بارگذاری نشد" hint={error.message} />
        : m && m.summary.orders === 0 ? <Empty title="این روز فروشی ثبت نشده" hint="روز دیگری را انتخاب کنید." />
        : m && (<>
          <div className="kpis">
            <div className="card kpi"><small>فروش</small><div className="v num">{num(m.summary.sales)}<small>تومان</small></div>
              {delta !== null && <div className={`d ${delta >= 0 ? 'up' : 'down'}`}>{faPercent(Math.abs(delta))} {delta >= 0 ? 'بیشتر' : 'کمتر'} از میانگین همین روز هفته</div>}</div>
            <div className="card kpi"><small>تعداد سفارش</small><div className="v num">{toFa(m.summary.orders)}</div><div className="d muted">{toFa(m.summary.guests)} مهمان</div></div>
            <div className="card kpi"><small>میانگین هر سفارش</small><div className="v num">{num(m.summary.avgTicket)}<small>تومان</small></div></div>
            <div className="card kpi"><small>تخفیف‌ها</small><div className="v num">{num(m.summary.discount)}<small>تومان</small></div>
              <div className="d muted">{m.summary.subtotal ? faPercent((100 * m.summary.discount) / m.summary.subtotal) : '۰٪'} از فروش ناخالص · {toFa(m.voids.total)} لغو</div></div>
          </div>
          <div className="cols">
            <section className="card panel">
              <h2>فروش ساعت به ساعت</h2>
              <div className="bars" role="img" aria-label="نمودار فروش ساعتی">
                {hours.map((h) => {
                  const row = m.hourly.find((x) => x.hour === h);
                  return <div key={h} className={`b ${peak?.hour === h ? 'peak' : ''}`} title={row ? `${toman(row.sales)} · ${toFa(row.orders)} سفارش` : ''}><i style={{ height: `${row ? (row.sales / maxSales) * 100 : 0}%` }} /><span>{toFa(h)}</span></div>;
                })}
              </div>
              {peak && peak.hour >= 0 && <p className="muted" style={{ marginTop: 8, fontSize: 13 }}>اوج فروش: ساعت {toFa(peak.hour)} تا {toFa(peak.hour + 1)} ({toman(peak.sales)})</p>}
            </section>
            <section className="card panel">
              <h2>پرفروش‌ها</h2>
              <div className="rank">
                {m.topItems.map((t) => (
                  <div className="r" key={t.name}>
                    <div className="row between"><span style={{ fontWeight: 600 }}>{t.name}</span><span className="num muted">{toFa(t.qty)} عدد</span></div>
                    <div className="bar"><i style={{ width: `${(t.qty / maxQty) * 100}%` }} /></div>
                  </div>
                ))}
              </div>
            </section>
          </div>
          <div className="cols" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <section className="card panel">
              <h2>روش‌های پرداخت</h2>
              <div className="mix">{m.paymentMix.map((p) => <i key={p.method} style={{ flex: p.amount / mixTotal, background: MIX_COLOR[p.method] }} />)}</div>
              {m.paymentMix.map((p) => <div key={p.method} className="row between" style={{ padding: '4px 0' }}><span className="row"><i style={{ width: 10, height: 10, borderRadius: 3, background: MIX_COLOR[p.method], display: 'inline-block' }} />{METHOD_FA[p.method]}</span><span className="num">{toman(p.amount)} · {faPercent((100 * p.amount) / mixTotal)}</span></div>)}
            </section>
            <section className="card panel">
              <h2>زمان آماده‌سازی</h2>
              {m.kitchen.map((k) => <div key={k.station} className="row between" style={{ padding: '4px 0' }}><span>{k.station === 'bar' ? 'بار' : 'آشپزخانه'}</span><span className="num">میانگین {toFa(k.avgMinutes)} دقیقه · ۹۰٪ زیر {toFa(k.p90Minutes)} دقیقه</span></div>)}
              {m.discounts.length > 0 && <><h2 style={{ marginTop: 18 }}>تخفیف‌ها به تفکیک ثبت‌کننده</h2>
                {m.discounts.map((d) => <div key={d.by} className="row between" style={{ padding: '4px 0' }}><span>{d.by}</span><span className="num">{toFa(d.orders)} سفارش · {toman(d.amount)}</span></div>)}</>}
            </section>
          </div>
        </>)}
    </div>
  );
}
