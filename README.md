# training-logger

手書きの筋トレノートを、AI チャット経由でデジタル記録に変換する個人用トレーニングログシステム。

## ステータス

設計完了。実装は [GitHub issue 駆動](https://github.com/japan4415/training-logger/issues) で進行中。

## 特徴

- **AI チャットから記録**: ChatGPT・Claude に話しかけるだけで筋トレを記録（MCP 接続）
- **ノート写真も OK**: 手書きノートの写真を送れば LLM が読み取って構造化・登録
- **Web で振り返り**: 過去の記録をブラウザで閲覧。種目別の推移をチャートで確認
- **チャットから改善要望**: 「こんな機能がほしい」と言えば GitHub issue が自動起票され、アプリ自体が進化する
- **Cloudflare 無料枠で運用**: Workers + D1 + Access。個人利用なら完全無料

## アーキテクチャ概要

```mermaid
graph LR
    A["ChatGPT / Claude"] -->|MCP| B["Cloudflare Worker"]
    C["ブラウザ"] -->|HTTPS| D["Cloudflare Access"]
    D --> B
    B --> E["D1 Database"]
    B -->|issue 起票| F["GitHub Issues"]
```

## ドキュメント

| ドキュメント | 内容 |
|---|---|
| [docs/overview.md](docs/overview.md) | 背景・動機・ユーザーフロー・スコープ |
| [docs/architecture.md](docs/architecture.md) | 技術スタック・システム構成・認証・リクエストフロー・リポジトリ構成 |
| [docs/database.md](docs/database.md) | テーブル設計・ER 図・マイグレーション方針 |
| [docs/mcp-server.md](docs/mcp-server.md) | MCP ツール仕様・エンドポイント・各クライアントの接続手順 |
| [docs/web-ui.md](docs/web-ui.md) | Web UI 画面設計・SSR 構成・htmx による部分更新 |
| [docs/deployment.md](docs/deployment.md) | デプロイ手順・Cloudflare 設定・環境変数・CI/CD |
| [docs/development.md](docs/development.md) | ローカル開発・テスト・lint・issue 駆動開発フロー |
| [docs/roadmap.md](docs/roadmap.md) | フェーズ計画・将来の拡張構想 |

## クイックスタート

> 実装完了後に有効になる手順です。

```bash
git clone https://github.com/japan4415/training-logger.git
cd training-logger
pnpm install
pnpm run dev   # wrangler dev でローカル起動
```

ローカル D1 のセットアップ:

```bash
wrangler d1 migrations apply training-logger-db --local
```

## MCP 接続

本システムは MCP（Model Context Protocol）サーバとして動作し、3 種類のクライアントから接続できます。

| クライアント | 接続方式 |
|---|---|
| ChatGPT | Developer Mode Connector（remote HTTPS、認証なし） |
| claude.ai | Custom Connector（remote HTTPS、認証なし） |
| Claude Desktop | mcp-remote ブリッジ経由 |

詳細な接続手順は [docs/mcp-server.md](docs/mcp-server.md) を参照してください。

## 開発フロー

issue 駆動開発を採用しています。

1. 改善要望はチャットから `create_feedback` ツールで issue 化
2. issue を元に feature ブランチで実装
3. PR 作成 → CI 通過 → merge で自動デプロイ

詳細は [docs/development.md](docs/development.md) を参照してください。
