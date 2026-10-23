/**
 * Docs:
 * - Feature: /docs/features/day-report-ai-brief.md
 */
import type { Tx } from '../db/pool.js';
import { fmtNum, fmtToman, toFa } from '../lib/fa.js';

export interface DayMetrics {
  date: string;
  branchId: string;
  summary: { orders: number; sales: number; subtotal: number; discount: number; guests: number; avgTicket: number };
  hourly: { hour: number; sales: number; orders: number }[];
  topItems: { name: string; qty: number; revenue: number }[];
  paymentMix: { method: string; amount: number }[];
  discounts: { by: string; orders: number; amount: number; maxPct: number }[];
  voids: { total: number; afterCooking: number; value: number; byWho: { by: string; count: number; value: number }[] };
  kitchen: { station: string; avgMinutes: number; p90Minutes: number; items: number }[];
  baseline: { weekdayAvgSales: number | null; samples: number };
  soldOutBestSellers: string[];
}

export interface Anomaly {
  code: string;
  severity: 'info' | 'warn' | 'high';
  text: string;
}

const WIN = `($2::date + time '04:00') AT TIME ZONE 'Asia/Tehran'`;

/** Business day = 04:00 to 04:00 Tehran time, so a 1 a.m. dinner still belongs to the night before. */
export async function dayMetrics(tx: Tx, branchId: string, date: string): Promise<DayMetrics> {
  const w = (shiftDays = 0) => ({
    from: `(${WIN} + interval '${shiftDays} days')`,
    to: `(${WIN} + interval '${shiftDays + 1} days')`,
  });
  const cur = w(0);
  const q = (sql: string, params: unknown[] = [branchId, date]) => tx.query(sql, params).then((r) => r.rows);

  const [s] = await q(
    `SELECT count(*) AS orders, coalesce(sum(paid_total),0) AS sales, coalesce(sum(paid_subtotal),0) AS subtotal,
            coalesce(sum(paid_discount),0) AS discount, coalesce(sum(guests),0) AS guests
       FROM orders WHERE branch_id = $1 AND status = 'paid' AND closed_at >= ${cur.from} AND closed_at < ${cur.to}`,
  );
  const hourly = await q(
    `SELECT extract(hour FROM closed_at AT TIME ZONE 'Asia/Tehran')::int AS hour, sum(paid_total) AS sales, count(*) AS orders
       FROM orders WHERE branch_id = $1 AND status = 'paid' AND closed_at >= ${cur.from} AND closed_at < ${cur.to}
      GROUP BY 1 ORDER BY 1`,
  );
  const top = await q(
    `SELECT i.name, sum(i.qty) AS qty, sum(i.qty * i.unit_price) AS revenue
       FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE o.branch_id = $1 AND o.status = 'paid' AND o.closed_at >= ${cur.from} AND o.closed_at < ${cur.to} AND i.status <> 'void'
      GROUP BY i.name ORDER BY qty DESC, revenue DESC LIMIT 6`,
  );
  const mix = await q(
    `SELECT p.method, sum(p.amount) AS amount FROM payments p JOIN orders o ON o.id = p.order_id
      WHERE o.branch_id = $1 AND o.status = 'paid' AND o.closed_at >= ${cur.from} AND o.closed_at < ${cur.to}
      GROUP BY p.method ORDER BY amount DESC`,
  );
  const disc = await q(
    `SELECT u.display_name AS by, count(*) AS orders, sum(o.paid_discount) AS amount,
            max(CASE WHEN o.paid_subtotal > 0 THEN round(100.0 * o.paid_discount / o.paid_subtotal) ELSE 0 END) AS max_pct
       FROM orders o JOIN users u ON u.id = o.discount_by
      WHERE o.branch_id = $1 AND o.status = 'paid' AND o.paid_discount > 0 AND o.closed_at >= ${cur.from} AND o.closed_at < ${cur.to}
      GROUP BY u.display_name ORDER BY amount DESC`,
  );
  const voids = await q(
    `SELECT u.display_name AS by, count(*) AS count, sum(i.qty * i.unit_price) AS value,
            count(*) FILTER (WHERE i.void_stage IN ('preparing','ready','served')) AS after_cooking
       FROM order_items i JOIN orders o ON o.id = i.order_id LEFT JOIN users u ON u.id = i.voided_by
      WHERE o.branch_id = $1 AND i.status = 'void' AND i.status_at >= ${cur.from} AND i.status_at < ${cur.to} AND o.status <> 'void'
      GROUP BY u.display_name ORDER BY value DESC`,
  );
  const kitchen = await q(
    `SELECT i.station, avg(extract(epoch FROM i.ready_at - i.created_at) / 60) AS avg_min,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM i.ready_at - i.created_at) / 60) AS p90_min, count(*) AS items
       FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE o.branch_id = $1 AND i.ready_at IS NOT NULL AND i.created_at >= ${cur.from} AND i.created_at < ${cur.to}
      GROUP BY i.station`,
  );
  const base = await q(
    `SELECT count(*) AS samples, avg(day_sales) AS avg_sales FROM (
       SELECT k, (SELECT coalesce(sum(paid_total),0) FROM orders WHERE branch_id = $1 AND status = 'paid'
                   AND closed_at >= ($2::date + time '04:00' - (k * 7 || ' days')::interval) AT TIME ZONE 'Asia/Tehran'
                   AND closed_at <  ($2::date + time '04:00' - (k * 7 || ' days')::interval + interval '1 day') AT TIME ZONE 'Asia/Tehran') AS day_sales
         FROM generate_series(1, 4) k) d WHERE day_sales > 0`,
  );
  const soldOut = await q(
    `SELECT DISTINCT m.name FROM menu_items m WHERE NOT m.available AND m.name = ANY($1::text[])`,
    [top.slice(0, 5).map((t) => t.name)],
  );

  const orders = s.orders;
  return {
    date,
    branchId,
    summary: { orders, sales: s.sales, subtotal: s.subtotal, discount: s.discount, guests: s.guests, avgTicket: orders ? Math.round(s.sales / orders) : 0 },
    hourly: hourly.map((h) => ({ hour: h.hour, sales: h.sales, orders: h.orders })),
    topItems: top.map((t) => ({ name: t.name, qty: t.qty, revenue: t.revenue })),
    paymentMix: mix.map((m) => ({ method: m.method, amount: m.amount })),
    discounts: disc.map((d) => ({ by: d.by, orders: d.orders, amount: d.amount, maxPct: Number(d.max_pct) })),
    voids: {
      total: voids.reduce((a, v) => a + v.count, 0),
      afterCooking: voids.reduce((a, v) => a + v.after_cooking, 0),
      value: voids.reduce((a, v) => a + (v.value ?? 0), 0),
      byWho: voids.map((v) => ({ by: v.by ?? 'نامشخص', count: v.count, value: v.value ?? 0 })),
    },
    kitchen: kitchen.map((k) => ({ station: k.station, avgMinutes: Math.round(k.avg_min), p90Minutes: Math.round(k.p90_min), items: k.items })),
    baseline: { weekdayAvgSales: base[0].samples ? Math.round(base[0].avg_sales) : null, samples: base[0].samples },
    soldOutBestSellers: soldOut.map((r) => r.name),
  };
}

