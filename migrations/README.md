# マイグレーション運用手順

Cloudflare D1 のマイグレーションは `wrangler d1 migrations` コマンドで管理する。

## ファイル命名規則

連番 + スネークケースの説明で命名する。

```
migrations/
  0001_initial_schema.sql
  0002_add_xxx.sql
  0003_alter_yyy.sql
  ...
```

- 番号は 4 桁ゼロ埋め (`0001`, `0002`, ...)
- wrangler が番号順に適用する。手動で順序を変更しない
- 適用済みのマイグレーションファイルは編集・削除しない（D1 が `d1_migrations` テーブルで適用状態を管理しているため、不整合が生じる）

## 新規マイグレーションの作成

```bash
pnpm exec wrangler d1 migrations create training-logger-db <name>
```

`migrations/` ディレクトリに空の SQL ファイルが生成される。生成されたファイルに DDL を記述する。

例:

```bash
pnpm exec wrangler d1 migrations create training-logger-db add_user_preferences
# -> migrations/0002_add_user_preferences.sql が生成される
```

## マイグレーションの適用

### ローカル（開発）

```bash
pnpm exec wrangler d1 migrations apply training-logger-db --local
```

`wrangler dev` が使用するローカル D1 (`.wrangler/state/v3/d1/`) に適用される。

### リモート（本番）

```bash
pnpm exec wrangler d1 migrations apply training-logger-db --remote
```

本番の D1 データベースに適用される。デプロイは Cloudflare Workers Builds (Git 連携) で行われるが、Workers Builds は Worker のビルド・デプロイのみを行い D1 マイグレーションの自動適用は行わないため、リモート DB へのマイグレーション適用は手動で実行する必要がある。将来的に自動化する場合は別途検討する。

## CI での構文検証

CI パイプライン (`ci.yml`) の PR チェックで `wrangler d1 migrations apply training-logger-db --local` を実行し、マイグレーション SQL の構文を検証する。構文エラーがあると CI が失敗し、マージがブロックされる。

## 注意事項

- SQL は D1 (SQLite) の方言に準拠して記述する
- ORM は使用しない。SQL を直接記述する
- テーブル名・カラム名は [docs/database.md](../docs/database.md) に従う
- 本番データベースへの破壊的変更（カラム削除、テーブル削除等）は、データ退避を確認してから適用する
