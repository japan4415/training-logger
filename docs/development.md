# 開発ガイド

## ローカル開発環境

### 前提条件

- Node.js 22 または 24 LTS（CI は 22）
- pnpm（`corepack enable` で有効化。本リポジトリは `packageManager: pnpm@10.34.6` を指定しており corepack が該当版を取得する。corepack が同梱されない Node.js 25 以降では `npm install -g corepack` を先に実行する）
- wrangler（`pnpm` 経由でプロジェクトローカルにインストールされる。コマンドは `pnpm exec wrangler` で固定版を使う）

### セットアップ

```bash
git clone https://github.com/japan4415/training-logger.git
cd training-logger
pnpm install
pnpm exec wrangler d1 migrations apply training-logger-db --local
pnpm run dev
```

`pnpm run dev` は `wrangler dev` を実行し、ローカル D1 / R2 / KV を使った開発サーバを起動する。既定では http://localhost:8787 で待ち受ける。Web UI / REST API / `/authorize` は deny-by-default で認証必須のため、ローカル開発では `.dev.vars` を用意し `PHOTO_UPLOAD_ALLOW_UNAUTHENTICATED=1` を有効にする（未設定だと 401 `access_not_configured`）。`/mcp` は OAuth のためこのフラグでは緩和されず、access token が無ければ 401 になる。

```bash
cp .dev.vars.example .dev.vars
```

コピー後に必要な編集:

- `PHOTO_UPLOAD_ALLOW_UNAUTHENTICATED=1` のコメントを外す（Host が `localhost` / `127.0.0.1` のときだけ有効。リクエストは既定ユーザー `user 1` として扱われる）
- `create_feedback` を試す場合、`GITHUB_TOKEN=github_pat_xxx` のプレースホルダ行は truthy のためそのままでは GitHub API が 401 になる。実際の fine-grained PAT（`Issues: Read and write`）に置き換えると `GITHUB_REPO_OWNER` / `GITHUB_REPO_NAME` の先へ実際に起票される（既定は本番リポジトリ。試さない場合は行を削除すると手動起票 URL の案内にフォールバックする）
- `OAUTH_CONSENT_SECRET` は同意画面の CSRF 鍵。ローカル開発フォールバック（`PHOTO_UPLOAD_ALLOW_UNAUTHENTICATED=1` + `ACCESS_*` 未設定）では固定のダミー鍵が使われるため設定は不要

マイグレーションは dev 起動前に適用する（先に dev を起動すると空の DB になる）。

### package.json scripts

| スクリプト | コマンド | 説明 |
|------------|----------|------|
| `dev` | `wrangler dev` | ローカル開発サーバの起動 |
| `deploy` | `wrangler deploy` | 本番環境へのデプロイ |
| `typecheck` | `tsc --noEmit` | TypeScript 型チェック |
| `lint` | `biome check .` | Biome による lint チェック |
| `format` | `biome format --write .` | Biome によるフォーマット |
| `build:skill` | `node scripts/build-skill.mjs` | Skill 配布物（`public/skills/`）の生成 |
| `test` | `vitest run` | テストの実行 |

## Issue 駆動開発

本プロジェクトでは Issue 駆動開発を中心プロセスとして採用する。Claude Code が Issue を読み取り、実装からテスト、PR 作成までを一貫して行う。

### フロー

```
Issue 作成                    Claude Code が Issue を読む
  |                                    |
  |  GitHub MCP / gh CLI               |
  |  または手動作成                     |
  v                                    v
┌─────────┐    ┌─────────────┐    ┌──────────────┐
│  Issue   │───>│ feature     │───>│ 実装 + テスト │
│  作成    │    │ ブランチ作成 │    │              │
└─────────┘    └─────────────┘    └──────┬───────┘
                                         |
                                         v
┌─────────┐    ┌─────────────┐    ┌──────────────┐
│  自動    │<───│   CI 通過   │<───│    PR 作成   │
│ デプロイ │    │             │    │ Closes #N    │
└─────────┘    └─────────────┘    └──────────────┘
```

