# Glossary

Key terms used throughout the Dawn Vault documentation.

| Term | Definition |
|------|-----------|
| **APY** | Annual Percentage Yield — the annualized return including compounding effects |
| **Base Layer** | The always-on yield strategy (lending or staking) that generates returns regardless of market conditions |
| **Alpha Layer** | The conditional yield strategy that activates only during favorable market conditions for enhanced returns |
| **cbBTC** | Coinbase Wrapped BTC — a BTC representation on Solana issued by Coinbase |
| **CPI** | Cross-Program Invocation — the mechanism by which Solana programs call other programs |
| **dawnSOL** | Dawn Labs' Liquid Staking Token (LST) — represents staked SOL with Dawn Labs' validator |
| **Delta-Neutral (DN)** | A strategy that holds equal and opposite positions (long spot + short perp) to eliminate directional price exposure while earning funding rates |
| **eMode** | Efficiency Mode — a lending protocol feature that allows higher LTV for correlated asset pairs (e.g., SOL/LST) |
| **Funding Rate (FR)** | Periodic payment between long and short traders in perpetual futures markets, used to keep perp prices aligned with spot |
| **High Water Mark (HWM)** | The highest-ever share price of a vault, used to ensure performance fees are only charged on new profits |
| **LP Token** | Liquidity Provider Token — represents a depositor's proportional share of a vault |
| **LST** | Liquid Staking Token — a token representing staked assets that can be used in DeFi while earning staking rewards |
| **LST Loop** | A leveraged staking strategy: stake SOL → receive LST → use as collateral → borrow SOL → restake → repeat |
| **LTV** | Loan-to-Value ratio — the ratio of borrowed amount to collateral value; higher LTV means higher liquidation risk |
| **Manager Bot** | The off-chain automated system that executes vault strategies, manages positions, and monitors risk |
| **PDA** | Program Derived Account — a Solana account owned by a program (not a private key), used for non-custodial asset custody |
| **Perp / Perpetual** | Perpetual futures — futures contracts with no expiry date, using funding rates to track spot prices |
| **Share Price** | The value of one LP token in terms of the vault's base asset (e.g., USDC). Increases as the vault earns yield |
| **Slippage** | The difference between expected and actual execution price of a trade |
| **TVL** | Total Value Locked — the total amount of assets deposited in a vault or protocol |
| **Voltr** | The vault framework by Ranger Finance on which Dawn Vault is built |
| **Yield Provenance** | The practice of decomposing and disclosing every source of vault yield |
| **Yield Smoothing Reserve (YSR)** | A reserve funded by validator commission that stabilizes vault APY during unfavorable market conditions |
