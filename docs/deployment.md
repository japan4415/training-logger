# デプロイ

## Cloudflare リソース一覧

| リソース | 名前 | 用途 |
|----------|------|------|
| Worker | `training-logger` | 単一 Worker で MCP + REST API + SSR + Workers Assets を統合配信 |
| D1 Database | `training-logger-db` | 本番データベース。ローカル開発は `wrangler dev` の自動ローカル D1 を使用 |
| R2 Bucket | `training-logger-photos` | セッション写真の画像本体を保存。Standard storage class |
| Cloudflare Access | custom domain のアプリケーション | `/sessions/*` と `/api/*` を認証し、写真の書き込みを保護 |

## wrangler.jsonc

```jsonc
{
  "name": "training-logger",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": false,
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
  "r2_buckets": [
    {
      "binding": "PHOTOS",
      "bucket_name": "training-logger-photos"
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

`workers_dev: false` により `https://<worker>.<account>.workers.dev` は無効化済みで、公開経路は Cloudflare Access を設定した custom domain のみに限定する。

## 初期構築手順

### 1. D1 データベースの作成

```bash
wrangler d1 create training-logger-db
```

出力される `database_id` を `wrangler.jsonc` の `<production-db-id>` に反映する。

### 2. R2 バケットの作成

```bash
pnpm exec wrangler r2 bucket create training-logger-photos
```

作成したバケットは `wrangler.jsonc` の `r2_buckets` で `PHOTOS` binding に割り当てる。ローカルの `wrangler dev` では R2 binding もローカルストレージとしてエミュレートされるため、本番バケットへ書き込まない。

### 3. マイグレーションの適用

```bash
wrangler d1 migrations apply training-logger-db --remote
```

### 4. GitHub トークンの設定（MCP create_feedback 用）

MCP 経由の Issue 起票（`create_feedback`）を利用するため、GitHub の Fine-grained Personal Access Token（権限: `Issues: Read and write`）を発行し、Wrangler secret として登録する。

```bash
wrangler secret put GITHUB_TOKEN
```

※ 登録先リポジトリを変更したい場合は、環境変数 `GITHUB_REPO_OWNER` / `GITHUB_REPO_NAME` を指定する（未設定時は既定値 `japan4415` / `training-logger`）。

### 5. Cloudflare Access の設定

Cloudflare Zero Trust で custom domain を対象とした Self-hosted application を作成し、パスごとに次のポリシーを設定する。

| パス | ポリシー | 理由 |
|---|---|---|
| `/mcp` | Bypass | ChatGPT / Claude の認証なし remote MCP 接続を許可 |
| `/skills/*` | 必要な場合のみ Bypass | claude.ai などへ Skill zip を直接配布する場合 |
| `/sessions/*` | Allow | セッション画面と写真 UI を Access ログイン済みユーザーに限定 |
| `/api/*` | Allow | 写真本体とブラウザ書き込み API を保護 |

写真 API の GET / POST / DELETE は Worker 内でも Access JWT を検証する。Zero Trust の Access application 画面から **Application Audience (AUD) Tag** を取得し、team domain とともに Worker vars に設定する。`ACCESS_TEAM_DOMAIN` は `example.cloudflareaccess.com` のようにスキームを含めない。

平文の構成値として管理する場合は `wrangler.jsonc` に追加する。

```jsonc
"vars": {
  "ACCESS_TEAM_DOMAIN": "example.cloudflareaccess.com",
  "ACCESS_AUD": "<Access application の AUD タグ>"
}
```

リポジトリへ値を保存したくない場合は secret として設定してもよい。

```bash
pnpm exec wrangler secret put ACCESS_TEAM_DOMAIN
pnpm exec wrangler secret put ACCESS_AUD
```

どちらか一方でも未設定なら写真 API は読み書きとも 401 `access_not_configured` で fail-closed になる。

### 6. デプロイ

```bash
pnpm exec wrangler deploy
```

`wrangler versions deploy` を使用する場合、secret を追加した後は、対象バージョンの binding に新しい secret が含まれることを確認してからデプロイする。古いバージョンをそのまま指定すると、追加した Access 設定が反映されず写真書き込みが 401 になる可能性がある。

### 7. 疎通確認

以下を確認する:

- `GET /health` が 200 を返す
- `POST /mcp` で MCP `initialize` が成功する
- ブラウザで `/` にアクセスすると Web UI が表示される
- Access 認証後にセッション画面を開き、写真の追加・取得・削除ができる
- 未認証の写真 GET / POST / DELETE が 401 または Access 側で拒否される

## 環境

本番環境（production）のみ運用する。個人利用のため preview 環境を設ける利益が薄い。

- **本番**: `wrangler deploy` でデプロイ。D1 は `training-logger-db`（リモート）。シークレットは `wrangler secret put` で設定
- **ローカル開発**: `wrangler dev` で起動。D1 と R2 binding はローカルでエミュレートされる。マイグレーション適用は `wrangler d1 migrations apply training-logger-db --local`。写真 API の動作確認では `.dev.vars` に `PHOTO_UPLOAD_ALLOW_UNAUTHENTICATED=1` を設定できるが、このフラグはリクエスト先 Host が `localhost` または `127.0.0.1`（ポート付き可）の場合だけ有効で、それ以外では無視して 401 を返す。本番ではこの変数を設定しない。写真の書き込みリクエストは `Sec-Fetch-Site` が `same-origin` または `none` の場合だけ受け付け、ヘッダー欠如時も 403 を返す。その他のシークレットや環境変数も `.dev.vars`（`.dev.vars.example` 参照）に設定する

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
| R2 Standard | 10 GB-month ストレージ | 写真 10 MiB × 最大 4 枚/セッション | 毎日上限まで保存する場合は約 8 か月分。実際はこれより長い |
| Workers | 10万リクエスト/日 | 数十リクエスト/日 | 個人閲覧 + MCP 呼び出し |

出典: <https://developers.cloudflare.com/d1/platform/pricing/>、<https://developers.cloudflare.com/r2/pricing/>
