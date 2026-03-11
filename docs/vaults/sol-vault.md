# SOL Vault

**Status: Coming Soon (Phase 2)**

The SOL Vault accepts SOL deposits and generates yield through validator staking and LST loop strategies.

## Overview

| Parameter | Value |
|-----------|-------|
| **Deposit Asset** | SOL |
| **Target APY** | 10–20% |
| **Base Layer** | Validator Staking (6–7%) |
| **Alpha Layer** | LST Loop (10–20%) |
| **Rebalancing** | Monthly (frequent switching is cost-prohibitive) |
| **Decision Metric** | LST yield – SOL borrow rate spread |

## How It Works

### Base Layer: Dawn Validator Staking

SOL is delegated to Dawn Labs' own validator.

- **Always-on** — Earns network staking rewards consistently
- **Expected APY**: 6–7%
- **Cost**: Zero (validator commission is internal revenue)
- **Risk**: Validator downtime, future slashing

### Alpha Layer: LST Loop

When the spread between LST yield and SOL borrow rate is sufficiently wide, the vault deploys an LST loop strategy:

1. Stake SOL → Receive dawnSOL (or use Jupiter Native Stake)
2. Use dawnSOL as collateral to borrow SOL
3. Restake borrowed SOL → More dawnSOL
4. Repeat (leveraged staking yield)

- **Conditional** — Only activated when spread is sufficient; **long-term hold** (weeks to months)
- **Expected APY**: 10–20% (with loop leverage)
- **Cost**: Swap fees, borrow interest
- **Risk**: Rate reversal, liquidation, LST issuer risk

### Allocation Logic

| Market Condition | Staking Allocation | LST Loop Allocation | Trigger |
|---|---|---|---|
| **Spread Wide** | 30–50% | 50–70% | LST yield − SOL borrow > 3% for 1 week |
| **Spread Narrow** | 80–90% | 10–20% | Maintain existing; enhanced monitoring |
| **Negative Spread** | 100% | 0% (gradual unwind) | Spread < 0% for 2 weeks |

> LST Loop positions incur swap costs on open/close, so frequent switching results in fee losses. Monthly decision cycles are standard.

## LST Strategy Options

Two paths exist for leveraged SOL yield, each with different risk profiles:

| | dawnSOL × Kamino | Jupiter Native Stake |
|---|---|---|
| **Mechanism** | dawnSOL collateral → borrow SOL → loop | Direct staking as collateral via Jupiter |
| **Oracle** | Pyth Push Feed (multi-source) | Theoretical price (stake rate) |
| **Max Leverage** | ~10x (eMode) | Varies |
| **Liquidation Buffer** | LTV 87% / Liquidation 88% — tight (1%) | Wider buffer (theoretical pricing) |
| **Best For** | Higher yield potential | Lower liquidation risk |

## Risks

- **Rate Reversal**: SOL borrow rate exceeding LST yield creates negative carry
- **Liquidation**: High LTV positions can be liquidated during LST price volatility
- **LST Issuer Risk**: Dependency on LST protocol security
- **Validator Risk**: Dawn validator downtime affects staking rewards

---

*SOL Vault is currently in development. Details are subject to change. [Subscribe for updates →](../resources/roadmap.md)*
