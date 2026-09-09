# デプロイ

## Cloudflare リソース一覧

| リソース | 名前 | 用途 |
|----------|------|------|
| Worker | `training-logger` | 単一 Worker で MCP + REST API + SSR + Workers Assets を統合配信 |
| D1 Database | `training-logger-db` | 本番データベース。ローカル開発は `wrangler dev` の自動ローカル D1 を使用 |

## wrangler.jsonc

```jsonc
{
  "name": "training-logger",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": true,
  "routes": [
    {
      "pattern": "training-logger.discord.jp",
      "custom_domain": true
    }
  ],
  "assets": { "directory": "./public" },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "training-logger-db",
      "database_id": "<production-db-id>",
      "migrations_dir": "migrations"
    }
  ],
  // Observability: console.log/error の出力とリクエストトレースを有効化
  "observability": {
    "enabled": true,
    "head_sampling_rate": 1,
    "traces": {
      "enabled": true,
      "head_sampling_rate": 1
    }
  }
}
```

## 初期構築手順

### 1. D1 データベースの作成

```bash
wrangler d1 create training-logger-db
```

出力される `database_id` を `wrangler.jsonc` の `<production-db-id>` に反映する。

### 2. マイグレーションの適用

```bash
wrangler d1 migrations apply training-logger-db --remote
```

### 3. デプロイ

```bash
wrangler deploy
```

### 4. 疎通確認

以下を確認する:

- `GET /health` が 200 を返す
- `POST /mcp` で MCP `initialize` が成功する
- ブラウザで `/` にアクセスすると Web UI が表示される

## 環境

本番環境（production）のみ運用する。個人利用のため preview 環境を設ける利益が薄い。

- **本番**: `wrangler deploy` でデプロイ。D1 は `training-logger-db`（リモート）
- **ローカル開発**: `wrangler dev` で起動。D1 はローカルに自動作成される。マイグレーション適用は `wrangler d1 migrations apply training-logger-db --local`

## CI/CD

CI は GitHub Actions、CD は Cloudflare Workers Builds（Git 連携）で構成する。

### CI: ci.yml（PR 時）

GitHub Actions で PR 時に typecheck / lint / D1 マイグレーション検証 / test を実行する。

```yaml
name: CI

on:
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - run: pnpm run typecheck

      - run: pnpm run lint

      - name: Validate D1 migrations
        run: pnpm exec wrangler d1 migrations apply training-logger-db --local

      - run: pnpm run test
```

### CD: Cloudflare Workers Builds（main push 時）

Cloudflare Workers Builds（Git 連携）により、`main` ブランチへの push 時に自動デプロイが実行される。GitHub Actions の `deploy.yml` は使用しない。

Cloudflare ダッシュボードで GitHub リポジトリを連携すると、`main` への push を検知して自動的にビルド・デプロイが行われる。現行のWorkers Builds設定はD1マイグレーションを自動適用しない。DB変更を含むPRでは、本番の `wrangler d1 migrations apply training-logger-db --remote` をデプロイ前に実行し、適用履歴を確認する（[運用手順](../migrations/README.md)）。ビルド成功だけではDB移行の完了を意味しない。

## バックアップ

### Cloudflare Time Travel

D1 は Cloudflare 側で Time Travel（ポイントインタイム復元）機能を提供している。意図しないデータ変更が発生した場合、指定した時点の状態に復元できる。

### 手動エクスポート

月次で手動エクスポートを推奨する:

```bash
wrangler d1 export training-logger-db --remote --output=backup-YYYYMMDD.sql
```

GitHub Actions cron による自動バックアップは将来課題とする（[ロードマップ](./roadmap.md)参照）。

## 無料枠の根拠

個人の筋トレ記録は1日あたり数十行の書き込み・数百行の読み取りで、各サービスの無料枠に対して十分な余裕がある。

| サービス | 無料枠 | 想定使用量 | 根拠 |
|----------|--------|------------|------|
| D1 | 5GB ストレージ / 読み取り 500万行/日 / 書き込み 10万行/日 | 数十行/日 | 上限の 0.1% 以下 |
| Workers | 10万リクエスト/日 | 数十リクエスト/日 | 個人閲覧 + MCP 呼び出し |

出典: <https://developers.cloudflare.com/d1/platform/pricing/>
