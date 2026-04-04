# Dawn Labs Vault

Solana DeFi Vault - ベース層を主軸にした利回り最適化と条件付きアルファ

> English version: [README.md](./README.md)

## アーキテクチャ

```text
vault/
├── backtest/    # 戦略調査 / バックテストエンジン (TypeScript)
├── bot/         # 本番運用Bot (TypeScript)
└── frontend/    # 内部監視ダッシュボード (Next.js)
```

## 戦略概要

**設計思想:** 各 Vault は「**ベース層（常時稼働）＋ アルファ層（条件付き）**」の 2 層構造。ベース層が継続的な利回りと資本保全を担い、アルファ層は市場環境が十分良い時だけ追加リターンを狙う。

### 現在の運用モード（2026-04）

- **Base-first allocator:** デプロイ可能な USDC はまずアクティブな Kamino Multiply に入れる。Lending は Multiply の容量・健康度・リスク制約で追加できない資金の逃がし先兼、分散用スリーブとして使う。
- **DN は常時戦略ではない:** SOL デルタニュートラルは資金調達率が十分良い時だけ有効化する。今の市場では休止しているのが正常。
- **ランタイム閾値は config が正:** bot と backtest CLI はどちらも `bot/config/default.json` を基準にした現在値で揃える。

### Vault ラインナップ

| | USDC Vault | SOL Vault | BTC Vault |
|---|---|---|---|
| **ベース層** | Kamino Multiply（主力）+ USDC レンディング（補完） | 自社バリデータステーキング（6-7%） | cbBTC レンディング（1-3%） |
| **アルファ層** | SOL デルタニュートラル（条件付き） | LST Loop（10-20%） | cbBTC 担保 -> USDC 借入 -> SOL DN（実効 3.5-11%） |
| **切替頻度** | 日-週単位 | 月単位（手数料負け防止） | 週-月単位（LTV 管理含む） |
| **判断軸** | Multiply スプレッド + SOL ファンディングレート | LST 利回り - SOL 借入金利スプレッド | SOL FR + USDC 借入コスト + BTC 価格 |
| **フェーズ** | **Phase 1（稼働中）** | Phase 2 | Phase 3 |

### USDC Vault（Phase 1 - 稼働中）

オンチェーン + オフチェーンのハイブリッド構成。

**ベース層 - 資金配分**

現在の live bot は **Multiply-first / Lending-second** で動く。

- `CapitalAllocator` がデプロイ可能な USDC をまずアクティブな Kamino Multiply へ寄せる。
- `BaseAllocator` は Kamino / Jupiter の lending スリーブだけを管理し、overflow・分散・引き出しバッファを受け持つ。
- ウォレットの待機資金は `lending.bufferPct` で先に確保する。

**ベース層 - Kamino Multiply（主力）**

Kamino のレバレッジドステーブルコインループでネイティブ利回り + 借入リワードを獲得:

| プール | マーケット | 実効 APY | 備考 |
|---|---|---|---|
| ONyc/USDC（メイン） | RWA マーケット | ~16% @ 2.5x | ONyc ネイティブ利回り ~10.25%（Onre 経由） |
| USDG/PYUSD（バックアップ） | メインマーケット | ~9.5% @ 5.75x | ONyc/USDC 悪化時のフォールバック |

Market Scanner が候補プールの APY を継続監視し、24 時間移動平均の APY 優位が設定した payback window の中で推定 switch cost を回収でき、かつ行き先候補が live の risk gate を通る場合のみ切替を推奨する。Multiply Risk Scorer は 4 次元（depeg リスク、清算接近度、出口流動性、リザーブ圧力）を別軸のリスクとして評価する。Risk は表示 APY を減算せず、配分停止・縮小・撤退の明示的なしきい値制御に使う。

現在の live ポリシー:

- Score `>= 75` の候補市場は switch の行き先から除外する。
- アクティブな Multiply は Score `>= 75` で新規追加を止める。
- Score `75-89` は動的な `maxPositionCap` まで縮小する。
- Score `>= 90` は全撤退する。

**ベース層 - レンディング（補助）**

Kamino / Jupiter Lend での USDC レンディング（3-8%）は補助スリーブとして使う。Multiply に追加できない資金の受け皿であり、同時に単一プロトコル偏重を避けるための分散先でもある。Lending Risk Scorer が 5 次元（TVL・成熟度・利用率・集中度・インシデント）で APY ペナルティを調整する。

