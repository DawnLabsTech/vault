# Dawn Labs Vault

Solana DeFi Vault — Multi-strategy yield optimization with dynamic allocation.

> Japanese version: [README.ja.md](./README.ja.md)

## Architecture

```
vault/
├── backtest/    # Strategy backtesting (Python)
├── bot/         # Strategy Execution Bot (TypeScript)
└── frontend/    # Internal monitoring dashboard
```

## Strategy Overview

**Design Philosophy:** Each Vault uses a two-layer architecture — **Base Layer (always-on) + Aggressive Layer (conditional)**. The Base Layer ensures yield never drops to zero, while the Aggressive Layer boosts APY only when market conditions are favorable.

### Vault Lineup

| | USDC Vault | SOL Vault | BTC Vault |
|---|---|---|---|
| **Base Layer** | USDC Lending (3–8%) | Validator Staking (6–7%) | cbBTC Lending (1–3%) |
| **Aggressive Layer** | SOL Delta-Neutral (15–30%) | LST Loop (10–20%) | cbBTC collateral → USDC borrow → SOL DN (3.5–11%) |
| **Rebalance Freq** | Daily–Weekly | Monthly (swap cost sensitive) | Weekly–Monthly (LTV mgmt) |
| **Decision Metric** | SOL Funding Rate | LST yield − SOL borrow rate spread | SOL FR + USDC borrow cost + BTC price |
| **Complexity** | Medium | Medium–High | Highest |
| **Phase** | **Phase 1 (Hackathon MVP)** | Phase 2 | Phase 3 |

### USDC Vault (Phase 1 — Hackathon MVP)

Hybrid on-chain + off-chain architecture:

- **Base Layer:** USDC lending on Kamino / Drift / Jupiter Lend (auto-select best APY)
- **Aggressive Layer:** Delta-neutral via USDC → SOL → dawnSOL (on-chain, Jupiter) + SOL-PERP short (Binance Futures)
  - dawnSOL provides ~7% staking yield on the long leg
  - 1x leverage only (no liquidation risk on perp side)
  - Activated only when SOL funding rate is sufficiently positive

**Allocation Logic:**

| Market Condition | Lending | Delta-Neutral | Trigger |
|---|---|---|---|
| FR High | 30–50% | 50–70% | SOL FR > threshold sustained |
| FR Neutral | 70–80% | 20–30% | Maintain existing positions |
| FR Negative | 100% | 0% (gradual exit) | FR < 0 sustained → close positions |

### Structural Alpha: Validator-Native Vault

- **dawnSOL yield uplift** — ~7% staking rewards auto-compounded on the DN long leg
- **Yield Smoothing Reserve** — Validator commission-derived reserve absorbs APY dips
- **Skin in the Game** — Team capital deployed in the same strategy
- **Japan Gateway** — First Japanese-language Vault on Solana

## Bot Components

| Component | Role |
|---|---|
| FR Monitor | Binance SOL-PERP funding rate polling & threshold check |
| State Machine | BASE_ONLY ⇔ BASE+DN state transitions |
| Lending Aggregator | Kamino / Drift / Jupiter Lend APY comparison & auto-routing |
| dawnSOL Swap | USDC ⇔ SOL ⇔ dawnSOL swap via Jupiter API |
| Binance Executor | SOL-PERP short open/close, margin management |
| Risk Manager | FR reversal detection, anomaly detection, auto-exit |

## Development

```bash
# Bot
cd bot && npm install

# Backtest
cd backtest && pip install -r requirements.txt
```

## Workflow

- Feature branches → PR → Code review → Merge to `main`
