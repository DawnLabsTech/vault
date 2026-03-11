# Capacity Management

Dawn Vault implements TVL (Total Value Locked) caps to protect depositor returns. We prioritize **quality of yield over quantity of AUM**.

## Why Cap TVL?

Alpha strategies have limited capacity. As more capital chases the same opportunity:

- Funding rate impact increases (our short positions move the market)
- Lending rate impact increases (our deposits push rates down)
- Slippage on entry/exit grows
- Net yield per dollar decreases

Without caps, a vault's advertised APY degrades as TVL grows — early depositors suffer as late capital dilutes returns.

## Our Approach

| Mechanism | Description |
|-----------|-------------|
| **Hard Cap** | Maximum TVL enforced at the smart contract level; deposits rejected above cap |
| **Soft Cap** | Warning threshold; new deposits accepted but monitored for yield impact |
| **Dynamic Adjustment** | Caps are adjusted based on market liquidity and strategy capacity |
| **Waitlist** | When caps are reached, new depositors can join a waitlist for future capacity |

## Cap Sizing Methodology

TVL caps are set based on:

1. **Market depth** of target funding rate instruments
2. **Lending pool liquidity** across protocols
3. **Observed yield degradation** at various TVL levels
4. **Position entry/exit slippage** modeling

## Transparency

Current TVL and cap status are displayed on the vault dashboard. When a vault approaches its cap:

- Dashboard shows remaining capacity
- Depositors are notified of cap proximity
- Cap increases are announced in advance when justified by market conditions

## Quality Over Quantity

> We would rather run a $5M vault at 15% APY than a $50M vault at 6% APY. Our fee revenue is optimized by delivering superior risk-adjusted returns, not by maximizing AUM.

This philosophy aligns our incentives with depositors — we only grow when we can maintain performance quality.