> **注意:** Drift は 2025 年のハッキングにより除外。コードは `@deprecated` 化済み。

**アルファ層 - SOL デルタニュートラル**

- USDC -> dawnSOL（オンチェーン、Jupiter）+ SOL-PERP ショート（Binance Futures）を並列実行
  - dawnSOL のステーキング報酬 ~7% がロングレグに自動上乗せ
  - レバレッジなし（1x 固定、perp 側の清算リスク実質ゼロ）
  - SOL ファンディングレートが十分プラスの時のみ稼働

| シグナル | 現在の live 設定 |
|---|---|
| DN エントリー | SOL FR の平均値が年率 `10%` 超で `3` 日継続 |
| DN イグジット | FR が年率 `0%` 未満の状態が `3` 日継続 |
| DN 緊急撤退 | 最新 FR が年率 `< -10%` |
| DN 配分上限 | NAV の `70%` まで。ただし `risk.maxPositionCapUsd` で上限をかける |

確認日数の定義:

- 「1日」は UTC 基準で、想定される 8 時間ごとの funding `3` 本がすべて揃った完全な 1 日を意味する。
- partial day は DN の entry / exit 確認日数にも、entry 判定で使う複数日平均にも含めない。
- 緊急撤退だけは最新の funding print をそのまま見て判定し、1日完了を待たない。

> **現在の状況（2026-04）:** SOL-PERP ファンディングレートはマイナスが継続中。DN は休止しているのが正常。正しい live posture は base-first で、Multiply を主力、Lending を補完、DN は資金調達率改善までゼロ配分。

**過去のバックテスト参照値（live config ではない）**

以前の 5.5 年 Walk-Forward Analysis では、よりきれいなシグナルとして次が出ていた。

- エントリー: FR `> 年率15%` が `2` 日継続
- イグジット: FR `< 年率-2%` が `1` 日継続
- DN 配分: `50%`
- 結果: 年率 `8.57%`、シャープレシオ `13.41`、最大ドローダウン `-0.07%`

これは研究上の参照値としては有用だが、**現在の本番パラメータではない**。

### 除外した戦略

| 戦略 | 理由 |
|---|---|
| Drift | ハッキングにより利用不可。コード `@deprecated` 化済み |
| USDC/USDT レバレッジループ | 借入金利高騰（Drift 影響）でスプレッドがマイナス |
| JLP / LP / Insurance Pools | 元本損失リスク - Vault の方針と不適合 |
| PRIME（Hastra Finance） | 実績不足で高リスク |
| CASH（Perena Finance） | 実績不足・TVL 極小で高リスク |
| ONyc/USDG | ONyc/USDC と APY 差 0.18% しかなく USDG の流動性リスクが大きい |

### 構造的アルファ: Validator-native Vault

- **dawnSOL 利回り上乗せ** - DN 戦略のロングレグにステーキング報酬 ~7% を自動蓄積
- **Yield Smoothing Reserve** - バリデータコミッション由来のリザーブで APY の谷を吸収（Phase 2）
- **Skin in the Game** - 自社資金も同条件で同じ戦略に投入
- **Japan Gateway** - Solana 上に日本語対応 Vault 不在の空白市場を開拓

## Bot コンポーネント

```text
bot/src/
├── core/
│   ├── orchestrator.ts    # メインループ: 状態評価 -> 配分 -> 実行 -> 計測
│   ├── fr-monitor.ts      # Binance SOL-PERP FR 取得・閾値判定
│   ├── state-machine.ts   # BASE_ONLY <-> BASE_DN の状態遷移制御
│   ├── market-scanner.ts  # Kamino Multiply プールの APY 比較・切替推奨
│   ├── multiply-risk-policy.ts  # アクティブな Multiply の縮小 / 撤退ルール
│   └── scheduler.ts       # Cron ベースのタスクスケジューリング
├── strategies/
│   ├── base-allocator.ts  # Lending スリーブ専用の配分エンジン
│   ├── capital-allocator.ts  # Base 資金配分: Multiply 優先、Lending は補完
│   └── dn-executor.ts     # デルタニュートラル開始 / 終了 / リバランス
├── risk/
│   ├── risk-manager.ts    # FR 急変・異常検知・即時撤退判断
│   ├── multiply-risk-scorer.ts  # Multiply プールの 4 次元リスクスコアリング
│   ├── lending-risk-scorer.ts   # レンディングプロトコルの 5 次元リスクスコアリング
│   ├── protocol-circuit-breaker.ts  # TVL 急落 / オラクル乖離 / 引出し失敗 -> 自動撤退
│   └── guardrails.ts      # キルスイッチ、SOL 残高チェック、価格鮮度検証
├── connectors/
│   ├── defi/              # Kamino (Multiply/Loop/Lending), Jupiter (Swap/Lend), Onre APY
│   ├── binance/           # REST + WebSocket クライアント（Futures）
│   └── solana/            # RPC、ウォレット、トークン操作
├── measurement/
│   ├── snapshots.ts       # ポートフォリオ状態スナップショット（SQLite）
│   ├── pnl.ts             # 日次 P&L 計算
│   ├── events.ts          # 台帳イベント記録
│   └── state-store.ts     # Bot 状態永続化（JSON）
└── utils/                 # ロガー、通知（Slack）、リトライ、tx 手数料
```