const METHOD_FA: Record<string, string> = { cash: 'نقد', card: 'کارتخوان', transfer: 'کارت‌به‌کارت' };
export const methodFa = (m: string) => METHOD_FA[m] ?? m;
const STATION_FA: Record<string, string> = { kitchen: 'آشپزخانه', bar: 'بار' };

/** Deterministic rules. These, not the model, decide what is unusual. */
export function detectAnomalies(m: DayMetrics): Anomaly[] {
  const out: Anomaly[] = [];
  const { summary: s } = m;
  if (s.subtotal > 0) {
    const pct = (100 * s.discount) / s.subtotal;
    if (pct >= 6) out.push({ code: 'discount_rate', severity: pct >= 10 ? 'high' : 'warn', text: `تخفیف‌ها ${toFa(pct.toFixed(1))}٪ فروش ناخالص بوده (${fmtToman(s.discount)}).` });
  }
  for (const d of m.discounts) {
    if (d.orders >= 4 && s.orders && d.orders / s.orders >= 0.2) {
      out.push({ code: 'discount_user', severity: 'warn', text: `${d.by} روی ${toFa(d.orders)} سفارش تخفیف داده (جمعاً ${fmtToman(d.amount)}، بیشترین ${toFa(d.maxPct)}٪).` });
    }
  }
  if (m.voids.afterCooking >= 2) {
    out.push({ code: 'void_after_cooking', severity: 'high', text: `${toFa(m.voids.afterCooking)} آیتم بعد از شروع تهیه لغو شده؛ ارزش کل لغوها ${fmtToman(m.voids.value)}.` });
  } else if (m.voids.total >= 5) {
    out.push({ code: 'void_many', severity: 'warn', text: `${toFa(m.voids.total)} آیتم لغو شده (${fmtToman(m.voids.value)}).` });
  }
  for (const k of m.kitchen) {
    if (k.items >= 15 && k.p90Minutes >= 32) {
      out.push({ code: 'slow_kitchen', severity: 'warn', text: `${STATION_FA[k.station] ?? k.station}: ۹۰٪ آیتم‌ها ظرف ${toFa(k.p90Minutes)} دقیقه آماده شده، میانگین ${toFa(k.avgMinutes)} دقیقه.` });
    }
  }
  if (m.baseline.weekdayAvgSales && s.sales > 0) {
    const ratio = s.sales / m.baseline.weekdayAvgSales;
    if (ratio <= 0.75) out.push({ code: 'sales_down', severity: 'warn', text: `فروش ${toFa(Math.round((1 - ratio) * 100))}٪ کمتر از میانگین همین روز هفته در چهار هفته قبل است.` });
    if (ratio >= 1.3) out.push({ code: 'sales_up', severity: 'info', text: `فروش ${toFa(Math.round((ratio - 1) * 100))}٪ بیشتر از میانگین همین روز هفته در چهار هفته قبل است.` });
  }
  for (const n of m.soldOutBestSellers) out.push({ code: 'soldout_bestseller', severity: 'info', text: `«${n}» جزو پرفروش‌هاست و الان «تمام شده» علامت خورده.` });
  return out;
}

