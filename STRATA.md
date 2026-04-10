# Strata

> Tranched yield vaults for institutions on Solana.

## 概要

**Strata** は Dawn Labs が Colosseum ハッカソン向けに構想する、機関投資家向けトランチ型 Yield Vault。

Driftハック（2025年）以降、DeFi Vault への「全損リスク」が機関投資家の参入障壁になっている。Strata はリスクを構造的に分離することでこの問題を正面から解決する。

名前の通り、**2つの層（Strata）** でリスクとリターンを分離する。

---

## 2つの層

### Risk Layer — Senior / Junior Tranche

| | Senior Vault | Junior Vault |
|---|---|---|
| リターン | 8% 固定（上限） | 残余全取り（変動・アップサイド大） |
| 損失順序 | 後回し（保護される） | 先に吸収（first-loss buffer） |
| 引き出し | 即時（waiting period = 0） | 7日ロック（waiting period = 7d） |
| 対象 | 機関投資家・ステーブル志向 | 高利回り志向・リスク許容層 |

**Accounting Waterfall（出口の優先順位）:**

```
Senior payout = user_senior_share × min(total_nav, senior_total_deposits)
Junior payout = user_junior_share × max(total_nav - senior_total_deposits, 0)
```

- 利益が出た場合：Senior に 8% 固定を先払い → 残余を Junior に分配
- 損失が出た場合：Junior NAV が先に削られる → Senior は最後まで保護

### Strategy Layer — Base / Alpha / DN

| | Base Layer | Alpha Layer | DN Layer |
|---|---|---|---|
| 戦略 | Kamino Lending | Kamino Multiply | SOL Delta-Neutral |
| 利回り | ~5-7%（安定） | ~14-16%（高め） | ~変動（funding rate依存） |
| 発動条件 | 常時（overflow） | 常時（primary） | SOL funding rate > 10% が3日継続 |
| リスク | 低 | 中（レバレッジあり） | 中（hedging） |

戦略の優先順位：Alpha（Multiply）に資金を集中 → 上限超過分を Base（Lending）に overflow。DN は条件付き発動。

---

## アーキテクチャ

```
[Dawn Senior Vault]     [Dawn Junior Vault]
        │                       │
        └───────────┬───────────┘
                    ▼
        Dawn Tranche Program（Anchor）
        ・NAV 追跡
        ・Waterfall 会計
        ・引き出し優先順位の制御
                    │ 全資金を一本化
                    ▼
        Ranger Vault（実行層）
        ├─ Kamino Multiply adaptor（Alpha Layer / primary）
        └─ Kamino Lending adaptor（Base Layer / overflow）
```

**技術スタック:**
- Anchor（Dawn Tranche Program）
- [Ranger Finance](https://docs.ranger.finance/)（Vault-as-a-Service インフラ）
  - `withdrawal_waiting_period` で Junior の 7日ロックをネイティブ実装
  - CPI integration: `request_withdraw_vault` / `withdraw_vault` / `instant_withdraw`
- Kamino Finance（Multiply + Lending adaptors）

---

## 先行事例・競合

### TradFi の先行事例
- **CDO / CLO**（伝統金融）: 住宅ローン・レバレッジドローンをトランチ分け。AAA（Senior）→ Equity（Junior）。Strata は CLO のオンチェーン版に相当
- **不動産ファンドの優先劣後構造**（日本含む）: 優先出資（元本保護）/ 劣後出資（損失先吸収・アップサイド大）。同一構造

### Crypto の先行事例
- **Barnbridge**（Ethereum、2021）: SMART Yield で Compound 等の利回りをSenior/Juniorに分離。$178M TVL → 低金利環境で固定Senior利率を維持できず失敗
- **Saffron Finance**（Ethereum、同時期）: 同様の構造。同じ理由で衰退

### Solana 上の直接競合
- **Kormos**（`kormos`、Cypherpunk 2025年9月、DeFi 2位、C4アクセラレーター採択）
  - 構造：Liquid depositor（Junior的）/ Locked depositor（Senior的）
  - 利回り源泉：Lending + PT資産（fractional reserve banking モデル）
  - ナラティブ：「銀行の部分準備制度を DeFi で」
  - 差異：利回り最大化 → DeFiネイティブ向け。機関投資家・全損リスク排除は明示していない

### Strata の差別化
Kormos が「Solana 上でトランチが成立することを証明した」先行事例である一方、Strata は：
1. **ナラティブ**：Drift ハック後の「全損リスク忌避」という具体的な痛点に応答
2. **ターゲット**：機関投資家（Senior）が主たる顧客。稟議が通る構造設計
3. **利回り源泉**：Kamino Multiply（~16%）という高い原資があって初めてSenior 8%固定が成立
4. **実運用バックグラウンド**：Dawn Labs 自身が Phase 1 Vault を稼働させており、戦略・リスク管理の実績あり

---

## なぜ今なのか

- **Drift ハック（2025年）**: 多くの機関投資家が DeFi Vault からの資金引き上げ、または新規参入を停止
- **痛点**: "全損リスクがある以上、稟議が通らない"
- **Strata の回答**: Junior が first-loss buffer を担う構造により、Senior LP は部分的損失から保護される
- **Solana 上に CLO（Collateralized Loan Obligation）的な構造を初めて実用実装する**

---

## Junior Bootstrap

初期の Junior 資金は **Dawn Labs 自身が張る**。

- Dawn Labs が first-loss を取ることで Senior LP に対して「皮膚感覚のある」コミットを示す
- 実績が積み上がれば高利回り目的の外部 Junior LP を誘引可能
- ハッカソンデモ段階では Dawn Labs 資金で完結

---

## $1M ARR への道筋

手数料体系（既存 Vault と共通）:
- Performance Fee: 20%（High Water Mark）
- Management Fee: 1% / 年
- Withdrawal Fee: 0.1%

```
$10M Senior AUM × 8% yield × 20% perf fee = $160K/年
$5M Junior AUM  × 20% yield × 20% perf fee = $200K/年
→ 合計 ~$360K/年 @ $15M AUM

$1M ARR 達成には ~$40-50M AUM が必要
```

機関クライアントへの Senior Vault 提案（既存パイプライン: Mobcast, Pacific Meta, KEY3 等）から積み上げる。

---

## キャッチフレーズ

**"Stop losing sleep over hacks. Take the Senior tranche."**

---

## 残課題

- [ ] Anchor program の詳細設計（NAV 計算のオンチェーン化度合い）
- [ ] Ranger Vault Owner 登録・adaptor 設定の具体的手順確認
- [ ] Junior の外部募集タイミング・条件設計
- [ ] ピッチ資料作成
