// All amounts are integer toman. Docs: /docs/features/billing.md

export interface DiscountInput {
  kind: 'percent' | 'amount' | null;
  value: number;
}

export interface Totals {
  subtotal: number;
  discount: number;
  service: number;
  vat: number;
  total: number;
}

export function computeTotals(
  subtotal: number,
  discount: DiscountInput,
  servicePct: number,
  vatPct: number,
): Totals {
  let d = 0;
  if (discount.kind === 'percent') d = Math.floor((subtotal * discount.value) / 100);
  else if (discount.kind === 'amount') d = discount.value;
  d = Math.max(0, Math.min(d, subtotal));
  const taxable = subtotal - d;
  const service = Math.round((taxable * servicePct) / 100);
  const vat = Math.round(((taxable + service) * vatPct) / 100);
  return { subtotal, discount: d, service, vat, total: taxable + service + vat };
}
