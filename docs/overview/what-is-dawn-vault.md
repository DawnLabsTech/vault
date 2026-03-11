# What is Dawn Vault?

Dawn Vault is a **validator-native yield vault** on Solana — designed, built, and operated by [Dawn Labs](https://dawnlabs.xyz), an active Solana validator operator.

## The Concept

Most DeFi yield vaults are built by teams that sit on top of protocols as users. Dawn Vault is different: it is built by infrastructure operators who run Solana's consensus layer. This means our yield strategies start at the infrastructure level and extend into DeFi — not the other way around.

```
Traditional Vault:    DeFi Protocols → Yield
Dawn Vault:           Validator Infrastructure → DeFi Protocols → Yield
```

## What Makes It Validator-Native?

**Validator revenue as a structural advantage.** Because Dawn Labs operates a Solana validator, we have access to a unique revenue stream — validator commission — that serves dual purposes:

- **Offense**: Enhanced yield through our custom LST (dawnSOL), which adds ~7% staking rewards on top of delta-neutral strategy returns
- **Defense**: A Yield Smoothing Reserve funded by validator commission that stabilizes APY during unfavorable market conditions

This **infrastructure-level alpha** is the structural advantage that sets Dawn Vault apart from pure DeFi aggregators.

## Key Features

| Feature | Description |
|---------|-------------|
| **Two-Layer Architecture** | Base layer (always-on lending) + Alpha layer (conditional strategies) ensures yield never drops to zero |
| **Dynamic Allocation** | Automated switching between strategies based on market conditions (e.g., funding rates) |
| **Yield Provenance** | Full decomposition and disclosure of APY sources (staking, lending, funding PnL, costs) |
| **Non-Custodial** | All assets held in on-chain PDA accounts with permission separation |
| **Skin in the Game** | Dawn Labs' own capital is deployed under the same conditions as depositors |
| **Capacity Management** | TVL caps to prevent alpha dilution — quality over quantity |

## Vault Lineup

Dawn Vault offers multiple vaults, each designed for a specific asset:

- **[USDC Vault](../vaults/usdc-vault.md)** (Phase 1 — Live): USDC lending + SOL delta-neutral strategy
- **[SOL Vault](../vaults/sol-vault.md)** (Phase 2 — Coming Soon): Validator staking + LST loop strategy
- **[BTC Vault](../vaults/btc-vault.md)** (Phase 3 — Coming Soon): cbBTC lending + collateralized delta-neutral

## Built on Proven Infrastructure

Dawn Vault is built on the **Voltr** vault framework (by Ranger Finance), leveraging battle-tested smart contracts for deposit/withdrawal, LP token accounting, and fee management. Strategy execution connects to leading Solana protocols including Drift, Kamino, and Jupiter.
