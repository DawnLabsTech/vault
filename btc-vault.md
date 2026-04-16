# BTC Vault

> cbBTC collateral -> USDC borrow -> USDC Vault yield engine. BTC-denominated returns.

## Concept

BTC Vault is a **collateral-to-yield pipeline** that converts BTC deposits into USDC Vault yield while preserving BTC price exposure. Users deposit BTC, the vault borrows USDC against it at low cost, routes borrowed USDC into the existing USDC Vault (Phase 1), and returns BTC-denominated yield.

This architecture generalizes: once the "asset -> USDC borrow -> USDC Vault" pipeline is proven with BTC, the same structure extends to ETH, SUI, and other collateral assets.

```
[BTC Vault]  ─┐
[ETH Vault]  ─┼→ USDC Borrow → [USDC Vault (shared yield engine)] → ~16% APY
[SUI Vault]  ─┘
```

## Why Pattern A (Collateral-Borrow)

BTC holders are long BTC — they bet on price appreciation. A delta-neutral design (Pattern B: spot + perp short) neutralizes that exposure, which conflicts with user intent. Pattern A preserves full BTC upside while generating additional yield from idle collateral.

## Market Selection: Kamino Main Market

Evaluated two Kamino markets (2026-04):

| Market | Size | cbBTC Liq LTV | USDC Borrow APR | Notes |
|---|---|---|---|---|
| **Main Market** | **$1.41B** | **80%** | **4.45%** | Deep liquidity, scalable |
| Bitcoin Market | $3.87M | 87% | 5.01% | Thin liquidity, $500k cap |

**Decision: Main Market.** $1.41B market size removes the scale constraint. USDC borrow rate is also lower.

## Collateral Token: cbBTC

| Token | Supply | Liq LTV | Native APY | Notes |
|---|---|---|---|---|
| **cbBTC** | **$103.91M** | **80%** | **+4.05%** | Coinbase-backed, deepest liquidity |
| xBTC | $24.35M | 80% | +3.72% | Backup candidate |
| FBTC | $11.11M | 80% | — | No native yield |
| WBTC (Bitcoin Market) | $1.84M | 87% | 0.00% | Dead market |
| LBTC (Bitcoin Market) | $0.41M | 80% | 0.38% | Lombard, thin |

**Decision: cbBTC primary.** Largest supply, highest native yield, Coinbase credit backing.

**Open question:** cbBTC Native APY 4.05% source needs verification. May be KMNO incentive (not permanent) rather than Coinbase-native yield. Conservative projections should exclude it.

## Yield Projections

### BTC-Denominated Return = cbBTC Native + (USDC Vault APY - Borrow APR) x LTV

Assumptions: USDC Vault 16% (ONyc/USDC Multiply), USDC Borrow 4.45%, cbBTC Native 4.05%

| Target LTV | Liquidation BTC Drop | Borrow Cost (on BTC) | USDC Vault Yield (on BTC) | cbBTC Native | **Net BTC Yield** |
|---|---|---|---|---|---|
| 40% | -50% | -1.78% | +6.40% | +4.05% | **+8.67%** |
| 45% | -44% | -2.00% | +7.20% | +4.05% | **+9.25%** |
| 50% | -37% | -2.23% | +8.00% | +4.05% | **+9.83%** |
| **55%** | **-31%** | **-2.45%** | **+8.80%** | **+4.05%** | **+10.40%** |
| 60% | -25% | -2.67% | +9.60% | +4.05% | +10.98% |

### Conservative (without cbBTC Native)

| Target LTV | Liquidation BTC Drop | **Net BTC Yield** |
|---|---|---|
| 50% | -37% | **+5.78%** |
| **55%** | **-31%** | **+6.35%** |
| 60% | -25% | +6.93% |

**Target: LTV 55%, ~6-10% BTC-denominated yield** depending on cbBTC Native sustainability.

## Liquidation Risk

### Liquidation Mechanics

Liquidation triggers when: `cbBTC collateral value x Liq LTV (80%) < borrowed USDC`

```
Liquidation BTC price = Current price x (Target LTV / Liq LTV)
Example: LTV 55%, BTC at $70,000 → liquidation at $48,125 (-31%)
```

### Staged Deleverage (mirrors USDC Vault design)

