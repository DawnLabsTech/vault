# Dawn Labs Vault

Solana DeFi Vault - base-first yield optimization with conditional alpha.

> Japanese version: [README.ja.md](./README.ja.md)

## Architecture

```text
vault/
├── backtest/    # Strategy research / backtesting engine (TypeScript)
├── bot/         # Live strategy execution bot (TypeScript)
└── frontend/    # Internal monitoring dashboard (Next.js)
```

## Strategy Overview

**Design Philosophy:** Each Vault uses a two-layer architecture - **Base Layer (always-on) + Alpha Layer (conditional)**. The Base Layer is responsible for durable yield and capital preservation. The Alpha Layer is opportunistic and only turns on when market conditions justify the extra complexity.

### Current Operating Mode (2026-04)

- **Base-first allocator:** deployable USDC is routed to the active Kamino Multiply position first. Lending is the overflow and diversification sleeve when Multiply capacity, health, or risk constraints block additional size.
- **DN is opportunistic, not baseline:** the SOL delta-neutral leg is enabled only when funding is strong enough. In the current market regime it is expected to stay idle.
- **Runtime thresholds live in config:** the bot and the backtest CLI both default to the current live settings from `bot/config/default.json`.

### Vault Lineup

| | USDC Vault | SOL Vault | BTC Vault |
|---|---|---|---|
| **Base Layer** | Kamino Multiply (primary) + USDC Lending (overflow) | Validator Staking (6-7%) | cbBTC Lending (1-3%) |
| **Alpha Layer** | SOL Delta-Neutral (conditional) | LST Loop (10-20%) | cbBTC collateral -> USDC borrow -> SOL DN (3.5-11%) |
| **Rebalance Freq** | Daily-Weekly | Monthly (swap cost sensitive) | Weekly-Monthly (LTV mgmt) |
| **Decision Metric** | Multiply spread + SOL Funding Rate | LST yield - SOL borrow rate spread | SOL FR + USDC borrow cost + BTC price |
| **Phase** | **Phase 1 (Active)** | Phase 2 | Phase 3 |

### USDC Vault (Phase 1 - Active)

Hybrid on-chain + off-chain architecture.

**Base Layer - Capital Allocation**

The live bot operates in a **Multiply-first / Lending-second** mode:

- `CapitalAllocator` sends deployable USDC to the active Kamino Multiply position first.
- `BaseAllocator` manages the lending sleeve across Kamino / Jupiter only for overflow, diversification, and withdrawal buffer management.
- Wallet buffer is preserved before deployment using `lending.bufferPct`.

**Base Layer - Kamino Multiply (Primary)**

Leveraged stablecoin loops via Kamino to earn native yield + borrow rewards:

| Pool | Market | Effective APY | Notes |
|---|---|---|---|
| ONyc/USDC (Primary) | RWA Market | ~16% @ 2.5x | ONyc native yield ~10.25% via Onre |
| USDG/PYUSD (Backup) | Main Market | ~9.5% @ 5.75x | Fallback when ONyc/USDC degrades |

The Market Scanner continuously monitors candidate pools and recommends switching only when the 24h moving-average APY advantage is large enough to repay the estimated switch cost within the configured payback window **and** the destination candidate clears the live risk gate. The Multiply Risk Scorer evaluates each pool on 4 dimensions (depeg risk, liquidation proximity, exit liquidity, reserve pressure) as a separate risk axis. Risk does not reduce displayed APY; it gates allocation, trims oversized positions, and forces exits at explicit score thresholds.

Current live policy:

- Candidate pools with score `>= 75` are excluded from switch targets.
- Active Multiply positions stop accepting new capital at score `>= 75`.
- Active Multiply positions are trimmed to the dynamic `maxPositionCap` when score is in the `75-89` band.
- Active Multiply positions are fully exited when score reaches `>= 90`.

**Base Layer - Lending (Supplementary)**

USDC lending on Kamino / Jupiter Lend (3-8%) is used as the supplementary sleeve. It absorbs capital that cannot be added to Multiply and enforces diversification through a single-protocol cap. Lending Risk Scorer evaluates protocols on 5 dimensions (TVL, maturity, utilization, concentration, incidents) with APY penalty adjustment.

> **Note:** Drift has been excluded due to the 2025 hack. All Drift code paths are `@deprecated`.

**Alpha Layer - SOL Delta-Neutral**

- USDC -> dawnSOL (on-chain, Jupiter) + SOL-PERP short (Binance Futures), executed in parallel
  - dawnSOL provides ~7% staking yield on the long leg
  - 1x leverage only (no liquidation risk on perp side)
  - Activated only when SOL funding rate is sufficiently positive

