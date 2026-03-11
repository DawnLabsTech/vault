# Risk Disclosures

Dawn Vault is an experimental DeFi product. All deposits are subject to risk. This page provides a comprehensive overview of the risks involved.

## Risk Categories

### 1. Smart Contract Risk

**Severity: Medium**

Dawn Vault interacts with multiple on-chain programs:

- **Voltr Vault Program**: Core deposit/withdrawal/accounting logic
- **Adapter Programs**: Connectors to Drift, Kamino, Jupiter
- **External Protocols**: Lending and trading protocols themselves

Any of these programs could contain bugs or vulnerabilities that result in loss of funds.

**Mitigations:**
- Voltr framework has been audited
- Adapter whitelisting limits protocol exposure
- Non-custodial PDA architecture reduces attack surface
- Assets can only flow through approved adapters

### 2. Funding Rate / Market Risk

**Severity: Medium**

The delta-neutral strategy depends on positive SOL funding rates. When funding rates turn negative:

- The strategy incurs costs instead of generating yield
- Rapid FR reversal may cause losses before positions are closed

**Mitigations:**
- Backtested entry/exit thresholds with 5.5 years of data
- Emergency exit at FR < -10% (no time delay)
- Gradual position reduction prevents sudden losses
- Base layer continues generating yield during FR downturns

### 3. Liquidation Risk

**Severity: Low (USDC Vault) / Medium (SOL & BTC Vaults)**

- **USDC Vault DN**: 1x leverage (margin = position size) — liquidation risk is effectively zero
- **SOL Vault LST Loop**: Leveraged positions can be liquidated if LTV thresholds are breached
- **BTC Vault**: Collateral LTV management required; BTC price drops increase liquidation risk

**Mitigations:**
- No leverage in DN strategy (USDC Vault)
- Conservative LTV targets (50% for BTC Vault vs. 90% liquidation threshold)
- 4-stage deleverage protocol for BTC Vault
- Continuous LTV monitoring with automated responses

### 4. Exchange / Counterparty Risk

**Severity: Medium**

The delta-neutral strategy uses centralized exchanges (Binance) for perpetual futures:

- Exchange insolvency or hack could result in loss of margin funds
- API outages could prevent position management
- Regulatory actions could freeze accounts

**Mitigations:**
- Position size limits relative to total vault assets
- Minimum required balance maintained on-chain
- Multi-venue strategy under consideration for future phases

### 5. Oracle Risk

**Severity: Low–Medium**

Price feeds from oracles (Pyth) may be delayed, manipulated, or stale:

- Incorrect prices could trigger unnecessary liquidations
- Oracle manipulation could enable exploits

**Mitigations:**
- Pyth push feeds with multi-source aggregation
- Staleness checks (>2 slots triggers pause)
- Price deviation monitoring (>5% triggers full halt)

### 6. Operational Risk

**Severity: Low–Medium**

The Manager Bot is a critical off-chain component:

- Bot crashes could leave positions unmanaged
- Network connectivity issues could prevent timely actions
- Human error in parameter configuration

**Mitigations:**
- 5-minute health check intervals with auto-retry (3 attempts)
- Bot redundancy planning
- Externalized configuration (no code changes for parameter updates)
- Emergency runbook with automated and manual procedures

### 7. Liquidity Risk

**Severity: Low**

- Large withdrawals may require unwinding positions, which takes time
- During market stress, liquidity across protocols may decrease

**Mitigations:**
- 30% minimum liquidity buffer maintained
- Redemption fee (0.1%) discourages short-term arbitrage
- Locked profit mechanism (Yearn V2-style) prevents sandwich attacks

### 8. Protocol / Composability Risk

**Severity: Low–Medium**

Dawn Vault composes multiple protocols. A failure in any one protocol could cascade:

- Lending protocol exploit → loss of deposited assets
- DEX exploit → loss during swaps
- LST depeg → collateral value decline

**Mitigations:**
- Protocol diversification across lending venues
- Adapter whitelisting limits exposure surface
- Automated withdrawal from compromised protocols
- Continuous on-chain monitoring for anomalies

### 9. Regulatory Risk

**Severity: Unknown**

DeFi regulations are evolving globally:

- Regulatory actions could restrict vault operations
- Token classification could change
- Geographic restrictions may apply

**Mitigations:**
- Legal review of operations
- Non-custodial architecture reduces regulatory exposure
- Compliance monitoring of regulatory developments

## Solana Network Risk

As a Solana-native product, Dawn Vault is subject to Solana network risks:

- **Network outages**: Extended downtime prevents all operations
- **Congestion**: High fees or failed transactions during peak usage
- **Consensus issues**: Potential forks or consensus failures

**Mitigations:**
- Conservative leverage ensures positions survive multi-hour outages
- Priority fee management for critical transactions
- Post-outage health check procedures

## Summary Risk Matrix

| Risk | USDC Vault | SOL Vault | BTC Vault |
|------|-----------|-----------|-----------|
| Smart Contract | Medium | Medium | Medium |
| Market / FR | Medium | Low | Medium |
| Liquidation | **Low** | Medium | **High** |
| Exchange | Medium | Low | Medium |
| Oracle | Low | Low–Med | Low–Med |
| Operational | Low–Med | Low–Med | Medium |
| Liquidity | Low | Low | Low–Med |
| Protocol | Low–Med | Low–Med | Medium |
| Regulatory | Unknown | Unknown | Unknown |

> **Please do not deposit more than you can afford to lose.** Past performance does not guarantee future results. See our [Disclaimer](../legal/disclaimer.md) for important legal information.
