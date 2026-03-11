# Proof-Based Reporting

Dawn Vault publishes structured performance reports at regular intervals, providing verifiable evidence of vault operations and returns.

## Reporting Framework

### What We Report

| Data Point | Frequency | Verification |
|-----------|-----------|-------------|
| **Yield Breakdown** (by source) | Every epoch | On-chain transaction data |
| **Hedge Ratio** (spot vs. short) | Every epoch | On-chain + CEX position data |
| **Allocation Split** (base vs. alpha) | Every epoch | On-chain vault state |
| **Reserve Balance** | Every epoch | On-chain account balance |
| **Share Price** | Continuous | On-chain LP token accounting |
| **Cumulative PnL** | Daily | Dashboard + historical data |
| **Drawdown Metrics** | Daily | Calculated from share price history |

### Report Structure

Each epoch report includes:

1. **Performance Summary**: Net APY, gross yield, costs deducted
2. **Yield Provenance Table**: Breakdown by source with actual values
3. **Position Summary**: Current allocations, hedge ratios, protocol exposure
4. **Risk Metrics**: Maximum drawdown, Sharpe ratio (rolling), volatility
5. **Reserve Status**: Yield Smoothing Reserve balance and utilization
6. **Operational Notes**: Any strategy changes, rebalancing events, or incidents

## Skin in the Game

Dawn Labs deploys its own capital under the **exact same conditions** as depositors:

- Same vault, same strategy, same fee structure
- No preferential treatment or separate accounts
- Our returns are directly tied to depositor outcomes

This alignment of interests is the strongest form of trust — we succeed or fail together.

## Verification

Depositors can independently verify:

- **Share price**: Query the on-chain vault program directly
- **LP token balance**: Check their wallet
- **Vault TVL**: On-chain total assets visible to anyone
- **Protocol positions**: On-chain adapter positions are public

## Future Enhancements

- Automated report generation and publication
- On-chain attestation of off-chain positions (CEX)
- Third-party audit of reported vs. actual performance
