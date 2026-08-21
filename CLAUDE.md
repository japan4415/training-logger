# CLAUDE.md

個人用筋トレ記録アプリ。MCP サーバとして ChatGPT / Claude からトレーニングを記録し、Web UI で振り返る。

## 設計の正典

`docs/` 以下が設計の source of truth。作業前に [README.md](README.md) の目次から関連ドキュメントを読むこと。

## 開発フロー

1. GitHub issue を確認し、対象 issue の要件を把握する
2. `main` から feature ブランチを作成する（`feat/xxx` or `fix/xxx`）
3. 実装 + テストを書く
4. PR を作成し、CI が通ることを確認する
5. merge で Cloudflare Workers に自動デプロイされる

## 主要コマンド

```bash
pnpm install                                        # 依存インストール
pnpm run dev                                        # ローカル開発サーバ (wrangler dev)
pnpm run typecheck                                  # TypeScript 型チェック
pnpm run lint                                       # Biome lint
pnpm run test                                       # Vitest テスト実行
wrangler d1 migrations apply training-logger-db --local  # ローカル D1 マイグレーション
```

## 規約

- TypeScript strict モード
- lint / format は Biome（ESLint / Prettier は不使用）
- SQL は prepared statement 必須（文字列結合による SQL 構築は禁止）
- テーブル名・カラム名は [docs/database.md](docs/database.md) に従う
- MCP ツール名・仕様は [docs/mcp-server.md](docs/mcp-server.md) に従う
- ORM は不使用。D1 の SQLite 方言に対して SQL を直接記述する
- テストは `test/` 以下に配置。`@cloudflare/vitest-pool-workers` で D1 バインディングを使用する

## ディレクトリ構成

- `src/db/` - データアクセス層（ビジネスロジックの本体）
- `src/mcp/` - MCP ハンドラ・ツール定義（薄く保ち、ロジックは `db/` に委譲）
- `src/api/` - REST API（Web UI 向け、読み取り専用）
- `src/views/` - SSR テンプレート（Hono JSX）
- `public/` - 静的ファイル（Workers Assets で配信）
- `migrations/` - D1 マイグレーション SQL
- `test/` - Vitest テスト
