# Dawn Labs Vault

Solana DeFi Vault — マルチ戦略による利回り最適化と動的配分

> English version: [README.md](./README.md)

## アーキテクチャ

```
vault/
├── backtest/    # 戦略バックテスト (Python)
├── bot/         # 戦略実行Bot (TypeScript)
└── frontend/    # 内部監視ダッシュボード
```

## 戦略概要

**設計思想:** 各Vaultは「**ベース層（常時稼働）＋ 攻め層（条件付き）**」の2層構造。ベース層で利回りゼロにならず、市場環境が良い時だけ攻め層でAPYを上乗せする。

### Vaultラインナップ

| | USDC Vault | SOL Vault | BTC Vault |
|---|---|---|---|
| **ベース層** | USDCレンディング（3〜8%） | 自社バリデータステーキング（6〜7%） | cbBTCレンディング（1〜3%） |
| **攻め層** | SOLデルタニュートラル（15〜30%） | LST Loop（10〜20%） | cbBTC担保→USDC借入→SOL DN（実効3.5〜11%） |
| **切替頻度** | 日〜週単位 | 月単位（手数料負け防止） | 週〜月単位（LTV管理含む） |
| **判断軸** | SOLファンディングレート | LST利回り − SOL借入金利スプレッド | SOL FR + USDC借入コスト + BTC価格 |
| **運用難度** | 中 | 中〜高 | 最も高い |
| **フェーズ** | **Phase 1（ハッカソンMVP）** | Phase 2 | Phase 3 |

### USDC Vault（Phase 1 — ハッカソンMVP）

オンチェーン＋オフチェーンのハイブリッド構成:

- **ベース層:** Kamino / Drift / Jupiter LendでUSDCレンディング（APY最高のプールを自動選択）
- **攻め層:** デルタニュートラル — USDC → dawnSOL（オンチェーン、Jupiter）+ SOL-PERPショート（Binance Futures）を並列実行
  - dawnSOLのステーキング報酬〜7%がロングレグに自動上乗せ
  - レバレッジなし（1x固定、perp側の清算リスク実質ゼロ）
  - SOLファンディングレートが十分プラスの時のみ稼働

**配分ロジック:**

| 市場状況 | レンディング | デルタニュートラル | 判断基準 |
|---|---|---|---|
| FR高水準 | 30〜50% | 50〜70% | SOL FR > 閾値が一定期間継続 |
| FR中立 | 70〜80% | 20〜30% | 既存ポジション維持 |
| FR逆転 | 100% | 0%（段階的撤退） | FR < 0が一定期間継続でクローズ |

### 構造的アルファ: Validator-native Vault

- **dawnSOL利回り上乗せ** — DN戦略のロングレグにステーキング報酬〜7%を自動蓄積
- **Yield Smoothing Reserve** — バリデータコミッション由来のリザーブでAPYの谷を吸収
- **Skin in the Game** — 自社資金も同条件で同じ戦略に投入
- **Japan Gateway** — Solana上に日本語対応Vault不在の空白市場を開拓

## Botコンポーネント

| コンポーネント | 役割 |
|---|---|
| FR Monitor | Binance SOL-PERP FR取得・閾値判定 |
| State Machine | BASE_ONLY ⇔ BASE+DN の状態遷移制御 |
| Lending Aggregator | Kamino / Drift / Jupiter Lend間のAPY比較・最適プール自動選択 |
| dawnSOL Swap | USDC ⇔ dawnSOLスワップ（Jupiter API） |
| Binance Executor | SOL-PERPショート開閉・マージン管理 |
| Risk Manager | FR急変・異常検知・即時撤退判断 |

## 調査メモ

### Hyperliquid SOL Perp（2026-03 調査、見送り）

DN戦略のショートレグとしてHyperliquid SOL Perpの統合を検討。90日分のFRデータをBinanceと比較した結果、閾値未達のため見送り。

| 期間 | Hyperliquid | Binance | 差分 |
|---|---|---|---|
| 7日平均 | -6.25% | -4.97% | -1.28% |
| 30日平均 | -9.47% | -6.96% | -2.51% |
| 90日平均 | -3.20% | -3.21% | +0.01% |

- 判定基準: 年率5%以上 → Go / 未満 → 見送り
- 結果: **NO-GO**（両取引所ともマイナスFR環境、Hyperliquidに優位性なし）
- 検証スクリプト: `bot/scripts/compare-funding-rates.ts`
- 市場環境が変われば再検討の余地あり

## 開発

```bash
# Bot
cd bot && npm install

# バックテスト
cd backtest && pip install -r requirements.txt
```

## ワークフロー

- featureブランチ → PR → コードレビュー → `main` にマージ
