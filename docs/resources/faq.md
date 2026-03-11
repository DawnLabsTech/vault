# FAQ

## General

### What is Dawn Vault?

Dawn Vault is a yield-generating vault on Solana built by Dawn Labs, an active Solana validator operator. It combines lending aggregation with delta-neutral strategies to deliver optimized, risk-adjusted returns.

### What makes Dawn Vault different from other yield vaults?

Three things: (1) **Validator-native alpha** — our custom LST (dawnSOL) adds staking rewards on top of strategy returns; (2) **Full transparency** — we decompose and disclose every source of yield; (3) **Yield Smoothing Reserve** — validator commission revenue stabilizes returns during market downturns.

### Is Dawn Vault custodial?

No. All assets are held in on-chain PDA (Program Derived Account) accounts controlled by the Vault Program smart contract. No individual or multisig can arbitrarily withdraw depositor funds.

### Who operates Dawn Vault?

Dawn Labs, a Solana validator operator based in Japan. We run validator infrastructure and operate the vault strategy with our own capital alongside depositors.

## Yield

### Where does the yield come from?

Yield comes from multiple verifiable sources:
- **Lending interest** — USDC lent to protocols like Kamino, Drift, Jupiter
- **Funding rate payments** — Collected from the SOL-PERP perpetual futures market
- **Staking rewards** — Earned on dawnSOL (~7% APY)

See [Yield Provenance](../transparency/yield-provenance.md) for full details.

### What APY can I expect?

The USDC Vault targets 8–15%+ APY depending on market conditions. During periods of high SOL funding rates, APY can reach 25–30%. During low/negative FR periods, APY falls to the lending base rate (3–8%).

### Is the APY guaranteed?

No. APY depends on market conditions (funding rates, lending rates) and is variable. Past performance does not guarantee future results. The Yield Smoothing Reserve helps stabilize returns but does not guarantee any minimum APY.

### How is yield distributed?

Yield auto-compounds into the vault. There is no claiming or harvesting step. Your LP token share price increases as the vault earns yield. When you withdraw, you receive your original deposit plus accumulated yield.

## Deposits & Withdrawals

### What assets can I deposit?

Currently, only **USDC** (SPL token on Solana) is supported. SOL and BTC vaults are planned for future phases.

### Is there a minimum deposit?

Check the vault page for current minimum deposit requirements.

### Is there a lock-up period?

No. You can withdraw at any time.

### Are there any fees?

| Fee | Amount |
|-----|--------|
| Performance Fee | 20% of profits (HWM-based) |
| Management Fee | 1% annually |
| Deposit Fee | 0% |
| Withdrawal Fee | 0.1% |

See [Fees](fees.md) for detailed information.

### How long does withdrawal take?

Standard withdrawals are processed immediately on-chain. Large withdrawals may take additional time if positions need to be unwound.

## Risk

### Can I lose money?

Yes. While the strategies are designed to minimize risk, loss of funds is possible due to smart contract bugs, market events, or other factors described in our [Risk Disclosures](../security/risk-disclosures.md).

### How is the delta-neutral strategy risk managed?

- **No leverage**: 1x position sizing (margin = position size)
- **Automated exit**: Backtested thresholds trigger position closure when funding rates deteriorate
- **Emergency exit**: Immediate closure at extreme negative funding rates
- **Base layer fallback**: Lending yield continues even when DN is inactive

### What happens during a Solana network outage?

Conservative leverage and position sizing ensure positions can survive multi-hour network outages without liquidation risk. After network recovery, automated health checks verify all positions.

### Is the smart contract audited?

The underlying Voltr framework has been audited. Dawn Vault's specific deployment and adapter configurations undergo security review. A dedicated third-party audit is planned.
