# training-logger

手書きの筋トレノートを、AI チャット経由でデジタル記録に変換する個人用トレーニングログシステム。

## ステータス

実装完了。`https://training-logger.discord.jp` で本番運用中。改善は [GitHub issue 駆動](https://github.com/japan4415/training-logger/issues) で継続する。

> **Cloudflare Access（任意）**: Access を設定すると `/sessions/*` と `/api/*` を保護できる推奨構成。ブラウザからの写真の表示・追加は Access の設定を前提とする。有効化手順は [docs/deployment.md](docs/deployment.md) の手順 5 を参照。

## 特徴

- **AI チャットから記録**: ChatGPT・Claude に話しかけるだけで筋トレを記録（MCP 接続）
- **ノート写真も OK**: 手書きノートの写真を送れば LLM が読み取って構造化・登録（Claude 向け登録手順 Skill も提供）
- **元の写真も保存**: 登録に使ったノート写真を R2 に保存し、セッション詳細から振り返り可能（Cloudflare Access の設定が前提）
- **Web で振り返り**: 過去の記録をブラウザで閲覧。種目別の推移をチャートで確認し、鍛えた部位を人体（Human Atlas）の 3D 表示で可視化
- **チャットから改善要望**: 「こんな機能がほしい」と言えば `create_feedback` で GitHub issue を起票（`GITHUB_TOKEN` 設定時は自動起票、未設定時は手動起票用 URL を案内）。アプリ自体が進化する
- **Cloudflare 無料枠で運用**: Workers + D1 + R2（+ 任意で Access）。個人利用なら完全無料

## アーキテクチャ概要

```mermaid
graph LR
    A["ChatGPT / Claude"] -->|MCP| B["Cloudflare Worker"]
    C["ブラウザ"] -->|HTTPS| D["Cloudflare Access<br/>(任意)"]
    D --> B
    B --> E["D1 Database"]
    B --> G["R2<br/>training-logger-photos"]
    B -->|issue 起票| F["GitHub Issues"]
```

## ドキュメント

| ドキュメント | 内容 |
|---|---|
| [docs/overview.md](docs/overview.md) | 背景・動機・ユーザーフロー・スコープ |
| [docs/architecture.md](docs/architecture.md) | 技術スタック・システム構成・認証・リクエストフロー・リポジトリ構成 |
| [docs/database.md](docs/database.md) | テーブル設計・ER 図・マイグレーション方針 |
| [docs/mcp-server.md](docs/mcp-server.md) | MCP ツール仕様・エンドポイント・各クライアントの接続手順 |
| [docs/skill.md](docs/skill.md) | 登録手順 Skill（Agent Skills）の仕様・導入・利用手順 |
| [docs/anatomy.md](docs/anatomy.md) | Atlasの筋肉カタログ・種目ごとの対応・出典 |
| [docs/web-ui.md](docs/web-ui.md) | Web UI 画面設計・SSR 構成・htmx による部分更新 |
| [docs/deployment.md](docs/deployment.md) | デプロイ手順・Cloudflare 設定・環境変数・CI/CD |
| [docs/development.md](docs/development.md) | ローカル開発・テスト・lint・issue 駆動開発フロー |
| [docs/roadmap.md](docs/roadmap.md) | フェーズ計画・将来の拡張構想 |

## クイックスタート

### 前提条件

- Node.js 22 または 24 LTS（CI は 22。`node -v`）
- pnpm（`corepack enable` で有効化。本リポジトリは `packageManager: pnpm@10.34.6` を指定しており corepack が該当版を自動取得する。corepack が同梱されない Node.js 25 以降では `npm install -g corepack` を先に実行する）

### 手順

```bash
git clone https://github.com/japan4415/training-logger.git
cd training-logger
pnpm install
pnpm exec wrangler d1 migrations apply training-logger-db --local
pnpm run dev
```

`pnpm run dev` は `wrangler dev` を起動し、既定で http://localhost:8787 で待ち受ける。ローカル D1 / R2 はエミュレートされ、本番リソースには接続しない。マイグレーションは dev 起動前に適用する（先に dev を起動すると空の DB になる）。

（任意）`.dev.vars` を用意すると `create_feedback`（`GITHUB_TOKEN`）や写真 API のローカル検証が使える。起動自体には不要。

```bash
cp .dev.vars.example .dev.vars
```

コピー後に必要な編集:

- `create_feedback` を試す場合、`GITHUB_TOKEN=github_pat_xxx` のプレースホルダ行は truthy のためそのままでは GitHub API が 401 になる。実際の fine-grained PAT（`Issues: Read and write`）に置き換えると `GITHUB_REPO_OWNER` / `GITHUB_REPO_NAME` の先へ実際に起票される（既定は本番リポジトリ。試さない場合は行を削除すると手動起票 URL の案内にフォールバックする）
- 写真 API を試す場合は `PHOTO_UPLOAD_ALLOW_UNAUTHENTICATED=1` のコメントを外す（localhost / 127.0.0.1 のときだけ有効）

### 動作確認

別ターミナルで:

```bash
curl -s http://localhost:8787/health        # {"status":"ok"}
curl -s http://localhost:8787/api/sessions   # {"sessions":[],"total":0}
curl -s http://localhost:8787/api/exercises  # {"exercises":[]}
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8787/          # 200
curl -s http://localhost:8787/exercises | grep -o '<title>[^<]*</title>' # 種目一覧
curl -s -X POST http://localhost:8787/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0.0.1"}}}'
```
> 期待出力: `result.protocolVersion: "2025-06-18"`、`result.serverInfo.name: "training-logger"`。

> ローカル D1 は空のため `/api/exercises` は `[]`、`/exercises/:id` は 404 を返す。本番 DB のデータはローカルへ同期されない。

## MCP 接続

本システムは MCP（Model Context Protocol）サーバとして動作し、3 種類のクライアントから接続できます。

| クライアント | 接続方式 |
|---|---|
| ChatGPT | Developer Mode Connector（remote HTTPS、認証なし） |
| claude.ai | Custom Connector（remote HTTPS、認証なし） |
| Claude Desktop | リモートコネクタ（推奨）または mcp-remote ブリッジ |

詳細な接続手順は [docs/mcp-server.md](docs/mcp-server.md) を参照してください。

また、Claude（claude.ai / Claude Code）向けに、手書きノート写真からの登録を安全・確実に行う手順 Skill（`log-workout`）を提供しています。導入手順は [docs/skill.md](docs/skill.md) を参照してください。

## 開発フロー

issue 駆動開発を採用しています。

1. 改善要望はチャットから `create_feedback` ツールで issue 化
2. issue を元に feature ブランチで実装
3. PR 作成 → CI 通過 → merge で自動デプロイ

詳細は [docs/development.md](docs/development.md) を参照してください。
