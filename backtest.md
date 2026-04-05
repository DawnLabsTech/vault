# Backtest Results

実行日: 2026-04-05
データ期間: 2024-01-01 ~ 2026-04-01 (821日, Binance SOL-PERP FR + 8h OHLCV)

## 現行戦略 (Multiply優先 + Lending溢れ + 条件付きDN)

デフォルトパラメータ: Multiply APY=13%, 容量制限なし, Lending APY=5%, dawnSOL APY=6.8%, DN配分=70%, FR Entry=10%, Exit=0%, Emergency=-10%, 確認日数=3日

```
╔══════════════════════════════════════════════╗
║          BACKTEST RESULTS                    ║
╠══════════════════════════════════════════════╣
║ Period                     2024-01-01 → 2026-04-01 ║
║ Initial Capital                      $10,000 ║
║ Final NAV                          $13,439.01 ║
║ APY                                   14.04% ║
║ Sharpe Ratio                          27.007 ║
║ Max Drawdown                           0.23% ║
╠──────────────────────────────────────────────╣
║ Days in BASE_ONLY                        584 ║
║ Days in BASE_DN                          237 ║
║ DN Entries                                 3 ║
║ DN Exits                                   3 ║
╠──────────────────────────────────────────────╣
║ Benchmark: SOL Buy&Hold (APY)         -8.60% ║
║ Benchmark: Multiply Only (APY)        13.00% ║
║ Benchmark: Lending Only (APY)          5.00% ║
╚══════════════════════════════════════════════╝
```

### DN期間詳細

| # | 期間 | 日数 | 平均FR(年率) |
|---|---|---:|---:|
| 1 | 2024-01-03 ~ 2024-07-05 | 185日 | 18.4% |
| 2 | 2024-11-11 ~ 2024-12-20 | 40日 | 20.0% |
| 3 | 2025-07-22 ~ 2025-08-02 | 12日 | 6.4% |
| **合計** | | **237日 (28.9%)** | **18.0%** |

### FR Entry閾値の感度分析

| 指標 | Entry 5% | Entry 10% (現行) | Entry 15% |
|---|---:|---:|---:|
| APY | 12.91% | 14.04% | 14.19% |
| DN稼働日数 | 372日 (45%) | 237日 (29%) | 222日 (27%) |
| DN Entry回数 | 8回 | 3回 | 2回 |
| Sharpe | 21.7 | 27.0 | 28.0 |

- Entry 5%: FR < 13%の低FR期間にもDNに入り、Multiply 13%より低いリターンで資金を使うため悪化
- Entry 15%: 短期の低FR エントリー（3回目、12日間）がフィルタされ微改善。ただし差は+0.15pp
- **現行の10%がバランス良い**

## パラメータ

```
initialCapital: $10,000
multiplyApy: 13%
multiplyCapacity: unlimited
lendingApy: 5%
dawnsolApy: 6.8%
frEntryAnnualized: 10%
frExitAnnualized: 0%
frEmergencyAnnualized: -10%
confirmDays: 3
dnAllocation: 70%
```

## 課題

### 1. Multiply/Lending APYが固定値

最大の制約。Multiply 13%、Lending 5%を全期間一定として扱っている。実際は市場環境により大きく変動する（Multiply: 8-20%、Lending: 2-8%）。これにより:

- **Sharpe Ratioが過大評価される。** 固定APYではボラティリティが手数料イベントのみとなり、実際のAPY変動リスクが反映されない
- **Max Drawdownが過小評価される。** Multiply APY急落やdepegによるドローダウンがモデル化されていない
- **DN層の相対価値が見えにくい。** Multiply APYが低下した局面でDNの価値が上がるが、固定前提ではその柔軟性を評価できない

改善案: Kamino/Jupiter APIから過去APYの時系列データを取得し、tick毎に変動APYを適用する

### 2. Multiplyのリスクが未モデル化

- **Depegリスク:** ONycがUSDCから乖離した場合のNAV損失がない
- **流動性リスク:** 急な引き出しが必要な局面でのスリッページ未反映
- **清算リスク:** Health Rate低下によるデレバレッジコストがない
- **プール容量:** 無制限前提だが、実際はTVLに依存

これらが入ると Max Drawdown は現在の0.23%よりかなり大きくなる可能性がある

### 3. データ期間が短い（2年強）

2024-01-01以降のデータしかなく、異なる市場サイクル（ベアマーケット、低ボラティリティ期）での検証ができていない。FRデータ自体はBinanceから2021年まで取得可能だが、Kamino Multiplyは2024年以降のプロダクトであり、長期バックテストではMultiply APYの仮定が強くなる

### 4. DN遷移が即時

実運用ではDN Entry/Exitに複数ステップ（Lending引き出し→CEX送金→ポジション構築）で数分〜数十分かかる。バックテストでは即時遷移としており、遷移中の価格変動リスクが反映されていない

### 5. 手数料モデルが静的

- Swap slippageは固定0.1%だが、実際はプール流動性と取引サイズに依存
- Binance手数料はティアにより変動（VIPレベルで0.02%まで低下可能）
- Solana gas（priority fee）は混雑時に大幅上昇する

### 6. FRだけが実データ

唯一の実データであるFRがDN Entry/Exitの判断と収益の両方に使われているため、バックテストの説得力はFRモデリングの正確性に依存している。一方でベースレイヤー（Multiply/Lending）は固定値であり、ポートフォリオ全体としてはシミュレーションの精度にばらつきがある
