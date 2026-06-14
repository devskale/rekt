# Agentic World Cup Trading Research

*Last updated: June 14, 2026*

## Executive Summary

The 2026 FIFA World Cup is live (June 11-104 matches across USA/Mexico/Canada). Polymarket has 381+ active markets. Multiple profitable bot strategies exist, with proven edge from latency arbitrage, market making, and momentum trading.

---

## Market Overview

**World Cup 2026 Status**
- Start date: June 11, 2026
- Matches: 104 games total
- Locations: USA, Mexico, Canada
- Teams: 48 teams (expanded from 32)

**Polymarket Markets Available**
- Tournament winner (Spain, Argentina, Brazil favorites per Minara AI)
- Group winners (all 12 groups)
- Match outcomes (104 games)
- Player props (top scorer, etc.)
- Knockout round props
- Live in-play markets (5-minute windows available)

**Current Odds Snapshot (June 14, 2026)**
- Germany vs Curaçao: Germany 94%, Draw 4%, Curaçao 2.4%
- High confidence markets trade near 90-98¢ with minimal liquidity
- Mid-tier matches show wider spreads (opportunity zone)

---

## Proven Bot Strategies

### 1. Cross-Platform Odds Arbitrage ⭐ *Highest Edge*

**What it is:** Compare Polymarket odds vs sportsbooks (Pinnacle, DraftKings, Bet365)

**Edge:** Sportsbooks move first → Polymarket lags 2-10 seconds during live events

**Implementation:**
- Scrape sportsbook APIs for live odds
- Detect divergence >1%
- Execute on Polymarket CLOB before correction
- Exit once prices converge

**Real examples:**
- 27% of profitable bot profits came from non-arbitrage cross-platform strategies
- Claw Arbs supports Polymarket, Kalshi, Pinnacle, Stake.com, BC.Game

**Tools:**
- Sportsbook APIs: Bet365, Pinnacle, DraftKings
- Scraping libraries: BeautifulSoup, Puppeteer
- Arbitrage detection: Custom algorithm

---

### 2. Intra-Market Arbitrage (YES+NO < $1)

**What it is:** Buy both sides when combined price < $1 (e.g., YES=$0.52, NO=$0.43 = $0.95)

**Edge:** Risk-free profit at settlement ($1 guaranteed payout)

**Window:** 2-4 seconds during panic repricing (goals, red cards, injuries, VAR decisions)

**Real example:** `@borntogambles` made $66,296 in 4 months on oil markets using this exact strategy:
- 439 trades executed
- 86% clean fills
- Best single catch: $8,240
- Bot scans in 123ms, catches gap, fires both legs

**Strategy constraints:**
- Speed is critical (need both legs within 2-4s window)
- Partial fills ruin the edge
- Only works during high volatility moments

**Implementation requirements:**
- Sub-100ms order placement
- Simultaneous multi-leg execution
- WebSocket connection to Polymarket CLOB

---

### 3. Momentum/Live Trading ⭐ *Best for World Cup*

**What it is:** Trade in-play markets during matches using 5-minute windows

**Edge:** Crowd overreacts to events (goal = instant 30% price swing, often overshoots)

**Strategy details:**
- Monitor live match data (goals, shots, possession, time remaining)
- Detect delayed repricing on Polymarket vs actual game state
- Enter before correction completes (typically 10-30 seconds post-event)
- Exit when prices stabilize

**Real examples from crypto markets:**
- Bots specializing in 5-15 min BTC/ETH markets profit from this pattern
- `$130K bot` mentioned by McDuckCrypto uses momentum + dynamic hedging
- 4-minute momentum edge strategy exists (awaiting `recentPrices` data)

**Events that trigger price movement:**
- Goal scored (largest, most predictable)
- Red card (significant)
- Penalty awarded (medium)
- VAR review announcements (short-term)
- Substitutions (minor)

**Implementation requirements:**
- Live sports data feed (API-Football, SportMonks, or free alternatives)
- Polymarket CLOB WebSocket for real-time odds
- Momentum detection algorithm
- Fast execution infrastructure

---

### 4. Stink Bid Copy Trading 🐋

**What it is:** Track whale wallets ($100K+ profit traders), place limit bids 10-20% below their entry

**Edge:** Get filled only if market moves against them (better entry + same thesis)

**How it works:**
1. Scan 6,000+ Polymarket wallets
2. Filter to top 1% performers (≥$100K profit)
3. Monitor their recent trades
4. Place stink bids (limit orders) at discount
5. Only fill if whale gets squeezed

**Real example:** MoonDev's Opus 4.7 bot front-runs whales consistently using this strategy