/** Plain, always-available version of the brief. Used when the AI provider is down or its output fails validation. */
export function templateBrief(m: DayMetrics, anomalies: Anomaly[], withFlags = true): string {
  const s = m.summary;
  if (!s.orders) return 'برای این روز سفارش پرداخت‌شده‌ای ثبت نشده است.';
  const parts: string[] = [];
  parts.push(`در این روز ${toFa(s.orders)} سفارش تسویه شد و فروش ${fmtToman(s.sales)} بود؛ میانگین هر سفارش ${fmtToman(s.avgTicket)}.`);
  const peak = [...m.hourly].sort((a, b) => b.sales - a.sales)[0];
  if (peak) parts.push(`شلوغ‌ترین ساعت ${toFa(peak.hour)} تا ${toFa(peak.hour + 1)} بود.`);
  if (m.topItems.length) parts.push(`پرفروش‌ترین‌ها: ${m.topItems.slice(0, 3).map((t) => `${t.name} (${toFa(t.qty)} عدد)`).join('، ')}.`);
  if (m.paymentMix.length) parts.push(`سهم روش‌های پرداخت: ${m.paymentMix.map((p) => `${methodFa(p.method)} ${fmtNum((100 * p.amount) / s.sales)}٪`).join('، ')}.`);
  if (!anomalies.length) parts.push('مورد غیرعادی‌ای پیدا نشد.');
  else if (withFlags) parts.push('نکات قابل بررسی:\n' + anomalies.map((a) => `• ${a.text}`).join('\n'));
  else parts.push(`${toFa(anomalies.length)} مورد برای بررسی پیدا شد (پایین‌تر آمده است).`);
  return parts.join('\n');
}
