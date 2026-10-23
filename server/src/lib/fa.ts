const faDigits = '۰۱۲۳۴۵۶۷۸۹';
export const toFa = (v: string | number) => String(v).replace(/\d/g, (d) => faDigits[Number(d)]);
export const fmtNum = (n: number) => toFa(Math.round(n).toLocaleString('en-US').replace(/,/g, '٬'));
export const fmtToman = (n: number) => `${fmtNum(n)} تومان`;
/** Strip anything that is not plain text before it goes near a prompt: names are data, never instructions. */
export const sanitizeForPrompt = (s: string, max = 40) =>
  s.replace(/[\u0000-\u001f\u007f<>{}`"\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
