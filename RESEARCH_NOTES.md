# Agentic Trading — GitHub Research Notes

> Researched 2026-06-13. Cloned to `./tempis/`. Read alongside `agentictrading.md`.

---

## What I Cloned

| Repo | Stack | What it is |
|------|-------|-----------|
| **Polymarket/agents** | Python | Official framework. LLM-based trader. |
| **ent0n29/polybot** | Java/Spring | Pro-grade HFT infra. **The goldmine.** Reverse-engineers "Gabagool" strategy. |
| **aarora4/Awesome-Prediction-Market-Tools** | list | 200+ tools, bots, dashboards in the ecosystem. |

---

## The Big Picture — Two Completely Different Approaches

### Approach A: LLM Prediction (what most "AI trading" videos show)
- Feed market question + news/sentiment to an LLM
- LLM says "I think 70% likely YES"
- If market price < 70%, buy
- **Used for:** Politics, sports, events (slow markets, hours/days)
- **Example:** Polymarket/agents official repo

### Approach B: Market Making / Microstructure (what actually makes money)
- Don't predict direction at all
- Place orders on BOTH sides, capture the spread
- Hedge immediately when one side fills
- **Used for:** BTC 5-min up/down (fast markets, seconds)
- **Example:** ent0n29/polybot (Gabagool strategy)

**The money is in Approach B.** The $80K/mo bots don't predict — they make markets.

---

## Deep Dive: The Gabagool Strategy (polybot)

This is the sophisticated one. Let me break down each piece.

### 1. WebSocket, Not REST (Speed)

```
Our bot:     REST poll every 10 seconds → "what's the price now?"
Pro bot:     WebSocket subscription → price pushed to us instantly
```

polybot connects to Polymarket's CLOB (order book) WebSocket and gets **top-of-book updates pushed in real-time**. It refreshes its strategy every **250ms** — 40x faster than us.

**Why this matters:** In a 5-minute market, the last 60 seconds are where odds move. If you're polling every 10s, you see 6 snapshots. The pro bot sees 240. You're blind by comparison.

### 2. Both-Sides Quoting (The Core Edge)

A BTC Up/Down market has TWO tokens:
- **UP token** — pays $1 if BTC goes up
- **DOWN token** — pays $1 if BTC goes down

Our bot: Buy UP, hope BTC goes up, collect $1 or lose everything.

Pro bot: Place **limit buy orders on BOTH**:
- Bid for UP at $0.48
- Bid for DOWN at $0.48
- Total cost if both fill: $0.96
- Guaranteed payout: $1.00 (one of them always wins)
- **Profit: $0.04 per pair, risk-free**

This is called **complete-set arbitrage**. If `upPrice + downPrice < $1.00`, you buy both and lock in the difference. It's literally free money when it exists.

### 3. Inventory Skew (Risk Management)

If you've bought 100 UP tokens but only 20 DOWN, you're **long UP** — exposed to direction. Bad for a market maker.

