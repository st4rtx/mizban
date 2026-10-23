# Feature: Demo Data

## Purpose

An empty app is a failed demo. The seed builds two restaurants that behave like real ones.

## Contents

- **کافه‌رستوران نارنج**: 2 branches (Saadat Abad 20 tables incl. 2 private rooms, Vanak 16), 7 staff, 8 menu categories / 51 items in toman, 30 days of paid history (Thursday/Friday peaks, split payments, discounts, voids, prep times), a live evening in progress (tables in every state, a bill request, a takeaway ticket).
- **چای‌خانه سنتی باغ**: second tenant, 1 branch, 13 items, 14 days of history. Exists to prove isolation.
- Planted for the AI brief on the previous business day (Saadat Abad): one cashier discounting heavily, three items voided after cooking began, a slow dinner kitchen, a best seller marked sold out.

## Mechanics

Deterministic PRNG. `npm run seed` is idempotent; `--reset` rebuilds. With `DEMO_MODE=true` the server re-seeds by itself when the newest order is older than 6 hours, so timers and history stay current. This truncates all tables, so it must never be enabled for a real restaurant.

## Credentials

All accounts use `demo1234`. Listed on the login page only while `DEMO_MODE=true`: sara (manager), ali / maryam (floor, Saadat Abad), reza (kitchen), kaveh / sahar (floor, Vanak), nima (kitchen, Vanak), bagh / golnar / davood (second restaurant).

## Change History

- 2026-10-23: Initial version.
