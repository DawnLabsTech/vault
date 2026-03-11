# BTC Vault

**Status: Coming Soon (Phase 3)**

The BTC Vault accepts BTC (as cbBTC on Solana) and generates yield through lending and a multi-hop delta-neutral strategy.

## Overview

| Parameter | Value |
|-----------|-------|
| **Deposit Asset** | cbBTC (Coinbase Wrapped BTC on Solana) |
| **Target APY** | 3.5–11% |
| **Base Layer** | cbBTC Lending (1–3%) |
| **Alpha Layer** | cbBTC Collateral → USDC Borrow → SOL DN (3.5–11%) |
| **Rebalancing** | Weekly to monthly (includes collateral LTV management) |
| **Decision Metrics** | SOL FR + USDC borrow cost + BTC price |
| **Complexity** | Highest (multi-hop + collateral management) |

## How It Works

### Base Layer: cbBTC Lending

cbBTC is deposited into lending protocols to earn a base yield.

- **Always-on** — Provides consistent yield
- **Expected APY**: 1–3%
- **Risk**: Smart contract risk, cbBTC wrapper risk

### Alpha Layer: Collateralized Delta-Neutral

A multi-step strategy that unlocks SOL funding rate yield from BTC collateral:

1. Deposit cbBTC as collateral
2. Borrow USDC against cbBTC (conservative LTV: 50%)
3. Execute SOL delta-neutral strategy with borrowed USDC
4. Net yield = SOL FR income − USDC borrow cost

- **Conditional** — Requires both positive SOL FR AND acceptable USDC borrow cost
- **Expected effective APY**: 3.5–11%
- **Risk**: BTC price drop → collateral liquidation, FR reversal, borrow cost spike

### Collateral Risk Management

BTC price movements directly affect collateral LTV. A 4-stage deleverage protocol protects against liquidation:

| LTV Level | Action | Priority |
|-----------|--------|----------|
| **> 55%** | Alert + stop new alpha allocation | Warning |
| **> 60%** | Partial USDC repayment → restore LTV to 50% | Moderate |
| **> 65%** | Aggressive deleverage (>50% of alpha positions repaid) | High |
| **> 70%** or BTC 24h change > 15% | Full position close (priority fee auto-increase) | Critical |

Liquidation threshold is 90%, providing a ~22% BTC drawdown buffer from the 70% emergency close level.

## Why It's the Most Complex Vault

The BTC Vault requires managing **two independent decision variables** (SOL FR + USDC borrow cost) plus real-time BTC price-driven collateral management. This multi-hop structure introduces more points of failure than USDC or SOL vaults, which is why it is planned as Phase 3 — only after operational excellence is proven with simpler strategies.

## Allocation Logic

| Condition | Action |
|-----------|--------|
| SOL FR profitable AND borrow cost acceptable | Activate alpha layer |
| SOL FR drops OR borrow cost rises | Reduce/exit alpha positions |
| FR < 0 or BTC sharp move | Full retreat to base layer (lending only) |

---

*BTC Vault is in the planning phase. Architecture and parameters are subject to change. [View Roadmap →](../resources/roadmap.md)*
