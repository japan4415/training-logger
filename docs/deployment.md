# デプロイ

## Cloudflare リソース一覧

| リソース | 名前 | 用途 |
|----------|------|------|
| Worker | `training-logger` | 単一 Worker で MCP + REST API + SSR + Workers Assets を統合配信 |
| D1 Database | `training-logger-db` | 本番データベース。ローカル開発は `wrangler dev` の自動ローカル D1 を使用 |
| R2 Bucket | `training-logger-photos` | セッション写真の画像本体を保存。Standard storage class |
| KV Namespace | `OAUTH_KV` | OAuth 2.1 の client / grant / token を保存。`wrangler kv namespace create` の実 id を `wrangler.jsonc` に入れる（手順 5） |
| Cloudflare Access | custom domain のアプリケーション | ホスト全体を deny-by-default で保護する。`/mcp`・OAuth エンドポイント・`/.well-known/*` を Bypass、`/authorize` は Allow 側で `aud` をそろえる（手順 6） |

## wrangler.jsonc

```jsonc
{
  "name": "training-logger",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-01",
  // global_fetch_strictly_public は CIMD（Client ID Metadata Document）取得の SSRF 対策。
  // CIMD の取得が使う fetch の cache option に互換日付 2024-11-11 以降が必要。
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
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
      "database_id": "fed11dc7-680c-4245-a3db-95e73f4ddebe",
      "migrations_dir": "migrations"
    }
  ],
  "r2_buckets": [
    {
      "binding": "PHOTOS",
      "bucket_name": "training-logger-photos"
    }
  ],
  // OAuth 2.1 の grant / token / client を保存する KV。
  // 実 id は `wrangler kv namespace create OAUTH_KV` の出力で置き換える（手順 5）。
  "kv_namespaces": [
    {
      "binding": "OAUTH_KV",
      "id": "<OAUTH_KV の namespace id>"
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

`workers_dev: false` により `https://<worker>.<account>.workers.dev` は無効化済みで、配信経路は custom domain のみに限定する。Cloudflare Access を設定するとホスト全体を deny-by-default で保護でき、Worker 側にも同じ方針の認証ミドルウェアがある。`ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` が未設定の場合、公開パス以外は 401 `access_not_configured` を返す（fail-closed）。`OAUTH_KV` の id が未置換だとデプロイできない。

## 初期構築手順

> **`main` へのマージで自動デプロイされる点に注意**: CD は `main` への push を検知して自動デプロイする（末尾の「CI/CD」節を参照）。手順 3〜7（KV の id 反映・`0005` の本番適用・シークレット・Access ポリシー・オーナーの紐付け）は**すべて PR のマージ前に**終えておく。KV の id が未置換のまま、または `0005` 未適用・オーナー未紐付けでマージすると、デプロイが失敗するかオーナーが `403 user_not_registered` でロックアウトする。

### 1. D1 データベースの作成

```bash
pnpm exec wrangler d1 create training-logger-db
```

出力される `database_id` を `wrangler.jsonc` の `d1_databases[].database_id` に反映する。本番環境では上記コードブロックの `fed11dc7-680c-4245-a3db-95e73f4ddebe` を設定済み。

### 2. R2 バケットの作成

```bash
pnpm exec wrangler r2 bucket create training-logger-photos
```

作成したバケットは `wrangler.jsonc` の `r2_buckets` で `PHOTOS` binding に割り当てる。ローカルの `wrangler dev` では R2 binding もローカルストレージとしてエミュレートされるため、本番バケットへ書き込まない。

### 3. KV namespace の作成（OAuth 2.1 用）

OAuth 2.1 の client / grant / token を保存する KV namespace を作成する。

```bash
pnpm exec wrangler kv namespace create OAUTH_KV
```

出力される `id` を `wrangler.jsonc` の `kv_namespaces[].id` に反映する。未置換のプレースホルダのままではデプロイできない。`wrangler dev` ではローカル KV がエミュレートされる。

### 4. マイグレーションの適用

```bash
pnpm exec wrangler d1 migrations apply training-logger-db --remote
```