| Health Rate | Action |
|---|---|
| > 1.30 | Normal operation |
| < 1.30 | Monitoring frequency increase |
| < 1.20 | Soft deleverage: withdraw from USDC Vault, repay USDC, reduce LTV to 30% |
| < 1.10 | Emergency full deleverage: unwind all USDC Vault positions, repay all debt |

### Critical Constraint: USDC Vault Withdrawal Latency

The deleverage chain is: USDC Vault unwind (Kamino Multiply exit) -> USDC repayment -> LTV reduction.

- Kamino Multiply exit takes multiple transactions over minutes
- During a BTC flash crash (-20% in minutes), the exit may not complete before liquidation
- **Mitigation:** maintain 20% of BTC Vault's borrowed USDC in instant-withdraw positions (Lending layer only), reserved as emergency repayment buffer

### Historical BTC Drawdowns (reference)

| Event | Drawdown | Duration |
|---|---|---|
| COVID crash (2020-03) | -50% | 2 days |
| China ban (2021-05) | -53% | 12 weeks |
| FTX collapse (2022-11) | -25% | 2 weeks |
| Typical correction | -20 to -30% | Days to weeks |

LTV 55% tolerates -31%, which covers most scenarios except extreme black swans.

## Cost Breakdown ($100,000 cbBTC deposit, LTV 55%)

| Item | Annual Amount | Note |
|---|---|---|
| USDC borrowed | $55,000 | |
| USDC Vault yield (16%) | +$8,800 | Primary return source |
| cbBTC Native (4.05%) | +$4,050 | Sustainability unverified |
| Borrow cost (4.45%) | -$2,447 | Variable — spikes with utilization |
| Swap/tx fees (est.) | -$500 | Slippage, priority fees, protocol fees |
| **Net (with Native)** | **+$9,903 (+9.9%)** | |
| **Net (without Native)** | **+$5,853 (+5.9%)** | Conservative baseline |

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| BTC crash beyond -31% | High | Staged deleverage, emergency buffer |
| USDC borrow rate spike | Medium | Monitor utilization, switch to USDG (3.23%) as fallback |
| USDC Vault underperformance | Medium | Spread turns negative if Vault < 4.45% — auto-pause BTC Vault |
| cbBTC depeg / Coinbase risk | Medium | Monitor cbBTC/BTC price ratio, circuit breaker |
| Kamino smart contract risk | Medium | Inherited from USDC Vault — same exposure |
| USDC Vault withdrawal delay | Medium | 20% emergency buffer in lending-only positions |

## Generalization to Multi-Asset Vaults

The BTC Vault establishes a repeatable pattern:

```
[Asset Vault]
  ├─ Accept deposit (cbBTC / wETH / wSUI / ...)
  ├─ Supply as collateral on Kamino
  ├─ Borrow USDC at target LTV
  ├─ Route USDC to USDC Vault (shared yield engine)
  ├─ Monitor health rate, staged deleverage
  └─ On withdrawal: reverse (unwind USDC Vault → repay → return asset)
```

| Asset | Solana Token | Kamino Availability | Priority |
|---|---|---|---|
| **BTC** | cbBTC | Main Market, Liq LTV 80% | **Phase 3 (next)** |
| ETH | wETH | TBD — verify market/LTV | Phase 4 |
| SUI | — | Not on Solana natively | Deferred (cross-chain required) |

## Implementation Scope

### Prerequisites
- [ ] Verify cbBTC Native APY 4.05% source (KMNO incentive vs. Coinbase native)
- [ ] Confirm cbBTC Max LTV (borrow cap) on Kamino Main Market
- [ ] Assess USDC borrow utilization and rate volatility
- [ ] Design USDC Vault "internal API" for programmatic deposit/withdraw

### Bot Changes
- [ ] `CollateralAllocator` — cbBTC deposit, USDC borrow, LTV management
- [ ] Health rate monitor with staged deleverage triggers
- [ ] cbBTC/BTC price oracle integration
- [ ] Emergency buffer management (20% lending-only reserve)
- [ ] USDC Vault integration as downstream yield destination

### Config
- [ ] `btcVault.targetLtv`: 0.55
- [ ] `btcVault.deleverageThresholds`: [1.30, 1.20, 1.10]
- [ ] `btcVault.emergencyBufferPct`: 0.20
- [ ] `btcVault.collateralToken`: "cbBTC"
- [ ] `btcVault.market`: Kamino Main Market address

## Phase

**Phase 3** — after USDC Vault (Phase 1) is fully stabilized and SOL Vault (Phase 2) design is finalized.
