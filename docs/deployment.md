# デプロイ

## Cloudflare リソース一覧

| リソース | 名前 | 用途 |
|----------|------|------|
| Worker | `training-logger` | 単一 Worker で MCP + REST API + SSR + Workers Assets を統合配信 |
| D1 Database | `training-logger-db` | 本番データベース。ローカル開発は `wrangler dev` の自動ローカル D1 を使用 |
| Workers Secret | `MCP_SECRET` | MCP エンドポイントのシークレットパス認証用トークン |
| Workers Secret | `GITHUB_TOKEN` | GitHub Issues API 呼び出し用の fine-grained PAT |
| Cloudflare Access アプリ (1) | MCP パス Bypass | `/mcp/*` へのアクセスを Bypass（MCP クライアントが Access 認証を通過できないため） |
| Cloudflare Access アプリ (2) | Web UI 保護 | アプリドメイン全体に Email 許可リスト（本人のみ）の Allow ポリシー |

## wrangler.jsonc

```jsonc
{
  "name": "training-logger",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": "./public" },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "training-logger-db",
      "database_id": "<production-db-id>",
      "migrations_dir": "migrations"
    }
  ]
}
```

## 初期構築手順

### 1. D1 データベースの作成

```bash
wrangler d1 create training-logger-db
```

出力される `database_id` を `wrangler.jsonc` の `<production-db-id>` に反映する。

### 2. MCP_SECRET の設定

```bash
# ランダムなシークレットを生成
openssl rand -hex 32

# 生成した値を Workers Secret に登録
wrangler secret put MCP_SECRET
```

### 3. GITHUB_TOKEN の設定

> **ユーザー操作**: GitHub で fine-grained Personal Access Token を作成する。
>
> - 対象リポジトリ: `japan4415/training-logger` のみ
> - 権限: Issues: Read and write
> - PAT の作成は GitHub の Settings > Developer settings > Fine-grained tokens で行う

```bash
wrangler secret put GITHUB_TOKEN
```

### 4. マイグレーションの適用

```bash
wrangler d1 migrations apply training-logger-db --remote
```

### 5. デプロイ

```bash
wrangler deploy
```

### 6. Cloudflare Access の設定

> **ユーザー操作**: Cloudflare Zero Trust ダッシュボードで Access アプリケーションを2つ作成する。
>
> 参考: <https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/>

**アプリ (a): MCP パス Bypass**

- パス: `/mcp/*`
- ポリシー: Bypass
- 理由: MCP クライアント（ChatGPT / claude.ai）は Cloudflare Access の認証フローを通過できないため

**アプリ (b): Web UI 保護**

- 対象: アプリドメイン全体
- ポリシー: Allow
- 条件: Email 許可リスト（本人のメールアドレスのみ）

### 7. 疎通確認

以下を確認する:

- `GET /health` が 200 を返す
- 正しい secret で MCP initialize が成功する
- 不正な secret で 404 が返る
- ブラウザで `/` にアクセスすると Cloudflare Access のログイン画面が表示される

## 環境

本番環境（production）のみ運用する。個人利用のため preview 環境を設ける利益が薄い。

- **本番**: `wrangler deploy` でデプロイ。D1 は `training-logger-db`（リモート）
- **ローカル開発**: `wrangler dev` で起動。D1 はローカルに自動作成される。マイグレーション適用は `wrangler d1 migrations apply training-logger-db --local`

## CI/CD

GitHub Actions で CI（PR 時）と CD（main push 時）を構成する。

### ci.yml（PR 時）

```yaml
name: CI

on:
  pull_request:
    branches: [main]

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

### deploy.yml（main push 時）

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
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

      - run: pnpm run test

      - name: Apply D1 migrations
        uses: cloudflare/wrangler-action@v3
        with:
          command: d1 migrations apply training-logger-db --remote
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}

      - name: Deploy Worker
        uses: cloudflare/wrangler-action@v3
        with:
          command: deploy
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

> **ユーザー操作**: GitHub リポジトリの Settings > Secrets and variables > Actions に以下を設定する:
>
> - `CLOUDFLARE_API_TOKEN`: Cloudflare API トークン（Workers と D1 の権限）
> - `CLOUDFLARE_ACCOUNT_ID`: Cloudflare アカウント ID

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
| Cloudflare Access | 50 シート | 1 シート | 個人利用 |

出典: <https://developers.cloudflare.com/d1/platform/pricing/>
