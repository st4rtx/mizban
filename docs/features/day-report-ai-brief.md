# Feature: Day Report and AI Brief

## Purpose

Give a manager who is not in the room a numeric summary of the business day and a short written brief with the things worth checking.

## Scope

`GET /api/reports/day` (metrics + rule-based flags), `POST /api/reports/day/brief` (AI or template text), cached in `day_briefs`.

## Out of Scope

Forecasting, per-item profitability, export, scheduled delivery (SMS/Telegram).

## Related Files

server/src/services/reports.ts, ai.ts, routes/reports.ts, web/src/pages/Report.tsx

## Business Rules

- Business day is 04:00 to 04:00 Asia/Tehran.
- Flags are plain rules: discount rate ≥ 6%, a user discounting ≥ 20% of orders (min 4), ≥ 2 voids after cooking began, p90 prep ≥ 32 min, sales ±25/30% vs same weekday average of the last 4 weeks, a best seller marked sold out.
- The model only writes sentences from a closed JSON of aggregates. It is told the data block is data, not instructions.
- Output is rejected (template shown instead) if: length out of range, contains a link, or contains a number of 4+ digits that is not in the input.
- Cost bound: one call per distinct data hash per branch/day; manager endpoint rate-limited to 10/min; 15 s timeout; `max_tokens` 600.

## Edge Cases

No orders → fixed text, no AI call. Provider error/timeout → template, cached for 2 minutes to avoid hammering. Names/notes typed by staff are never sent to the provider.

## Known gap

The number guard ignores numbers under 4 digits, so a wrong order count or percentage could pass. Accepted for v1.

## Change History

- 2026-10-23: Initial version.
