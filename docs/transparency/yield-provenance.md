# Yield Provenance

Dawn Vault fully decomposes and discloses the source of every basis point of yield. We believe depositors deserve to know exactly **where their returns come from**.

## Why It Matters

Many DeFi yield products advertise an APY number without explaining its composition. This creates two problems:

1. **Depositors can't assess sustainability** — Is 15% APY coming from a reliable source or a temporary incentive?
2. **Risk is hidden** — Different yield sources carry different risks

Dawn Vault solves this with **Yield Provenance** — a full breakdown of APY by source.

## USDC Vault Yield Decomposition

| Component | Source | Typical Range | Risk Level |
|-----------|--------|---------------|------------|
| **Lending Yield** | Interest from USDC lending (Kamino, Drift, Jupiter) | 3–8% | Low |
| **Funding Rate PnL** | Net payments received from SOL-PERP shorts | 8–23% | Medium |
| **Staking Yield** | dawnSOL staking rewards on spot leg | ~7% | Low |
| **Borrowing Cost** | Interest paid on borrowed assets (if applicable) | -(0–3%) | N/A |
| **Execution Cost** | Swap slippage, gas fees, position entry/exit costs | -(0.1–0.5%) | N/A |
| **= Net Vault APY** | Sum of all components | **8–30%+** | — |

## Example Breakdown

During a typical high-FR period:

```
Lending Yield:      +5.2%   (Kamino USDC @ best rate)
Funding Rate PnL:  +18.4%   (SOL FR collection, net of costs)
Staking Yield:      +7.1%   (dawnSOL on 50% allocation)
Execution Cost:     -0.3%   (swaps, gas)
─────────────────────────
Net Vault APY:     +30.4%
```

During a low/negative FR period (lending only):

```
Lending Yield:      +6.1%   (Kamino USDC)
Funding Rate PnL:   +0.0%   (DN strategy inactive)
Staking Yield:      +0.0%   (no SOL position)
Execution Cost:     -0.0%   (minimal rebalancing)
─────────────────────────
Net Vault APY:      +6.1%
```

## How We Report

Every epoch, the following data is published:

- APY breakdown by source (table above)
- Current allocation split (Base vs. Alpha)
- Hedge ratio (spot vs. short notional)
- Yield Smoothing Reserve balance
- Cumulative performance since inception

See [Proof-Based Reporting](proof-based-reporting.md) for the full disclosure framework.

## Commitment

> We will never report a blended APY number without providing its full decomposition. If we can't explain where yield comes from, we won't offer it.