polybot fixes this by **skewing quotes**:
- If long UP → lower your UP bid (don't buy more), raise your DOWN bid (buy more DOWN to balance)
- Configurable: `maxSkewTicks`, `imbalanceSharesForMaxSkew`

The goal is always to stay **balanced** (delta-neutral), so direction doesn't matter.

### 4. Fast Top-Up (The Clever Part)

When one leg fills (say someone sells you UP at $0.48), you now have **unhedged exposure**. polybot:

1. Detects the fill
2. Within 1-5 seconds, places a taker order on the **other leg** (DOWN)
3. Checks: is `upFillPrice + downAskPrice < $1.00`? If yes → still profitable → execute
4. Now you're balanced again

This is the heartbeat: **fill → hedge → fill → hedge**. Every fill gets immediately neutralized.

### 5. Taker Mode (When to Stop Being Patient)

Normally you're a **maker** (place limit orders, wait). But sometimes the edge is so good you should **take** (market order, pay the spread):

```
IF edge (1 - upAsk - downBid) > threshold
   AND spread is tight
THEN switch to taker mode on the better leg
```

polybot's `shouldTake()` checks if the guaranteed profit exceeds a threshold and the spread is narrow enough that taking is worth it.

### 6. Bankroll Management (Don't Blow Up)

polybot has layers of capital protection:

| Control | What it does |
|---------|-------------|
| `bankrollMinThreshold` | Circuit breaker — stop if bankroll drops too low |
| `maxOrderBankrollFraction` | Never put more than X% of bankroll in one order |
| `maxTotalBankrollFraction` | Never have more than X% of bankroll exposed total |
| `dynamicSizingMultiplier` | Scale positions up/down based on recent performance |
| `maxOrderNotionalUsd` | Hard cap on order size in dollars |

We have **none of this**. Our bot will happily spend all $1000 on coin flips.

### 7. Tick-Size Awareness (Don't Get Rejected)

Polymarket has minimum price increments (tick sizes) that vary by token. If you submit an order at $0.485 but the tick size is $0.01, it gets rejected. polybot caches tick sizes and rounds all prices correctly.

---

## The Architecture (polybot)

```
┌─────────────────────────────────────────────┐
│         GabagoolDirectionalEngine           │  ← Strategy brain
│  (250ms loop: evaluate every market)        │
└──────────────┬──────────────────────────────┘
               │
   ┌───────────┼───────────┬─────────────┐
   ▼           ▼           ▼             ▼
┌──────┐  ┌─────────┐  ┌──────────┐  ┌────────┐
│Market│  │Position │  │  Order   │  │Bankroll│
│  WS  │  │ Tracker │  │ Manager  │  │Service │
└──┬───┘  └─────────┘  └────┬─────┘  └────────┘
   │                        │
   │ real-time book         │ place/cancel orders
   ▼                        ▼
┌──────────────────────────────────────────────┐
│        Polymarket CLOB (order book)          │
│  WebSocket in, REST/SDK out for orders       │
└──────────────────────────────────────────────┘
```

**Microservices:** ingestor (data), strategy (brain), executor (orders), analytics (ClickHouse), monitoring (Grafana/Prometheus). This is institutional-grade.

---

## Official Polymarket/agents — The LLM Approach

For contrast. This is the "AI predicts" school:

```
1. Get market question: "Will Trump win?"
2. RAG search: news, sentiment, Wikipedia
3. LLM "superforecaster" prompt → outputs probability (0.7)
4. If market price (0.55) < LLM probability (0.70) → BUY
5. Size: 10% of funds
```

Key prompts in their `prompts.py`:
- `superforecaster()` — decompose question, base rates, probability estimate
- `one_best_trade()` — given prediction + prices, output `{price, size, side}`
- `filter_markets()` — "which markets will I be best at trading?"

**Verdict:** Interesting for slow event markets. Useless for 5-min BTC. The LLM can't react in 250ms.

---

## The Ecosystem (Awesome List Highlights)

**200+ tools exist.** Most are wrappers/dashboards. The notable patterns:

| Category | Examples | What they do |
|----------|----------|-------------|
| **AI Agents** | PolyOracle, Polyseer, Polybro | Multi-model consensus, research reports |
| **Arbitrage** | ArbBets, Eventarb, Polytrage | Cross-platform (Polymarket ↔ Kalshi) |
| **Whale Tracking** | PolyTrack, PolyInsider, MobyScreener | Follow smart money |
| **Copy Trading** | PolyCup, Stand, Polyswipe | Mirror top traders |
| **Data** | Oddpool, Probalytics, Marketlens | Tick-level order book history |
| **Open Source Bots** | polybot, PolyClaw, Simmer, oracle3 | Actual trading code |

**PolyClaw** is interesting — OpenClaw skill for Polymarket with LLM-powered hedge discovery. **Simmer** is an agent harness with paper trading + self-improving loops.

---

## How Our Bot Compares

| Dimension | Our Bot | Pro Bot (polybot) | Gap |
|-----------|---------|-------------------|-----|
| **Data** | REST poll 10s | WebSocket 250ms | 40x slower, blind to fast moves |
| **Strategy** | Buy one side, hope | Quote both sides, hedge | No edge, pure gambling |
| **Direction view** | Yes (we bet Up or Down) | No (delta-neutral) | We take risk they avoid |
| **Fees** | ✅ Modeled (just added) | ✅ Modeled | Even |
| **Bankroll mgmt** | None | Multi-layer caps | We can blow up |
| **Arbitrage** | None | Complete-set (up+down<$1) | Missing free money |
| **Position mgmt** | Open and pray | Hedge every fill | No risk control |
| **LLM** | None | None (for HFT) | Even — LLM too slow for this |
| **Real trading** | Paper only | Live execution | Can't validate fills |
| **Persistence** | In-memory | ClickHouse | We lose state on restart |

---

## The Hard Truth

**Our 4 strategies are all "Approach A" (directional prediction) done badly:**
- Coin Flip: random prediction
- Late Scalp: weak prediction (buy favorite)
- Snipe: contrarian prediction (buy underdog)
- Momentum: trend prediction (broken — no price history)

**None of them do "Approach B" (market making), which is where the money is.**

The PRD's "95¢ scalp" is a hybrid — it's directional (buy the favorite) but relies on high conviction (95%+) to reduce risk. It's the simplest possible edge. But the real bots don't even do that — they make markets.

---

## What This Means — Three Paths Forward

### Path 1: Finish the PRD strategy (simplest, educational)
- Tune Late Scalp to 95¢ entry, 35s window (in progress)
- Add 1-second polling
- Keep it paper-only
- **Result:** A working demo of directional scalping. Won't make real money (fees + competition), but proves the concept.

### Path 2: Build a market maker (harder, real edge)
- Add WebSocket order book client
- Implement both-sides quoting
- Add complete-set arbitrage detection
- Add inventory skew + hedge-on-fill
- Add bankroll management
- **Result:** The actual strategy that makes money. Much more complex.

### Path 3: LLM-assisted (different edge, slower markets)
- Use LLM for event markets (politics, sports)
- Multi-model consensus
- Research pipeline (news, sentiment)
- **Result:** Different game entirely. Not 5-min BTC. More like "will X happen this month."

---

## Recommendation

**For learning:** Finish Path 1. Get the 95¢ scalp working end-to-end with real data. Understand why it's hard (competition, fees, timing).

**For money:** Path 2 is the only one that actually works. But it's a 10x complexity increase and needs real execution (wallet, gas, fills) to validate.

**Don't pursue:** Path 3 for 5-min markets. LLMs are too slow. Keep LLM for research/intelligence (what UI fella is doing), not execution.

---

## Files to Study Further

```
tempis/polybot/strategy-service/src/main/java/com/polybot/hft/polymarket/strategy/
├── GabagoolDirectionalEngine.java    ← The brain (read this first)
├── service/QuoteCalculator.java      ← Pricing logic
├── service/OrderManager.java         ← Order lifecycle
├── service/PositionTracker.java      ← Inventory tracking
├── service/BankrollService.java      ← Capital management
├── config/GabagoolConfig.java        ← All the knobs
└── config/TimingConfig.java          ← When to trade

tempis/agents/agents/application/
├── prompts.py                        ← LLM prompts (Approach A)
├── executor.py                       ← Order execution
└── trade.py                          ← Trade flow
```