| Signal | Live runtime setting |
|---|---|
| DN entry | Average SOL funding rate `> 10%` annualized for `3` days |
| DN exit | Funding remains below `0%` annualized for `3` days |
| DN emergency exit | Latest funding rate `< -10%` annualized |
| DN allocation cap | Up to `70%` of NAV, capped by `risk.maxPositionCapUsd` |

Confirmation-day semantics:

- A "day" means one complete UTC day with all `3` expected 8-hour funding samples recorded.
- Partial days are ignored for DN entry / exit confirmation and for the multi-day average used by the entry gate.
- Emergency exit still keys off the latest funding print and does not wait for a full day.

> **Current Status (2026-04):** SOL-PERP funding rates have been negative for an extended period. DN is expected to remain dormant. The correct live posture is base-first: Multiply primary, Lending supplementary, DN at zero until funding improves.

**Historical Reference (Not Live Config)**

A prior 5.5-year Walk-Forward study produced a cleaner but older signal set:

- Entry: FR `> 15%` annualized for `2` days
- Exit: FR `< -2%` annualized for `1` day
- DN allocation: `50%`
- Result: `8.57%` annualized return, Sharpe `13.41`, max drawdown `-0.07%`

These numbers remain useful as research context, but they are **not** the current runtime parameters.

### Excluded Strategies

| Strategy | Reason |
|---|---|
| Drift | Hack - unusable, code deprecated |
| USDC/USDT Leverage Loop | Borrow rate spike (Drift fallout) makes spread negative |
| JLP / LP / Insurance Pools | Principal loss risk - incompatible with Vault mandate |
| PRIME (Hastra Finance) | Insufficient track record |
| CASH (Perena Finance) | Insufficient track record, minimal TVL |
| ONyc/USDG | Only 0.18% APY advantage over ONyc/USDC with worse USDG liquidity |

### Structural Alpha: Validator-Native Vault

- **dawnSOL yield uplift** - ~7% staking rewards auto-compounded on the DN long leg
- **Yield Smoothing Reserve** - Validator commission-derived reserve absorbs APY dips (Phase 2)
- **Skin in the Game** - Team capital deployed in the same strategy
- **Japan Gateway** - First Japanese-language Vault on Solana

## Bot Components

```text
bot/src/
├── core/
│   ├── orchestrator.ts    # Main loop: state eval -> allocate -> execute -> measure
│   ├── fr-monitor.ts      # Binance SOL-PERP funding rate polling & threshold check
│   ├── state-machine.ts   # BASE_ONLY <-> BASE_DN state transitions
│   ├── market-scanner.ts  # Kamino Multiply pool APY comparison & switch recommendations
│   ├── multiply-risk-policy.ts  # Explicit trim / exit rules for active Multiply positions
│   └── scheduler.ts       # Cron-based task scheduling
├── strategies/
│   ├── base-allocator.ts  # Lending-only allocator for overflow and diversification
│   ├── capital-allocator.ts  # Base capital allocator: Multiply first, Lending overflow
│   └── dn-executor.ts     # Delta-neutral open / close / rebalance
├── risk/
│   ├── risk-manager.ts    # FR reversal detection, anomaly detection, auto-exit
│   ├── multiply-risk-scorer.ts  # 4-dimension risk scoring for Multiply pools
│   ├── lending-risk-scorer.ts   # 5-dimension risk scoring for Lending protocols
│   ├── protocol-circuit-breaker.ts  # TVL crash / oracle drift / withdrawal failure -> auto-exit
│   └── guardrails.ts      # Kill switch, SOL balance check, price freshness
├── connectors/
│   ├── defi/              # Kamino (Multiply/Loop/Lending), Jupiter (Swap/Lend), Onre APY
│   ├── binance/           # REST + WebSocket clients for Futures
│   └── solana/            # RPC, wallet, token operations
├── measurement/
│   ├── snapshots.ts       # Portfolio state snapshots (SQLite)
│   ├── pnl.ts             # Daily P&L calculation
│   ├── events.ts          # Ledger event recording
│   └── state-store.ts     # Persistent bot state (JSON)
└── utils/                 # Logger, notifications (Slack), retry, tx-fee
```

### Risk Management

| Layer | Mechanism | Trigger |
|---|---|---|
| **Circuit Breaker** | Auto-exit from Lending layer | TVL crash (-20%/1h), oracle drift, withdrawal failure |
| **Multiply Risk Scorer** | Separate risk axis for candidate / position scoring | 4 dimensions: depeg risk, liquidation proximity, exit liquidity, reserve pressure |
| **Multiply Risk Policy** | Explicit score-based rebalance rules | Score < 75 -> normal, 75-89 -> stop adds + trim to `maxPositionCap`, >= 90 -> full exit / emergency deleverage |
| **Lending Risk Scorer** | APY penalty adjustment | 5 dimensions: TVL, maturity, utilization, concentration, incidents |
| **Protocol Diversification** | Max 60% allocation cap | Single-protocol lending exposure limit for the supplementary lending sleeve |
| **Multiply Health Deleverage** | Staged health rate protection | HR < 1.20 -> high-freq monitor, < 1.10 -> soft deleverage (20%), < 1.05 -> emergency full deleverage |
| **DN Risk Manager** | FR reversal detection + auto-exit | FR < -10% annualized -> immediate close |
| **Guardrails** | Kill switch, SOL balance, price freshness | Prevents tx fee exhaustion and stale data decisions |

