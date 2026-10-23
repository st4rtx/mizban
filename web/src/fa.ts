const D = '۰۱۲۳۴۵۶۷۸۹';
export const toFa = (v: string | number) => String(v).replace(/\d/g, (d) => D[Number(d)]);
export const num = (n: number) => toFa(Math.round(n).toLocaleString('en-US').replace(/,/g, '٬'));
export const toman = (n: number) => `${num(n)} تومان`;
export const faPercent = (n: number) => `${toFa(Math.round(n))}٪`;

const dateFmt = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Tehran' });
export const jalaliLong = (d: Date | string) => dateFmt.format(typeof d === 'string' ? new Date(d) : d);
const timeFmt = new Intl.DateTimeFormat('fa-IR', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tehran', hour12: false });
export const clock = (d: Date | string) => timeFmt.format(typeof d === 'string' ? new Date(d) : d);

/** Business day (04:00 to 04:00 Tehran) as YYYY-MM-DD. */
export function businessDay(offsetDays = 0, now = Date.now()): string {
  const t = new Date(now + 3.5 * 3600_000 - 4 * 3600_000 + offsetDays * 86400_000);
  return t.toISOString().slice(0, 10);
}
export const dayToDate = (day: string) => new Date(`${day}T12:00:00+03:30`);

export function minutesSince(iso: string, now: number): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000));
}
export const dur = (min: number) => (min < 60 ? `${toFa(min)} دقیقه` : `${toFa(Math.floor(min / 60))}:${toFa(String(min % 60).padStart(2, '0'))} ساعت`);

export const ROLE_FA = { manager: 'مدیر', floor: 'سالن', kitchen: 'آشپزخانه' } as const;
export const STATUS_FA = { new: 'جدید', preparing: 'در حال تهیه', ready: 'آماده', served: 'سرو شد', void: 'لغو شد' } as const;
export const METHOD_FA = { cash: 'نقد', card: 'کارتخوان', transfer: 'کارت‌به‌کارت' } as const;