**Benefits:**
- No risk of being front-run (you're setting the price)
- Leverage proven profitable strategies
- Better risk/reward than following blindly

**Tools:**
- Crisp: `https://crisp.watch/` - wallet tracking
- Polymarket Analytics: `https://polymarketanalytics.com/`
- Polymarket API for trade history

---

### 5. Market Making (Spread Collection)

**What it is:** Provide liquidity on both sides, collect bid-ask spread

**Edge:** Fee rebates at edges (5¢ or 95¢), zero fees for resting orders

**Real example:** Bot made $15K in 2 months passively on BTC 15-min markets:
- Passive market making grid on both sides
- 2-second refresh loop
- No predictions, just systematic execution
- 96% fill rate on available windows

**Critical warning:** Avoid 50¢ middle (highest fees = 2% quadratic)
- Cheap near 1¢ and 99¢: fees ~0.1%
- Middle (50¢): fees ~2%
- Resting GTC orders: zero fees, may earn rebates

**Implementation:**
- Quote both sides simultaneously
- Use limit orders (no market orders)
- Manage inventory risk (hedge opposite side)
- 2-5 second refresh cycle

---

### 6. Pre-Tournament Diversification 📊

**What it is:** Buy shares across 20-30 teams at various odds

**Edge:** Capture value from mispriced longshots + hedge favorites

**Real example:** Whale with $351K position:
- Bought 27 different national teams to win World Cup
- Avoided biggest underdogs
- Averages into positions over time
- Closes after group stage based on performance

**Strategy:**
- Pre-tournament: Build basket across 20-30 teams
- Group stage: Close losers, add to emerging winners
- Knockout stage: Concentrate on remaining value

---

## Critical Lessons from Failed Bots

| Mistake | Why It Kills | Fix |
|---------|--------------|-----|
| Trading at 50¢ | 2% fee = need 53% win rate to break even | Trade edges (5-20¢ or 80-95¢) |
| Backtest without fees | 74% win rate → 52% live | Include 1% fees + slippage |
| Copying public wallets | By the time you see it, edge is gone | Use stink bids, don't sweep |
| Latency arbitrage on BTC 15-min | 2.7s lag is DEAD (2026 data) | Focus on sports, not crypto |
| No position sizing | One bad market = liquidation | Kelly fraction, max 5% per market |
| Shared hosting infrastructure | Context switching kills latency | Dedicated bare metal, CPU pinning |

### Key Insight from PolyBackTest
> The "2.7 second lag" narrative is marketing fiction. We tested 32,832 BTC price events. Polymarket reprices in the same 100ms window as Binance. The latency arbitrage strategy is dead in crypto. Focus on sports where information edges still exist.

---

## Realistic Performance Expectations

Based on public wallet analysis and bot performance:

| Strategy | Win Rate | Avg Return/Trade | Trades/Day | Monthly Potential* |
|----------|----------|------------------|------------|-------------------|
| Arb (YES+NO < $1) | ~85% | 1-3¢ per $1 | 50-200 | $5-20K |
| Momentum/Live | ~58% | 5-15¢ per $1 | 10-50 | $2-10K |
| Market Making | N/A | 0.5-2¢ per trade | 500-2000 | $3-15K |
| Copy Trading | ~62% | 3-8¢ per $1 | 20-100 | $1-5K |

*Depends on capital deployed. Most successful wallets use $1-10K capital.

### The Compounding Reality
From `@0xSecta` (trader who made $20K in 2 months):
> The best trader I've seen did not win by hitting one massive bet. He won by repeating a tiny edge almost 1,900 times. Biggest single-trade profit: only $1,535. The money came from finding a small, repeatable edge and executing it again and again until the math started compounding.

---

## Implementation Roadmap

### Phase 1: Foundation (Week 1)

**1. Polymarket CLOB API Integration**
- Implement WebSocket connection for live orderbook
- Add market fetching (filter for World Cup markets)
- Implement order placement/cancellation

**2. Basic Intra-Market Arb Detector**
- Scan all World Cup markets every 1-2 seconds
- Detect YES+NO < $0.98 opportunities
- Alert or auto-execute (configurable)

**3. Paper Trading Setup**
- Use existing `PaperTrader` from `src/engine/paper-trader.ts`
- Simulate trades with realistic slippage and fees
- Track P&L, win rate, edge detection

### Phase 2: Live Trading (Week 2-3)

**4. Live Sports Data Feed**
- Integrate API-Football or SportMonks
- Parse match events (goals, red cards, penalties)
- Feed momentum detection algorithm

**5. Momentum Strategy**
- Implement 5-minute window trading
- Enter on goal events within 30 seconds
- Exit when prices stabilize

**6. Deploy Small Capital**
- Start with $100-500
- Limit to 5% per market
- Monitor live performance

### Phase 3: Scale & Optimize (Knockout Rounds)

**7. Cross-Platform Arb**
- Integrate sportsbook APIs
- Detect >1% divergence
- Execute before correction

**8. Stink Bid Copy Trading**
- Track top whale wallets
- Place discounted limit orders
- Auto-size based on conviction

**9. Scaling**
- Increase capital based on Phase 1-2 performance
- Optimize execution latency
- Add regime filtering (weekend vs weekday)

---

## Adapting Existing Codebase

The trading repo already has 80% of what's needed:

| Need | Existing Code | Adaptation Required |
|------|---------------|---------------------|
| Fetch markets | `fetchBtc5minMarkets()` | → `fetchWorldCupMarkets()` (Polymarket API) |
| Parse outcomes | `GammaMarketSchema` | → `SportsMarketSchema` (win/draw/lose) |
| Simulate trades | `PaperTrader` | Works as-is (swap BTC for soccer) |
| Capture depth | `fetchDepth(tokenId)` | Use Polymarket CLOB orderbook |
| Strategy interface | `Strategy.decide()` | Implement `SoccerStrategy` |
| Logger | `src/logger.ts` | Same pattern |
| Fee math | `calcFee()` | Works as-is |

**New pieces needed:**
1. Polymarket CLOB API integration (WebSocket for live odds)
2. Sports data feed (API-Football, SportMonks, or free alternatives)
3. Cross-platform scraper (optional: sportsbook odds for arb)
4. Live match state tracker (goals, time remaining, red cards)

---

## Resources & Tools

### API Documentation
- Polymarket API: `https://polymarket.github.io/docs/`
- CLOB V2 migration guide: Critical (May 2026 changes)
- Gamma API: Alternative backend

### Data Sources
- **Sports data:**
  - API-Football: Comprehensive football data
  - SportMonks: Real-time football stats
  - TheSportsDB: Free football API (limited)
  - Football-Data.org: Historical results (good for backtesting)

- **Market data:**
  - Polymarket Analytics: `https://polymarketanalytics.com/`
  - PolymarketSoccer: `https://polymarketsoccer.com/`
  - Crisp: `https://crisp.watch/` - Wallet tracking

### Open Source Bots
- GitHub: 10+ Polymarket sports bot templates
- Claw Arbs: `https://clawarbs.com/` - Arbitrage framework
- OpenClaw: Bot building framework

### Learning Resources
- Medium articles on Polymarket strategies
- YouTube tutorials on bot building
- Reddit: r/PredictionsMarkets, r/Polymarket

### Community & Inspiration
- Follow these accounts on X for strategy ideas:
  - `@kinexbtdev` - Market making insights
  - `@0xSecta` - Edge discovery
  - `@polybacktest` - Honest backtesting
  - `@MoonDevOnYT` - AI bot building

---

## Risk Management

### Position Sizing
- Maximum 5% of capital per market
- Fractional Kelly for sizing: `f = (bp - q) / b` where:
  - b = odds received
  - p = probability of winning
  - q = probability of losing (1-p)

### Drawdown Limits
- Stop trading if daily loss > 10%
- Reduce size if weekly loss > 15%
- Full stop if monthly loss > 20%

### Edge Degradation Monitoring
- Track win rate over rolling 50 trades
- If win rate drops below threshold → pause and investigate
- Strategy performance decays quickly (weeks to months)

---

## Gotchas & Edge Cases

### Polymarket-Specific
1. **Fee structure is quadratic** - highest at 50¢, zero at edges
2. **Order book depth is thin** - partial fills common on small markets
3. **Market stays `active: true` after close** - real cutoff is `now < window_end`
4. **Up/Down token pairs** - need to track both for complete picture

### Sports-Specific
1. **VAR delays** - price may move, then reverse after VAR decision
2. **Injury time** - markets may close after 90 minutes listed
3. **Abandoned matches** - markets may be voided or partial
4. **Suspension delays** - weather can delay/stop matches

### Infrastructure
1. **WebSocket desync** - need reconciliation logic
2. **Partial fills** - may break arbitrage legs
3. **Rate limits** - API calls throttled
4. **Network latency** - need dedicated hosting

---

## Next Steps

1. **Create World Cup market fetcher** using Polymarket API
2. **Implement YES+NO < $1 detector** as first strategy
3. **Set up paper trading environment** using existing PaperTrader
4. **Test during live matches** (tournament is now!)
5. **Deploy small capital** once edge is verified

---

## Key Takeaway

> The edge isn't predicting who wins — it's **faster execution, better risk management, and finding mispricings** that humans miss during live chaos.

Most successful traders don't try to be geniuses. They:
1. Find a small, repeatable edge
2. Automate it ruthlessly
3. Manage risk obsessively
4. Let the math compound over thousands of trades

Your existing architecture is 80% there. The World Cup is happening NOW. Time to start building.