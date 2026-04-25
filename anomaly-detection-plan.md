# Protocol Anomaly Detection — 実装計画

## 目的

Emergency Response の **A1 Protocol Anomaly Detection** を自前で実装し、Hypernative / Forta などの外部 security feed を導入するまでの bridging とする。
A3 Circuit Breaker (TVL crash / oracle deviation) は「結果」を見るのに対し、A1 は **異常の事前シグナル** (admin key 差し替え、大口流出の進行中、市場パラメータ変更) を取るのが目的。

## 監視対象と期待シグナル

| シグナル | 監視対象 | 重大度 | 期待アクション |
|---|---|---|---|
| Upgrade authority 変更 | Kamino Lending program / Jupiter Lend program (BPF Loader 上の ProgramData account の `upgrade_authority`) | Critical | Circuit Breaker tripProtocol → 全ポジション緊急 exit |
| Market owner / curator 変更 | Kamino Main Market (`7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF`) account の権限フィールド | Critical | tripProtocol |
| Reserve config 変更 (LTV / liquidation bonus / oracle source) | Kamino reserve accounts (USDC / ONyc reserve) | Warning → Critical | Warning: alert のみ。Critical(LTV 大幅引き下げ等): soft deleverage |
| 大口 transfer (流出) | Kamino USDC reserve liquidity vault, ONyc collateral vault | Warning → Critical | Warning: alert。Critical(残高 N% / 1h 流出): tripProtocol |

監視 **しない** もの (A3 / 既存ロジックで十分):
- TVL 変動 (A3)
- Oracle price deviation (A3)
- Borrow rate spike (A2)

## 検知アーキテクチャ

### 方式: Helius Webhook + 定期 polling のハイブリッド

| 方式 | 役割 | レイテンシ | 障害時 |
|---|---|---|---|
| Helius Webhook (`enhanced` type, `accountAddresses` filter) | プライマリ。アカウント書き換え / TX 発生時に push | 数秒 | 受信できなくても polling が拾う |
| Polling (scheduler に登録、6h 周期) | バックアップ + baseline 再同期 | 6h | webhook 復旧待ち |

**理由**: webhook 単体では bot 側 endpoint がダウン中の event を取りこぼす。polling 単体では大口 transfer に間に合わない (1h で流出するシナリオに 6h 遅延は致命的)。

### コンポーネント

```
Helius (program/account events)
   │
   ▼ HTTPS POST
ApiServer (/Users/yutaro/vault/bot/src/api/server.ts)
   ├─ 新規 route: POST /webhook/helius
   │  └─ HMAC ヘッダ検証 (HELIUS_WEBHOOK_AUTH)
   ▼
AnomalyMonitor (新規 /Users/yutaro/vault/bot/src/risk/anomaly-monitor.ts)
   ├─ subscriber registry: {accountAddress → handler}
   ├─ baseline 比較 (永続化: anomaly_baseline テーブル)
   ├─ 重大度判定
   └─ 出力:
      ├─ recordEvent(EventType.ALERT, metadata.action='anomaly_*')
      ├─ sendAlert(message, severity)
      └─ critical → ProtocolCircuitBreaker.disableProtocol()
```

`AnomalyMonitor` は `Orchestrator` の deps に `anomalyMonitor?` として注入し、`circuitBreaker` と相互参照させる。

## 実装ステップ

### Phase 1 — 最小実装 (1〜2週間)

**目的**: Upgrade authority 変更だけを高信頼で検知 (false positive がほぼゼロのシグナル)。

1. **`bot/src/risk/anomaly-monitor.ts` 新規作成**
   - `class AnomalyMonitor` — `registerHandler(address, handler)` / `processEvent(payload)` / `runPollingCheck()`
   - 最初の handler は `kaminoUpgradeAuthorityHandler` のみ
2. **DB schema 追加** (`bot/src/measurement/db.ts`)
   - `anomaly_baseline (target_id TEXT PRIMARY KEY, key TEXT, value TEXT, updated_at TEXT)`
   - 起動時に存在しなければ最初の値で seed
3. **`EventType.ANOMALY` 追加** (`bot/src/types.ts`)
   - 既存 `ALERT` と分離してダッシュボード / 集計で区別可能に
4. **`ApiServer` に webhook endpoint 追加** (`bot/src/api/server.ts`)
   - `POST /webhook/helius` — Authorization ヘッダ検証 → `anomalyMonitor.processEvent(body)` に丸投げ
   - rate limiter は既存の POST 用 (10/min) を流用
5. **Helius webhook 登録スクリプト** (`bot/scripts/setup-helius-webhooks.ts`)
   - 起動時 / 手動実行で `createWebhook` を呼ぶ。`webhookURL`, `transactionTypes: ['ANY']`, `accountAddresses: [<Kamino lending program ProgramData account>]`, `webhookType: 'enhanced'`
   - 既存 webhook を `getAllWebhooks` で確認し、無ければ create / あれば update
6. **Orchestrator 配線**
   - `index.ts` で `AnomalyMonitor` を生成 → `Orchestrator` の deps に注入
   - `circuitBreaker` の `disableProtocol` を呼べるよう参照を渡す