Notes on current Multiply risk logic:

- ONyc depeg is measured against its reference / redemption-style rate, not a hardcoded `1.0`.
- Candidates with score `>= 75` are excluded from market-switch targets.
- Active Multiply positions stop accepting new capital at score `>= 75`.
- Active Multiply positions are trimmed to the dynamic `maxPositionCap` when score is in the `75-89` band.
- Active Multiply positions are fully exited when score reaches `>= 90`.

## Research Notes

### Hyperliquid SOL Perp (2026-03, Declined)

Evaluated Hyperliquid SOL Perp as an alternative short leg for the DN strategy. Compared 90 days of funding rate data against Binance - did not meet the threshold.

| Period | Hyperliquid | Binance | Diff |
|---|---|---|---|
| 7d avg | -6.25% | -4.97% | -1.28% |
| 30d avg | -9.47% | -6.96% | -2.51% |
| 90d avg | -3.20% | -3.21% | +0.01% |

- Threshold: annualized FR >= 5% -> Go / otherwise -> Decline
- Result: **NO-GO** (both exchanges in negative FR regime, no advantage for Hyperliquid)
- Script: `bot/scripts/compare-funding-rates.ts`
- May revisit if market conditions change

### Kamino Multiply SDK (Technical Note)

`getDepositWithLeverageIxs` exceeds transaction size limits (flash loan + swap). Implemented manual loop approach (`deposit -> borrow -> swap -> re-deposit`) as a workaround. Jito bundle support is a future improvement.

## Test Coverage

220 tests across 19 test files. Run with `cd bot && npm test`.

| Category | Module | Tests | What's Verified |
|---|---|---|---|
| **Core** | State Machine | 20 | BASE_ONLY ↔ BASE_DN transitions, FR threshold gates, emergency exit priority, force override, operation lock, allocation cap |
| | Orchestrator | 2 | State evaluation loop, action dispatch |
| | FR Monitor | 25 | Consecutive-day counting, partial-day exclusion, SQLite persistence, threshold queries |
| | Market Scanner | 15 | APY scanning, 24h moving average, switch recommendation with payback economics, capacity filtering, risk score gating, SQLite history, graceful failure (Promise.allSettled) |
| | Switch Economics | 3 | Payback window calculation, cost/gain comparison, min net gain buffer |
| | Multiply Risk Policy | 4 | Score-based trim/exit rules, health + risk dual control, emergency deleverage |
| **Risk** | Guardrails | 18 | Kill switch, daily loss limit (2%), position cap, transfer size limit, SOL balance, price freshness, position divergence |
| | Risk Manager | 14 | Continuous monitoring, alert escalation, pre-trade checks |
| | Multiply Risk Scorer | 4 | Jupiter price integration, fallback to lite-api, neutral-price fallback, ONyc reference rate depeg |
| | Lending Risk Scorer | 8 | 5-dimension scoring (TVL, maturity, utilization, concentration, incidents), APY penalty |
| | Protocol Circuit Breaker | 9 | TVL crash detection, consecutive failures, oracle deviation, cooldown, re-enable |
| **Strategies** | DN Executor | 47 | Multi-step entry/exit state machine, parallel leg execution, error recovery, resume from partial failure, step ordering |
| | Capital Allocator | 11 | Multiply-first allocation, health/risk blocking, lending overflow, buffer preservation |
| | Base Allocator | 11 | APY-ranked protocol selection, max protocol cap (60%), rebalance hysteresis, diversification |
| **Connectors** | DN Connectors | 30 | Mock interface for exchange + protocol operations |
| | Kamino Lending | 2 | Balance parsing, APY query |
| | Kamino Multiply | 2 | Leverage position query |
| **Measurement** | PnL | 3 | External flow detection, deposit exclusion from returns, internal rebalance filtering |
| **Utils** | Math | 14 | FR ↔ annualized conversion, Sharpe ratio, max drawdown, Big.js rounding |
| | Retry | 7 | Exponential backoff, max attempts, jitter, immediate success/failure |

## Development

```bash
# Bot
cd bot && npm install

# Backtest
cd backtest && npm install
npm run backtest -- --help

# Frontend (local dev)
cd frontend && npm install
PORT=4001 npm run dev
```

## Workflow

- Feature branches -> PR -> Code review -> Merge to `main`
