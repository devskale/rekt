# AGENTS.md

Notes for AI coding agents working in this repo. Read this before editing.
There are hard-won conventions below — violating them breaks things subtly.

## TL;DR for agents

- **Read-only data project. No trading, no wallet, no on-chain.**
- **NEVER commit `creds/`, `.env`, or `data/`.** They're gitignored — keep them
  that way. If a secret value is referenced anywhere, reference it by ENV VAR
  NAME only, never paste the value.
- **Reuse first.** Before writing a fetcher/parser/trader, check
  `src/market-data/`, `src/engine/`, `src/logger.ts` — it probably exists.
- **Verify before reporting done.** Run `pnpm build` (tsc) and the relevant
  script; inspect actual output, don't trust assumptions.

## Language & conventions

- **ESM TypeScript**, strict. `tsconfig.json` has `rootDir: src`.
- **Imports use `.js` extensions** (e.g. `from "../logger.js"`), even for `.ts`
  files. This is the project-wide convention — match it. NodeNext-style.
- **Zod for ALL external API parsing.** Never `JSON.parse` a Polymarket response
  into an `any`. See `src/market-data/types.ts` for the pattern (note the
  `.transform()` that decodes their JSON-encoded string fields like
  `outcomePrices`).
- **No `any`** if reasonably avoidable. Prefer `unknown` + narrow.
- **Env-driven config** with sensible defaults: `process.env.X ?? default`.
  See `src/index.ts` and `src/receiver/config.ts`.
- **`logger.info/warn/error(module, msg, err?)`** from `src/logger.ts`. Always
  pass the `module` string (e.g. `"receiver:odds"`). Don't `console.log` raw.

## What to reuse (do not reinvent)

| Need | Use |
|---|---|
| Fetch live BTC 5-min markets | `fetchBtc5minMarkets()` — already computes prev/curr/next window timestamps from slug `btc-updown-5m-{unix}` |
| Parse a Gamma market | `GammaMarketSchema` + `toMarket()` (Zod + clean `Market` type) |
| Simulate a trade | `PaperTrader` — `openPosition`, `resolveMarket`, `getBalance` |
| Fee math | `calcFee()` in `src/engine/paper-trader.ts` — **do not** reinvent; it's `qty × rate × price × (1 − price)` |
| Strategy decision | Implement the `Strategy` interface (`decide(ctx): Decision \| null`); register via `registry.ts` |
| Fetch CLOB depth | `fetchDepth(tokenId)` in `src/receiver/depth.ts` returns the compressed summary |
| Config | the env-reading pattern in `src/receiver/config.ts` |

## Hard-won rules (each cost a debug cycle)

### 1. `active && !closed` is NOT "tradeable"
Polymarket keeps a market `active: true` through settlement. The post-close
order book fills with stale 1¢ junk (saw `ask_depth_95 = 778,743` on a resolved
market). **The real cutoff is `now < window_end`.** When capturing or deciding,
compute `secondsToClose = windowEnd - nowSec` and **skip when `<= 0`**.

### 2. Capture depth for BOTH tokens
A 5-min market has an Up token and a Down token (`clobTokenIds[0]` and `[1]`).
The scalp buys the *favourite*, which flips ~half the time. Up-only depth blinds
you to half the setups. Always store `up_*` and `down_*`.

### 3. Cadence: turbo only near close
Poll at `POLL_MS` (5s) normally, `TURBO_MS` (2s) when the *live* market is within
`TURBO_LAST_SECONDS` (90s) of close. Compute `minSecondsToClose` from **live**
markets only (rule #1) — a leaked expired market with negative stc otherwise
forces turbo forever.

### 4. Depth compression, not full ladder
Store depth at meaningful prices only: `ask_depth_95`/`99` (scalp zone),
`bid_depth_01`/`05` (settlement-snipe zone) + top-of-book. Six numbers per token
instead of 40. The full L2 is 3.5 KB/snapshot and unnecessary for tuning.

### 5. `recentPrices` is the momentum signal
`MarketContext.recentPrices` is currently `[]` (a known TODO in `runner.ts`).
The 4-minute momentum edge is a rule on this series. Anything that populates it
from stored data unlocks the momentum strategy.

## Don't touch

- `src/engine/paper-trader.ts` fee math — it's correct and load-bearing.
- `creds/`, `.env`, `data/` — read only by the app, never committed.
- The `.gitignore` exclusions (`creds/`, `data/`, `tempis/`, `*.key`, `*.pem`,
  the 3 symlinks `agentictrading*.md` + `transcripts` which point outside the repo).

## Commands

```bash
pnpm install
pnpm build         # tsc --noEmit — MUST pass before reporting done
pnpm test          # vitest
pnpm receiver      # rektDBfiller: capture to ./data/
pnpm dev           # paper-trading backend on :3000
```

## When capturing data to validate a change

Clear `data/{odds,spot}` first, run the receiver ~15–20s, then inspect the JSONL
with a python one-liner. Check: no negative `seconds_to_close`, depth in the
hundreds-to-thousands (NOT 100k+), cadence gaps ~5s base, both `up_*`/`down_*`
populated. See README "got right (and wrong)" section for the regression suite.

## Scope guardrails

- **Backtesting / strategy tuning = in scope.**
- **Live execution (placing orders, wallet, builder code, the CLOB creds in
  `creds/`) = out of scope** for now. That's a separate future module.
- If asked to "go live", stop and confirm — it changes the risk profile entirely.