7. **テスト**
   - Unit: handler 単体で baseline 比較ロジック (一致 → 何もしない / 不一致 → critical alert)
   - Integration: mock Helius payload を `processEvent` に流して `sendAlert` が呼ばれるか
   - E2E (devnet): Kamino program のフォーク or テスト用プログラムを deploy し、authority を `setUpgradeAuthority` で変更 → bot が検知

**Phase 1 完了基準**: 
- Devnet で upgrade authority 書き換えが 60秒以内に Telegram に通知される
- 4週間運用で false positive 0 件
- `~/docs/vault/emergency-response.md` の A1 を "Partially Implemented" に更新

### Phase 2 — 大口 transfer / 設定変更検知 (Phase 1 から +2週間)

1. **大口 transfer handler**
   - 監視対象: Kamino USDC reserve liquidity vault, ONyc collateral vault (アドレスは Kamino SDK から取得)
   - 閾値: 1h以内に reserve 残高の **20%** 以上の純流出で warning、**40%** で critical
   - 実装: webhook で TX を受け取り、`amount` と `direction` を抽出 → 累積を rolling 1h window で集計
2. **Reserve config handler**
   - Kamino reserve account の `liquidationLtvPct`, `oracleSource`, `borrowFactor` 等の主要フィールドを baseline 化
   - 変更検知時、変更内容と差分を含めて critical alert
3. **Polling fallback**
   - `scheduler.register('anomaly-baseline-verify', 21_600_000, ...)` で 6h ごと baseline 再取得 → webhook 取りこぼしの照合
4. **Circuit Breaker 連携の自動化**
   - critical anomaly → 即座に `circuitBreaker.disableProtocol(name, reason)` を呼び、全ポジション exit
   - warning → alert のみ、operator 判断

### Phase 3 — Jupiter Lend / 可視化 (Phase 2 から +1週間)

1. **Jupiter Lend program の特定** (現状 API ベースで program ID 未把握) → SDK / on-chain 確認 → 同等の handler 追加
2. **Frontend 表示**
   - `frontend/` に anomaly event タイムライン (Kanban 風 / 直近 7日) を追加
   - 既存 `events` テーブルを source にし、`metadata.action LIKE 'anomaly_%'` で filter

## 設計上の選択理由

### なぜ Helius webhook (`enhanced`) か
- `accountSubscribe` (WebSocket) より bot プロセス再起動に強い (push なので state 持たない)
- `transaction` type ではなく `enhanced` にすることで token transfer / instruction 名で filter でき、後段の parse コストが減る
- credit 的にも (10 credits/event) account polling よりはるかに安い

### なぜ baseline を DB 永続化するか
- bot 再起動直後の最初の event を「baseline 不在 → 検知失敗」で取りこぼさないため
- 起動時の seed は `getAccountInfo` で取得 → DB に保存

### なぜ EventType を新設するか (既存 ALERT で代用しない)
- ダッシュボードで「定常 alert (health rate warning など)」と「異常検知 (admin key 変更など)」を視覚的に分けたい
- 集計で「anomaly 件数 / 月」を出せると外部レポート (LP 向け透明性) で使える

### Hypernative 導入との関係
- Hypernative を導入したら **重複しない** ように Phase 1 の `kaminoUpgradeAuthorityHandler` は削除可能 (Hypernative がカバー)
- ただし大口 transfer / config 変更の detection logic は **vault 固有の閾値** (例: ONyc の流出はベンダーが知らない) を含むので、Phase 2 の handler はベンダー導入後も残す
- つまり A1 自前実装は **Hypernative の補完** であって、完全代替ではない

## リスク・未解決事項

| リスク | 対策 |
|---|---|
| Helius webhook が IP 制限なしの公開 endpoint になる | `ApiServer` の HMAC 検証必須化、`X-Forwarded-For` での Helius IP 帯チェック追加検討 |
| Webhook 過多で rate limiter に弾かれる | `/webhook/*` は POST limiter から除外、独立の budget |
| baseline と現在値の比較で false positive (Kamino の正常な config update) | warning レベルで止め、24h 以内に operator 確認後 baseline 更新する半手動フロー |
| Jupiter Lend が API のみで program 監視できない | Phase 3 の調査タスク。SDK source 読み込み or 公式に問い合わせ |
| DB の `anomaly_baseline` が大きくなる | 監視対象は数十アカウント程度なので問題なし。retention は不要 |

## 着手前の判断ポイント

ユーザー (Yutaro) に確認したい:

1. **Hypernative の導入予定が直近にあるか?** — 3ヶ月以内に入れる予定なら Phase 1 のスコープを縮小 (大口 transfer のみ自前、authority 監視は Hypernative 待ち) が合理的
2. **Phase 1 完了時に critical anomaly → 自動 exit まで踏み込むか、operator 確認を挟むか** — false positive リスク許容度次第
3. **Helius のプラン** — 現在の credit 残量で webhook 1本追加が予算内か (`getRateLimitInfo` で確認)
