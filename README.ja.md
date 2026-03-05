# Dawn Labs Vault

Solana DeFi Vault — マルチ戦略による利回り最適化と動的配分

> English version: [README.md](./README.md)

## アーキテクチャ

```
vault/
├── backtest/    # 戦略バックテスト (Python)
├── bot/         # Manager Bot - リバランス・リスク管理 (TypeScript)
└── frontend/    # Vault ダッシュボード UI (Next.js)
```

## 戦略概要

2層構造のVaultアーキテクチャ:
- **ベース層** — 常時稼働の利回り（レンディング / ステーキング）
- **攻め層** — 条件付き利回り（デルタニュートラル / LST Loop）

## 開発

```bash
# バックテスト
cd backtest && pip install -r requirements.txt

# Bot (TBD)
cd bot && npm install

# Frontend (TBD)
cd frontend && npm install
```

## ワークフロー

- featureブランチ → PR → コードレビュー → `main` にマージ
