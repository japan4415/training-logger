# 開発ガイド

## ローカル開発環境

### 前提条件

- Node.js 22+
- pnpm
- wrangler（`pnpm` 経由でプロジェクトローカルにインストールされる）

### セットアップ

```bash
git clone https://github.com/japan4415/training-logger.git
cd training-logger
pnpm install
wrangler d1 migrations apply training-logger-db --local
pnpm run dev
```

`pnpm run dev` は `wrangler dev` を実行し、ローカル D1 を使った開発サーバを起動する。

### package.json scripts

| スクリプト | コマンド | 説明 |
|------------|----------|------|
| `dev` | `wrangler dev` | ローカル開発サーバの起動 |
| `deploy` | `wrangler deploy` | 本番環境へのデプロイ |
| `typecheck` | `tsc --noEmit` | TypeScript 型チェック |
| `lint` | `biome check .` | Biome による lint チェック |
| `format` | `biome format --write .` | Biome によるフォーマット |
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
feature/issue-<番号>-<説明>
```

例: `feature/issue-3-data-access-layer`

### PR 本文に `Closes #<番号>` を含める

PR がマージされると対応する Issue が自動的にクローズされる。

### 設計上の意図

Issue の記述は、**別セッションの Claude Code（別モデル）が Issue 単体で作業を完結できる**ことを目的としている。背景・スコープ・受け入れ条件が明確であれば、コンテキスト共有なしに正確な実装が可能になる。

## Issue 記述規約

以下のテンプレートを使って Issue を記述する。将来 `.github/ISSUE_TEMPLATE/` にも配置予定。

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
- SQL ロジックは `src/db/` に集約する

### MCP ツール

- MCP ツールのハンドラは薄く保つ。ビジネスロジックは `src/db/` のデータアクセス関数に委譲する
- MCP ツールは try-catch で囲み、LLM が理解できるエラーメッセージを返す（例: 「種目 'xxx' は見つかりませんでした。search_exercises で検索してください」）

## テスト方針

`@cloudflare/vitest-pool-workers` を使用し、実際の D1 バインディングに対してテストを実行する。

| テスト対象 | 種別 | 内容 |
|------------|------|------|
| `src/db/` | ユニットテスト | CRUD 操作の検証。実 D1 バインディングを使用 |
| `src/mcp/tools/` | 統合テスト | MCP ツール呼び出しの E2E。バリデーション・正常系・異常系 |
| `src/api/` | 統合テスト | REST API のリクエスト/レスポンス検証 |

### テストフィクスチャ

テストフィクスチャには手書きノート 2026-08-15、2026-08-16 の実データを使用する。具体的なデータマッピングは [docs/database.md](./database.md) のマッピング例を参照すること。

## PR 規約

- タイトル: 変更内容の要約
- 本文に含める内容:
  - 変更点の説明
  - テスト結果
  - `Closes #N`（対応する Issue 番号）
