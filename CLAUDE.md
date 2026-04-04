# CLAUDE.md

## コミュニケーション

- 日本語で回答すること

## 開発フロー

### ローカル確認

- frontendの変更は `cd ~/vault/frontend && PORT=4001 npm run dev` でローカル確認可能
- `.env.local` でリモートbot APIを参照するプロキシ構成済み
- UI変更はHMRで即時反映されるため、リモートデプロイ前にローカルで確認すること

### デプロイ

変更が確定したら以下を一連で実行すること:

1. コミット & `git push`
2. リモートで `git pull origin main`
3. botの変更がある場合: `cd ~/vault/bot && sudo docker compose down && sudo docker compose up -d --build`
4. frontendの変更がある場合: リモートでfrontendを再ビルド & 再起動

## Notion

- 「Notionを読んで」と言われたら、以下のVaultページを読み込むこと
- URL: https://www.notion.so/dawn-news/Vault-319316dd5b6480f88c1ee5cdfc8a5c4c
