# Dawn Labs Vault

Solana DeFi Vault — Multi-strategy yield optimization with dynamic allocation.

## Architecture

```
vault/
├── backtest/    # Strategy backtesting (Python)
├── bot/         # Manager Bot - rebalance & risk management (TypeScript)
├── frontend/    # Vault Dashboard UI (Next.js)
└── shared/      # Shared types & utilities
```

## Strategy Overview

Two-layer vault architecture:
- **Base Layer** — Always-on yield (lending/staking)
- **Aggressive Layer** — Conditional yield (delta-neutral / LST loop)

## Development

```bash
# Backtest
cd backtest && pip install -r requirements.txt

# Bot (TBD)
cd bot && npm install

# Frontend (TBD)
cd frontend && npm install
```

## Workflow

- Feature branches → PR → Code review → Merge to `main`
