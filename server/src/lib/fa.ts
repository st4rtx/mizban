const faDigits = '۰۱۲۳۴۵۶۷۸۹';
export const toFa = (v: string | number) => String(v).replace(/\d/g, (d) => faDigits[Number(d)]);
export const fmtNum = (n: number) => toFa(Math.round(n).toLocaleString('en-US').replace(/,/g, '٬'));
const jalaliFmt = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Tehran' });
/**
 * Business day (YYYY-MM-DD) as a Jalali long date: «پنجشنبه ۳۰ مهر ۱۴۰۵». Computed here so the model never converts dates.
 * Built from parts because the order and separators Intl produces differ between ICU builds.
 */
export const jalaliLong = (day: string) => {
  const parts = Object.fromEntries(jalaliFmt.formatToParts(new Date(`${day}T12:00:00+03:30`)).map((p) => [p.type, p.value]));
  return `${parts.weekday} ${parts.day} ${parts.month} ${parts.year}`;
};
export const fmtToman = (n: number) => `${fmtNum(n)} تومان`;
/** Strip anything that is not plain text before it goes near a prompt: names are data, never instructions. */
export const sanitizeForPrompt = (s: string, max = 40) =>
  s.replace(/[\u0000-\u001f\u007f<>{}`"\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
