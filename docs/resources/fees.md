# Fees

Dawn Vault charges fees to sustain operations and align incentives. Our fee structure is designed to be **competitive, transparent, and aligned with depositor outcomes**.

## Fee Schedule

| Fee | Rate | Description |
|-----|------|-------------|
| **Performance Fee** | 20% | Charged on profits above the High Water Mark |
| **Management Fee** | 1% per year | Annual fee on total assets under management |
| **Issuance Fee** | 0% | No fee on deposits |
| **Redemption Fee** | 0.1% | Small fee on withdrawals |

## Performance Fee (20%)

The performance fee is only charged on **new profits** — measured using a High Water Mark (HWM) system.

### How HWM Works

```
Share Price History:

$1.00 → $1.10 → $1.05 → $1.15
       ↑ Fee      No fee  ↑ Fee
       (on $0.10)         (only on $0.05,
                           i.e. $1.15-$1.10)
```

- The HWM tracks the highest-ever share price
- Performance fee is only charged when share price **exceeds** the previous HWM
- If the vault loses money and recovers, no fee is charged until the previous high is surpassed
- This ensures you never pay performance fees on recovering from losses

### Fee Calculation

Performance fees are calculated using an **LP token dilution model**:

1. When share price exceeds HWM, the fee amount is calculated
2. Virtual LP tokens are minted to represent the fee
3. These LP tokens are distributed to Manager, Admin, and Protocol recipients
4. Depositor share prices reflect fees automatically — no explicit deduction

### Fee Harvest

Accumulated fees are periodically harvested via the `harvestFee` instruction, which mints the accumulated virtual LP tokens and distributes them.

## Management Fee (1%)

A 1% annual fee on total vault assets, calculated continuously based on elapsed time.

| Competitor | Management Fee |
|-----------|---------------|
| Vectis Finance | 2% |
| Elemental | 0% |
| **Dawn Vault** | **1%** |

Our 1% management fee positions us competitively — lower than Vectis while covering operational costs that Elemental offsets through other mechanisms.

## Issuance Fee (0%)

No fee is charged on deposits. We want to minimize barriers to entry and accelerate TVL growth.

## Redemption Fee (0.1%)

A minimal 0.1% fee on withdrawals serves two purposes:

1. **Anti-arbitrage**: Prevents depositors from exploiting short-term yield spikes
2. **Anti-sandwich**: Makes sandwich attacks economically unviable

## Locked Profit Mechanism

In addition to fees, the vault implements **Locked Profit** (Yearn V2 model):

- Profits are locked and released linearly over a configurable duration
- This prevents frontrunning: you can't deposit right before a profit event and withdraw immediately after
- The mechanism protects long-term depositors from value extraction by short-term traders

## Validator Commission

For the SOL Vault (Phase 2), Dawn Labs earns validator commission as an additional revenue stream. This commission is a natural part of validator operations and **does not reduce depositor yield** — it is an independent income source that also funds the [Yield Smoothing Reserve](../transparency/yield-smoothing-reserve.md).

## Fee Transparency

All fee parameters are set on-chain and visible to anyone:
- Performance fee rate
- Management fee rate
- Current HWM value
- Accumulated unharvested fees
