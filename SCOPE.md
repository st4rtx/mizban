# SCOPE: Mizban (میزبان), service-floor platform for Iranian cafés and restaurants

Status: agreed before build. Audience: the owner of the first restaurant (our first customer) and whoever signs off v1.

## 1. The problem, as I understand it

A café or restaurant in Iran runs a service on five disconnected tools: a printed menu, a basic POS, paper chits that walk to the kitchen, a messaging group for "table 7 wants the bill", and a calculator or the card terminal at the till. Reporting happens by hand at month end.

Most of the damage is not in any single tool. It happens **between** them, during a rush:

- A chit is lost or misread, so a dish is cooked twice or never.
- The cashier quotes a total, a waiter adds a drink, and nobody notices the bill changed.
- A discount or a cancelled dish leaves no trace, so the owner cannot tell a generous cashier from a leaking till.
- The owner is not in the room, so they only learn how the day went from a shouted summary.

## 2. What I looked at before choosing

Candidate workflows, judged by "what hurts most during a live service and cannot be fixed with a spreadsheet":

| Candidate | Verdict |
|---|---|
| Digital menu / QR menu | Easy, visible, and almost no value alone. Every competitor has one. Not v1. |
| Menu management | Needed, but only as a support function for ordering. Minimal version only (price, availability). |
| Kitchen display only | Useless without orders flowing into it. |
| **Table → kitchen → bill loop (chosen)** | This is where concurrent people touch the same thing. It is where money is lost and where trust is built or broken. |
| Inventory / cost of goods | High value, but needs weeks of recipe data entry before it pays back. Later. |
| Reporting | Cheap once orders exist. Included as a thin layer, with the one AI capability attached. |

**Chosen workflow: the service loop.** Open a table, take the order, send it to kitchen/bar, mark dishes through preparing → ready → served, take the bill (split, discounted, paid in cash/card/transfer), and close the table. All with several people on the same order at once.

## 3. Iran-specific findings that shape the product

These are assumptions from research and domain knowledge. Items marked **(confirm)** need the customer to verify.

1. **Right-to-left, Persian digits, Jalali calendar.** Not a translation layer; the whole UI is RTL, numbers render in Persian digits, dates are Jalali, and the week starts Saturday. Thursday night and Friday are the busiest, not Saturday.
2. **Currency is toman in speech and on menus; the legal currency is rial.** Menus and the UI use toman. Storage is integer toman. A rial display toggle is out of scope. **(confirm)** with the accountant.
3. **Payment is mostly outside the software.** Customers pay with a standalone card terminal (کارتخوان), cash, or card-to-card transfer. There is no Stripe-style gateway and a PSP integration needs a contract and a terminal vendor. So v1 **records** payments (method + amount) and does not **process** them. The cashier still taps the card terminal.
4. **Bills are split often** ("دنگی"). Splitting a bill across people and across payment methods is a daily event, not an edge case.
5. **VAT and service charge appear as lines on the bill.** v1 supports a configurable service percentage and VAT percentage per restaurant. **(confirm)** the rates and rounding with the accountant.
6. **Tax authority e-invoicing (سامانه مودیان)** exists and applies to many businesses. Integrating is out of scope for v1, but the data model keeps immutable line snapshots (name, unit price at order time) so an invoice can be produced later. **(confirm)** whether this restaurant is required to issue it.
7. **Takeaway (بیرون‌بر) and third-party delivery apps** are a large share of orders. v1 supports walk-in takeaway tickets (no table). Delivery-app integration is out of scope.
8. **Connectivity is fragile and internationally restricted.** Hosting is inside Iran, with no dependency on foreign CDNs, fonts, analytics or map tiles. The app tolerates a flaky Wi-Fi in the kitchen: live updates reconnect on their own, and a missed event is repaired by re-fetching.
9. **Staff turnover is high and devices are cheap.** The UI has to work on a mid-range Android phone and a wall-mounted tablet with no training. Three roles only. Large touch targets.
10. **A foreign AI API may be blocked from Iran.** The AI feature goes through an Iranian-accessible provider and must degrade to a non-AI result when it fails.

## 4. In scope for v1

**For the waiter / cashier (نقش «سالن»)**
- See the floor: every table, whether it is free, occupied, waiting on the kitchen, or asking for the bill, and for how long.
- Open a table, or start a takeaway ticket.
- Build an order on a cart, then send it to kitchen/bar in one tap. Add more later, in rounds.
- Mark dishes served, cancel a dish before it is cooked, flag "bill requested".
- Take the bill: discount (up to a limit), split by amount or equally, mixed payment methods, print a receipt.

**For the kitchen and bar (نقش «آشپزخانه»)**
- A live board of what is new, being prepared, and ready, with a timer on each ticket, filtered by station (kitchen / bar).
- One tap to advance a dish.