### ブランチ命名規則

```
feat/<説明>   # 新機能
fix/<説明>    # バグ修正
docs/<説明>   # ドキュメント
```

説明に issue 番号を含めることを推奨する。例: `fix/issue-15-docs-sync`

### PR 本文に `Closes #<番号>` を含める

PR がマージされると対応する Issue が自動的にクローズされる。

### 設計上の意図

Issue の記述は、**別セッションの Claude Code（別モデル）が Issue 単体で作業を完結できる**ことを目的としている。背景・スコープ・受け入れ条件が明確であれば、コンテキスト共有なしに正確な実装が可能になる。

## Issue 記述規約

以下のテンプレートを使って Issue を記述する。`.github/ISSUE_TEMPLATE/feature-request.md` に配置済み。

```markdown
## 背景
なぜこの issue が必要か（1-2文）

## スコープ
- [ ] 具体的なタスク

## 非スコープ
- この issue では扱わないこと

## 受け入れ条件
- [ ] 検証可能な条件

## 参照
- docs/xxx.md のセクション名
- 依存 issue: #N
```

## コーディング規約

### TypeScript

- `strict` モードを有効にする
- 命名規則:
  - テーブル名・カラム名: `snake_case`
  - TypeScript 変数・関数: `camelCase`
  - TypeScript 型・インターフェース: `PascalCase`

### コードスタイル

- Biome でフォーマットと lint を統一する
- 関数は小さく保ち、1ファイル1責務を心がける

### SQL

- SQL クエリは必ず prepared statement（`.bind()`）を使用する。文字列結合による SQL 組み立ては禁止
- SQL ロジックは `src/db/` に集約する。ただし一部の SSR ビュー（種目進捗・種目一覧・前後セッション取得）は表示専用の集計 SQL をビュー内に直接持つ

### MCP ツール

- MCP ツールのハンドラは薄く保つ。ビジネスロジックは `src/db/` のデータアクセス関数に委譲する
- MCP ツールは try-catch で囲み、LLM が理解できるエラーメッセージを返す（例: 「種目 'xxx' は見つかりませんでした。search_exercises で検索してください」）

## テスト方針

`@cloudflare/vitest-pool-workers` を使用し、実際の D1 バインディングに対してテストを実行する。

| テスト対象 | 種別 | 内容 |
|------------|------|------|
| `src/db/` | ユニットテスト | CRUD 操作の検証。実 D1 バインディングを使用。ユーザー分離（他ユーザーの行は取得・更新できない）も検証 |
| `src/domain/` | ユニットテスト | Atlas 筋肉割当の検証・集約 |
| `src/security/` | ユニットテスト | Access JWT の検証（RS256 / `iss` / `aud` / `exp` / `nbf`）と deny-by-default ミドルウェア・公開パス判定 |
| `src/oauth/` | 統合テスト | OAuthProvider の metadata / 401 challenge / DCR、同意画面（CSRF・redirect 検証）、scope 検査、token 交換 |
| `src/mcp/` | 統合テスト | MCP ツール呼び出し。バリデーション・正常系・異常系・scope / role ガード |
| `src/api/` | 統合テスト | REST API のリクエスト/レスポンス検証 |
| `src/views/` | 統合テスト | SSR ビューのレンダリング・htmx 部分更新・ユーザー分離の検証 |

### テストフィクスチャ

テストフィクスチャには手書きノート 2026-08-15、2026-08-16 の実データを使用する。具体的なデータマッピングは [docs/database.md](./database.md) のマッピング例を参照すること。

## PR 規約

- タイトル: 変更内容の要約
- 本文に含める内容:
  - 変更点の説明
  - テスト結果
  - `Closes #N`（対応する Issue 番号）
