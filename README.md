# Dawn Labs Vault

Solana DeFi Vault — Multi-strategy yield optimization with dynamic allocation.

> 日本語版は [README.ja.md](./README.ja.md) を参照

## Architecture

```
vault/
├── backtest/    # Strategy backtesting (Python)
├── bot/         # Manager Bot - rebalance & risk management (TypeScript)
└── frontend/    # Vault Dashboard UI (Next.js)
```

## Strategy Overview

Two-layer vault architecture:
- **Base Layer** — Always-on yield (lending / staking)
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