**For the owner / manager (نقش «مدیر»)**
- Everything above, plus: large discounts, cancelling dishes that are already cooking or served, voiding an order, marking menu items sold out and changing prices.
- A day dashboard per branch: sales, number of orders, average ticket, hours, best sellers, payment mix.
- An **AI-written end-of-day brief** with flagged anomalies (see section 6).
- Multi-branch: one owner, several branches, staff pinned to one branch.

**Platform**
- Many restaurants on one deployment; a restaurant can never read another's data (enforced in the database, not only in code).
- Audit trail for discounts, voids, price changes.
- Realistic demo data for two restaurants, one of them with two branches.

## 5. Explicitly out of scope for v1 (and why)

| Not built | Why |
|---|---|
| Customer-facing QR menu / self-order | Lowest value; needs a second auth model (anonymous guests) and an abuse story. |
| Inventory, recipes, cost of goods | Needs weeks of data entry before it returns value. |
| Card terminal / PSP integration | Needs vendor contracts. We record, we do not charge. |
| Tax-authority (مودیان) submission | Needs legal confirmation and certificates. Data model is ready for it. |
| Delivery-app integration, courier management | Separate product. |
| Online reservations | Separate product. |
| Staff management UI, shifts, payroll | v1 users are created by seed/admin script. |
| Printer-driver / kitchen-printer integration | Browser print for receipts only. KDS replaces kitchen paper. |
| Offline mode with local sync | The right answer for 1,000 restaurants; not for the first one. Risk is documented. |
| Moving/merging tables, item-level bill splitting | Frequent, but each is a separate design problem. Next up. |
| Loyalty, customer database, SMS | Needs consent and privacy design. |

## 6. The AI capability and why it is the only one

**What:** after a day (or a shift), the manager gets a short Persian brief: what happened, what stands out, what to look at. The numbers are computed in SQL. The model only **writes the sentences** and may only use the numbers it is given. Anomalies (heavy discounts by one person, cancellations after cooking, unusually long kitchen times, a best seller sold out) are detected by **plain rules**, then handed to the model to explain.

**Why this, and why nothing bigger:** the problem I picked is a real-time coordination problem. AI adds little there; a model deciding what the kitchen cooks next would be worse than a timer. The place where a non-technical owner is genuinely blind is *after* the shift: they do not read dashboards. A written brief they can read on their phone fits their habit. A bigger AI feature (demand forecasting, auto-menus from photos) was rejected because the demo data is too thin to defend it with real accuracy, and a wrong forecast is worse than none.

**Guard rails:** the model input is only structured aggregates produced by us, never free text typed by staff (blocks prompt injection from void reasons or notes); there is a hard timeout; a deterministic template report is shown if the provider fails; results are cached per branch/day/data-hash so cost is bounded.

## 7. What "done" looks like (acceptance for v1)

A shift of Friday 9 pm, with six devices:
1. Two waiters add items to the same table at the same moment; both rounds appear, nothing is lost.
2. The kitchen starts a dish while a waiter cancels it; one wins, the other sees a clear message, no corruption.
3. The cashier is looking at a total when a waiter adds a pizza; payment is **refused** with a "bill changed" message rather than closing the table short.
4. Paying a split bill with cash and card ends with exactly the bill total recorded, once, even if the Wi-Fi retries the request.
5. A restaurant-B login cannot fetch a restaurant-A order by guessing its id.
6. At the end of the day the manager reads the brief and can find the discount that was out of the ordinary.

## 8. Assumptions and questions for the customer

- How many branches, tables and devices on a busy night? (v1 sized for ~40 tables per branch, ~15 devices.)
- Do you charge service? What rate? Does the price on the menu include VAT?
- Do cashiers need to discount? Up to what percentage without you? (Demo uses 10%.)
- Who is allowed to cancel a dish once the kitchen has started it? (Demo: only the manager.)
- Is there a stable local network in the kitchen? Which devices exist today?
- Do you need the tax-authority integration from day one?

## 9. Plan and time box

Time box: 6 hours of work, 4 calendar days. Order of work: this document → schema with tenant isolation → ordering/kitchen/checkout APIs with concurrency control → UI → demo data → tests → deploy → written deliverables. If time runs out, the order of cuts is: the AI brief polish, then menu editing, then the rial/toman detail. The concurrency and isolation work is not cut.

## 10. Risks I am accepting up front

- Single server, single process for live updates. Fine for tens of restaurants; see HANDOVER for where it breaks.
- Payments are recorded by hand. A cashier can lie about the method. The audit trail makes it visible, not impossible.
- Without offline mode, a dead Wi-Fi stops the service. The mitigation is a paper fallback procedure written in the handover.