### リスク管理

| レイヤー | メカニズム | トリガー |
|---|---|---|
| **サーキットブレーカー** | レンディング層からの自動撤退 | TVL 急落(-20%/1h)、オラクル乖離、引出し失敗 |
| **Multiply リスクスコアラー** | 候補市場 / アクティブポジション用の別軸リスク評価 | 4 次元: depeg リスク、清算接近度、出口流動性、リザーブ圧力 |
| **Multiply リスクポリシー** | スコアしきい値ベースのリバランス | Score < 75 -> 通常運用、75-89 -> 新規追加停止 + `maxPositionCap` まで縮小、>= 90 -> 全撤退 / 緊急デレバレッジ |
| **Lending リスクスコアラー** | APY ペナルティ調整 | 5 次元: TVL、成熟度、利用率、集中度、インシデント |
| **プロトコル分散制約** | 単一プロトコルへの配分上限 60% | 補助レンディングスリーブの集中リスク抑制 |
| **Multiply Health デレバレッジ** | 段階的 Health Rate 保護 | HR < 1.20 -> 高頻度監視、< 1.10 -> ソフトデレバレッジ(20%)、< 1.05 -> 緊急全デレバレッジ |
| **DN Risk Manager** | FR 急変検知・自動撤退 | FR < 年率-10% -> 即時クローズ |
| **ガードレール** | キルスイッチ、SOL 残高、価格鮮度 | tx 手数料枯渇防止、古いデータでの誤判断防止 |

現在の Multiply Risk ルール:

- ONyc の depeg 判定は固定 `1.0` ではなく、reference / redemption に近い基準値を使う。
- Score `>= 75` の候補市場は market switch の行き先から除外する。
- アクティブな Multiply は Score `>= 75` で新規追加を止める。
- Score `75-89` は動的な `maxPositionCap` まで縮小する。
- Score `>= 90` は全撤退する。

## 調査メモ

### Hyperliquid SOL Perp（2026-03 調査、見送り）

DN 戦略のショートレグとして Hyperliquid SOL Perp の統合を検討。90 日分の FR データを Binance と比較した結果、閾値未達のため見送り。

| 期間 | Hyperliquid | Binance | 差分 |
|---|---|---|---|
| 7日平均 | -6.25% | -4.97% | -1.28% |
| 30日平均 | -9.47% | -6.96% | -2.51% |
| 90日平均 | -3.20% | -3.21% | +0.01% |

- 判定基準: 年率 5% 以上 -> Go / 未満 -> 見送り
- 結果: **NO-GO**（両取引所ともマイナス FR 環境、Hyperliquid に優位性なし）
- 検証スクリプト: `bot/scripts/compare-funding-rates.ts`
- 市場環境が変われば再検討の余地あり

### Kamino Multiply SDK（技術メモ）

`getDepositWithLeverageIxs` はトランザクションサイズ超過（flash loan + swap）でそのまま使えない。手動ループ方式（`deposit -> borrow -> swap -> re-deposit`）で対応。Jito bundle 対応は今後の改善課題。

## 開発

```bash
# Bot
cd bot && npm install

# バックテスト
cd backtest && npm install
npm run backtest -- --help

# フロントエンド（ローカル開発）
cd frontend && npm install
PORT=4001 npm run dev
```

## ワークフロー

- feature ブランチ -> PR -> コードレビュー -> `main` にマージ
