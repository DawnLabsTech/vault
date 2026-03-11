# Roadmap

Dawn Vault is being developed in three phases, with each phase building on the operational experience and infrastructure of the previous one.

## Phase 1: USDC Vault (Current)

**Status: Live**

The flagship vault establishing Dawn Vault's core infrastructure and track record.

### Deliverables
- USDC Vault with two-layer architecture (lending + delta-neutral)
- Manager Bot for automated strategy execution
- Risk management system with backtested parameters
- Performance dashboard
- Yield provenance reporting

### Strategy
- **Base Layer**: USDC lending across Kamino, Drift, Jupiter Lend (3–8% APY)
- **Alpha Layer**: SOL delta-neutral with dawnSOL enhancement (15–30% APY)
- **Target APY**: 8–15%+

### Milestones
- [x] Strategy backtest (5.5 years, Sharpe Ratio 13.41)
- [x] Manager Bot development
- [x] Live deployment with own capital
- [ ] Public deposits
- [ ] Performance reporting system
- [ ] Documentation site (you're reading it!)

---

## Phase 2: SOL Vault

**Status: In Development**

Expanding to SOL deposits with validator-native staking strategies.

### Deliverables
- SOL Vault with staking + LST loop strategy
- dawnSOL LST integration
- Jupiter Native Stake integration
- Enhanced risk management for leveraged positions

### Strategy
- **Base Layer**: Dawn validator staking (6–7% APY)
- **Alpha Layer**: LST Loop via dawnSOL × Kamino or Jupiter Native Stake (10–20% APY)

### Key Challenges
- LST loop requires careful LTV management (tight liquidation buffers)
- Monthly rebalancing cycles (swap cost sensitivity)
- Two implementation paths to evaluate (Kamino vs. Jupiter)

---

## Phase 3: BTC Vault

**Status: Planning**

The most complex vault, unlocking SOL yield from BTC collateral.

### Deliverables
- BTC Vault with cbBTC lending + multi-hop delta-neutral
- 4-stage collateral deleverage protocol
- Multi-variable decision engine (SOL FR + USDC borrow cost + BTC price)

### Strategy
- **Base Layer**: cbBTC lending (1–3% APY)
- **Alpha Layer**: cbBTC collateral → USDC borrow → SOL DN (3.5–11% effective APY)

### Key Challenges
- Highest operational complexity (multi-hop + collateral management)
- Two independent decision variables plus BTC price monitoring
- Requires proven operational excellence from Phase 1 and 2

---

## Future Considerations

Beyond the three core vaults, Dawn Labs is exploring:

- **JPY stablecoin integration** for Japanese market access
- **Multi-venue CEX support** to reduce single-exchange risk
- **On-chain attestation** of off-chain positions
- **Governance token** considerations
- **Additional strategy modules** as market opportunities emerge

---

*Timelines are indicative and subject to change based on market conditions and development progress.*
