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

CI パイプライン (`ci.yml`) の PR チェックで `pnpm exec wrangler d1 migrations apply training-logger-db --local` を実行し、マイグレーション SQL の構文を検証する。構文エラーがあると CI が失敗し、マージがブロックされる。

## テーブル再構築を含むマイグレーション

SQLite ではテーブル定義の一部（カラム削除、`UNIQUE` 変更など）を `ALTER TABLE` で変更できないため、テーブルを作り直す。D1 は外部キーが常時有効で `PRAGMA foreign_keys = off` を使えない点に注意する。子テーブルが `ON DELETE CASCADE` で親を参照している場合、親だけを `DROP` すると子の全行が削除される（`PRAGMA defer_foreign_keys` は検査を遅らせるだけで CASCADE は止まらない）。

`0005_users_and_user_id.sql` は `workout_sessions` の `UNIQUE` を変更するため、`workout_sessions` / `session_exercises` / `sets` / `session_photos` の 4 テーブルを 1 つの migration で同時に再構築する。手順は次のとおり。

1. `PRAGMA defer_foreign_keys = on`
2. `users` / `user_identities` を作成し、既定オーナー `id = 1` を投入する
3. 新しい列を含む `*_new` テーブルを作成する（子の `REFERENCES` は `*_new` を指す）
4. AUTOINCREMENT の採番位置を引き継ぐ（下記「AUTOINCREMENT の採番位置」）
5. `id` を保持して親 → 子の順にコピーする
6. 子から `DROP` する（`sets` → `session_photos` → `session_exercises` → `workout_sessions`）
7. 親から `RENAME` する（`*_new` → 最終名。子の参照は SQLite が自動で追随する）
8. インデックスを再作成する

### AUTOINCREMENT の採番位置

`DROP TABLE` は旧テーブルの `sqlite_sequence` 行も消すため、`*_new` 側の採番位置はコピーした `MAX(id)` まで下がる。末尾で削除した id が再利用されると、期限の無い `/sessions/:id` リンクや古い id を保持するクライアントが別セッションを指し得る。0005 は旧 `sqlite_sequence` の値と同じ id の一時行を `*_new` へ 1 行だけ `INSERT` してすぐ `DELETE` することで、通常の AUTOINCREMENT の仕組みで高水位だけを引き継ぐ（`DELETE` では採番位置は下がらない）。`sqlite_sequence` は直接書き換えないため、本番 D1 での書き込み可否に依存しない。

`test/db/migration-0005.test.ts` が 0001〜0004 相当のデータを投入して実際の SQL を適用し、件数・ID・`PRAGMA foreign_key_check`・CASCADE・複合 `UNIQUE`・削除済み id が再利用されないことを検証する。同種の再構築を追加するときは、この形でデータ入りの migration テストも併せて追加する。

### `0005` の本番適用手順

`0005` は 4 テーブルを再構築する変更のため、本番へ適用する前に次の順で進める。`--remote` の操作は人手で実施する（自動作業環境からは実行しない）。実データや Time Travel bookmark の具体値はドキュメントへ書かない。

1. **退避**: `pnpm exec wrangler d1 export training-logger-db --remote --output <退避ファイル>` で現行データを退避し、Time Travel の現在の bookmark を控える。
2. **リハーサル**: 手順 1 の export をローカルの D1 へ投入し、`pnpm exec wrangler d1 migrations apply training-logger-db --local` で `0005` の適用を事前確認する。
3. **本番適用**: `pnpm exec wrangler d1 migrations apply training-logger-db --remote` を実行する。
4. **確認**: 適用後に `workout_sessions` / `session_exercises` / `sets` / `session_photos` の件数が適用前と一致すること、`PRAGMA foreign_key_check` が空であることを確認する。
5. **失敗時**: `0005` は 1 つのバッチ（1 トランザクション）で実行され、失敗しても `d1_migrations` には記録されないため、原因を修正してそのまま再実行できる。データに異常が出た場合は手順 1 で控えた Time Travel bookmark へ restore する。

## 注意事項

- SQL は D1 (SQLite) の方言に準拠して記述する
- ORM は使用しない。SQL を直接記述する
- テーブル名・カラム名は [docs/database.md](../docs/database.md) に従う
- 本番データベースへの破壊的変更（カラム削除、テーブル削除等）は、データ退避を確認してから適用する