DB 変更を含む場合は **migration を先に適用してから Worker をデプロイする**（新コードが新スキーマを前提にするため）。`0005_users_and_user_id.sql` は 4 テーブルを再構築するため、必ず [migrations/README.md の「0005 の本番適用手順」](../migrations/README.md#0005-の本番適用手順)（退避 → ローカルリハーサル → 本番適用 → 件数・FK・採番位置の確認）に従う。

### 5. シークレット・構成値の設定

#### GitHub トークン（MCP create_feedback 用）

MCP 経由の Issue 起票（`create_feedback`）を利用するため、GitHub の Fine-grained Personal Access Token（権限: `Issues: Read and write`）を発行し、Wrangler secret として登録する。

```bash
pnpm exec wrangler secret put GITHUB_TOKEN
```

※ 登録先リポジトリを変更したい場合は、環境変数 `GITHUB_REPO_OWNER` / `GITHUB_REPO_NAME` を指定する（未設定時は既定値 `japan4415` / `training-logger`）。

#### Access / OAuth の構成値

Zero Trust の Access application 画面から **Application Audience (AUD) Tag** を取得し、team domain とともに設定する。`ACCESS_TEAM_DOMAIN` は `example.cloudflareaccess.com` のようにスキームを含めない。`OAUTH_CONSENT_SECRET` は同意画面の CSRF トークンに使う HMAC 鍵で、未設定だと同意フロー（`/authorize`）が 503 で fail-closed になる（必須）。

```bash
pnpm exec wrangler secret put ACCESS_TEAM_DOMAIN
pnpm exec wrangler secret put ACCESS_AUD
pnpm exec wrangler secret put OAUTH_CONSENT_SECRET
```

`OAUTH_CONSENT_SECRET` は十分な長さのランダム値を投入し、実値をコード・docs・PR に書かない。リポジトリへ値を保存したくない他の構成値も secret で設定できる。

#### 任意の構成値

| 変数 | 既定 | 用途 |
|---|---|---|
| `OAUTH_DCR_ENABLED` | 無効 | `"1"` で DCR（`/oauth/register`）を有効化。公開する場合は Rate Limiting / WAF を掛ける |
| `OAUTH_ALLOWED_REDIRECT_HOSTS` | `chatgpt.com,claude.ai,claude.com` | redirect_uri / CIMD client_id のホスト許可リスト（カンマ区切り） |

平文で問題ない値は `wrangler.jsonc` の `vars` に置いてもよい。

```jsonc
"vars": {
  "ACCESS_TEAM_DOMAIN": "example.cloudflareaccess.com",
  "ACCESS_AUD": "<Access application の AUD タグ>"
}
```

### 6. Cloudflare Access の設定

Zero Trust で custom domain を対象とした Self-hosted application を作成し、ホスト全体を **Allow（deny-by-default）** にする。認証は 1 つの Access application にまとめ、`/authorize` が受け取る JWT の `aud` が `ACCESS_AUD` と一致するようにする。パスごとの Bypass は次だけにする。

| パス | ポリシー | 理由 |
|---|---|---|
| `/mcp` | Bypass | OAuth access token で Worker 側が認証する（OAuth の Bearer リクエストは Access のリダイレクトを受けられない） |
| `/oauth/token` | Bypass | MCP クライアントが直接トークン交換する |
| `/oauth/register` | 使う場合のみ Bypass | DCR を有効化したときだけ |
| `/.well-known/*` | Bypass | AS metadata / protected resource metadata（RFC 8414 / 9728）の discovery |
| `/skills/*` | 必要な場合のみ Bypass | claude.ai などへ Skill zip を直接配布する場合 |
| `/authorize` | Allow | 同意画面は Access ログイン済みユーザーに限定する。アクセスを 1 アプリに統一し `aud` をそろえる |
| それ以外（`/`・`/sessions/*`・`/api/*`・`/exercises*` など） | Allow | データを返す全経路を保護する |

> **適用範囲は実測で確認する**: Access のダッシュボード上の設定と、実際に未ログインで到達できるパスが一致するか確認する。Bypass にしたパス（`/mcp`・`/oauth/token`・`/.well-known/*`）は未認証で 401 や metadata を返し、Protect 対象は Access のログインにリダイレクトされることを、シークレットウィンドウや別ブラウザで実測する。想定と差があれば #66 とは別に先行して是正する。

`ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` のどちらかでも未設定なら、公開パス以外は（開発フォールバックを除き）401 `access_not_configured` で fail-closed になる。書き込み系（GET / HEAD / OPTIONS 以外）は認証前に `Sec-Fetch-Site` を検査するため、ヘッダーが無い、または `same-origin` / `none` 以外の場合は設定の有無にかかわらず 403 `csrf_forbidden` を返す。

### 7. ユーザーの投入

利用は招待制で、自由登録は提供しない。アクセス制御は 2 つを揃える: (a) Cloudflare Access の Allow ポリシーに載せる、(b) `user_identities` に対応行を入れる。実 `sub` / email の値は docs・コード・PR に書かない（投入は運用で行う）。

1. **オーナー（`users.id = 1`）の紐付け**: migration `0005` が `users.id = 1`（`role = 'owner'`）を作成する。オーナーの Access `sub` を `user_identities`（`provider = 'cloudflare-access'`）に投入して解決できるようにする。`subject` を確定できない場合は、後に email 招待行で紐付ける。
2. **メンバーの追加**: 新しい利用者には `users` 行（`role = 'member'`）と、`user_identities` の招待行（`subject` を NULL にした `email` のみ）を投入する。初回ログイン時に検証済み email が一致したときだけ `subject` が確定する。**招待行の email 紐付けは、検証済み email を返す IdP に限定する**（Access の email を信頼する）。
3. **`sub` が変わったときの付け替え**: Cloudflare 公式定義では `sub` は組織から削除→再追加で別の値になる。該当行の `subject` を新しい値へ更新する（`(provider, subject)` は一意）。email 招待行が残っていれば初回と同じ経路でも再紐付けできる。

> 当面の利用者はオーナー 1 人を既定とする（`users.id = 1` がオーナー）。複数人にする場合も手順 2 でメンバーを足すだけで、コード変更は不要。

### 8. デプロイ

```bash
pnpm exec wrangler deploy
```

`pnpm exec wrangler versions deploy` を使用する場合、secret や KV binding を追加した後は、対象バージョンの binding に新しい値が含まれることを確認してからデプロイする。古いバージョンをそのまま指定すると、追加した Access 設定や `OAUTH_KV` が反映されず 401 や OAuth エラーになる。

PR を `main` にマージすると Workers Builds が自動でビルド・デプロイするため、この手順は「手動で先に反映して確認する」ためのものである。マージで反映する場合も、手順 3〜7（KV の id 反映・`0005` の本番適用・シークレット・Access ポリシー・オーナーの紐付け）をマージ前に終えておく。

### 9. 疎通確認

以下を確認する:

- `GET /health` が 200 を返す
- `GET /.well-known/oauth-authorization-server` と `GET /.well-known/oauth-protected-resource/mcp` が 200 を返す
- 未認証の `POST /mcp` が 401 と `WWW-Authenticate: Bearer resource_metadata="..."` を返す（トークン無しの `initialize` は通らない）
- ブラウザで `/` にアクセスすると Access のログインを経て Web UI が表示される
- 未認証・未ログインでデータ経路（`/`・`/api/*` など）にアクセスすると Access 側または Worker で拒否される
- ログイン後、写真の追加・取得・削除ができる
- MCP クライアントから接続し、ブラウザで `/authorize` の同意を経て `/mcp` のツールが動く（ユーザーのデータだけが返る・他のユーザーのデータは 404 になる）

## 環境

本番環境（production）のみ運用する。個人利用のため preview 環境を設ける利益が薄い。

- **本番**: `pnpm exec wrangler deploy` でデプロイ。D1 は `training-logger-db`（リモート）。シークレットは `pnpm exec wrangler secret put` で設定
- **ローカル開発**: `wrangler dev` で起動。D1・R2・KV binding はローカルでエミュレートされる。マイグレーション適用は `pnpm exec wrangler d1 migrations apply training-logger-db --local`。Web / REST の動作確認では `.dev.vars` に `PHOTO_UPLOAD_ALLOW_UNAUTHENTICATED=1` を設定する（未設定だと認証必須のパスは 401 `access_not_configured`）。このフラグはリクエスト先 Host が `localhost` または `127.0.0.1`（ポート付き可）の場合だけ有効で、それ以外では無視して 401 を返す。本番ではこの変数を設定しない。書き込み系リクエストは `Sec-Fetch-Site` が `same-origin` または `none` の場合だけ受け付け、ヘッダー欠如時も 403 を返す。その他のシークレットや環境変数も `.dev.vars`（`.dev.vars.example` 参照）に設定する

## ユーザーの無効化とトークン失効

Access の Allow ポリシーが効くのは `/authorize` の時点だけで、発行済みの MCP access token は TTL（1 時間）まで有効、refresh token（grant）は 30 日有効である。そのためユーザーを外すときは次を順に行う。

1. **即時拒否**: `users.status` を `'disabled'` に更新する。`apiHandler` が毎リクエスト `users.status` を D1 で照会し、`active` 以外なら 401 `account_inactive` を返す。Web 側も `resolveAccessIdentity` が `disabled` を 403 で拒否する。
2. **grant の手動失効（任意）**: `src/oauth/revocation.ts` の `revokeAllGrantsForUser` は意図した実装だが、**運用向けの管理エントリポイント（route / script / CLI）には未接続**で、現状はテストからしか呼ばれていない。grant を消したい場合は `OAUTH_KV` から該当ユーザーのキーを手動で削除する（ライブラリのキー形式は `grant:<userId>:<grantId>` と `token:<userId>:<grantId>:<tokenId>`）。

   ```bash
   pnpm exec wrangler kv key list --binding OAUTH_KV --remote --prefix "grant:<userId>:"
   pnpm exec wrangler kv key list --binding OAUTH_KV --remote --prefix "token:<userId>:"
   # 出力されたキーを 1 件ずつ削除する
   pnpm exec wrangler kv key delete --binding OAUTH_KV --remote "grant:<userId>:<grantId>"
   ```

   1 の `users.status = 'disabled'` だけで `/mcp` は毎リクエスト直ちに 401 になるため、この操作の目的は 30 日残る refresh token を確実に無効化することにある（失効漏れがあっても `apiHandler` の status 検査で 401 のままである）。管理者向けの一括失効エントリポイントは別途実装する。
3. **Access から外す**: Zero Trust の Allow ポリシーから対象を削除し、以後のログイン・同意を止める。

> Authorization ヘッダーや access token はログに出さない（`observability` の `head_sampling_rate: 1` で収集されるため特に注意する）。

## コネクタの再追加（認証方式の切り替え後）

`/mcp` が認証必須になったため、既存コネクタはそのままでは動かない。エンドポイント URL は `https://training-logger.discord.jp/mcp`（末尾スラッシュなし）を使う。

- **claude.ai**: 既存コネクタは編集できないため、いったん削除して同じ URL で登録し直す。認証は OAuth。
- **ChatGPT**: Developer Mode で接続を作り直し（再認可）、認証は OAuth を選ぶ。
- **Claude Desktop**: コネクタを登録し直すか、mcp-remote ブリッジの設定を更新して再認可する。

いずれも接続時にブラウザで `/authorize` が開く。Cloudflare Access にログインし、同意画面で要求 scope を確認して許可する。

## ロールバック

切替期間は設けず一気に閉じる前提のため、問題時は Worker のバージョンを戻す。Cloudflare ダッシュボードの Workers のデプロイ履歴から直前の正常なバージョンを選んでロールバックする。DB マイグレーション（`0005`）は適用済みのまま残る（`0005` は後方互換のため `user_id DEFAULT 1` を残しており、旧コードの INSERT も動く）。DB のデータ異常時は Time Travel の復元点へ restore する（[バックアップ](#バックアップ)参照）。

## 実機 PoC チェックリスト（Phase 0）

本番適用の前に、次が成立するかを実機で確認する。不成立なら方式を見直す。

- [ ] `/authorize` を Cloudflare Access の背後（Allow）に置いた構成で、ChatGPT / claude.ai からの認可フローが最後まで通る
- [ ] CIMD（`client_id` がメタデータ URL）で接続できる。DCR が必要かを判断する（両方が CIMD で通るなら DCR は無効のままにする）
- [ ] redirect_uri のホストを確定し、`OAUTH_ALLOWED_REDIRECT_HOSTS` を実測値に合わせる
- [ ] PKCE (S256)・`resource`（`.../mcp`）・refresh rotation が期待どおり動く
- [ ] 未認証の `/mcp` が 401 + `WWW-Authenticate`（`resource_metadata`）を返し、クライアントが discovery に進める

**成立しない場合の次点**: まず「Access for SaaS（OIDC）」を上流 IdP にする方式へ切り替える。OIDC の `sub` と self-hosted Access JWT の `sub` が一致するかは未確認のため、`user_identities.provider` を分けるか email 照合で紐付ける余地を残す。それも不可なら Cloudflare Access の「MCP server application」+ Managed OAuth を検討する（実機検証が前提）。

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
      - uses: actions/checkout@v7

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

Cloudflare ダッシュボードで GitHub リポジトリを連携すると、`main` への push を検知して自動的にビルド・デプロイが行われる。現行のWorkers Builds設定はD1マイグレーションを自動適用しない。DB変更を含むPRでは、本番の `pnpm exec wrangler d1 migrations apply training-logger-db --remote` をデプロイ前に実行し、適用履歴を確認する（[運用手順](../migrations/README.md)）。ビルド成功だけではDB移行の完了を意味しない。

## バックアップ

### Cloudflare Time Travel

D1 は Cloudflare 側で Time Travel（ポイントインタイム復元）機能を提供している。意図しないデータ変更が発生した場合、指定した時点の状態に復元できる。

### 手動エクスポート

月次で手動エクスポートを推奨する:

```bash
pnpm exec wrangler d1 export training-logger-db --remote --output=backup-YYYYMMDD.sql
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
