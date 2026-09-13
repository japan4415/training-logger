# MCP サーバ設計

training-logger の MCP (Model Context Protocol) サーバ設計について記述する。

## 概要

MCP は LLM アプリケーションが外部ツール・データソースに標準化された方法でアクセスするためのオープンプロトコルである。本システムでは、ChatGPT や Claude などの LLM が筋トレ記録を構造化して呼び出すためのインターフェースとして MCP サーバを実装する。ユーザーは自然言語で「今日はシーテッドロウ 16kg 15回2セットやった」と伝えるだけで、LLM がツールを呼び出してデータベースに記録する。

### プロトコル

- MCP プロトコルバージョン: `2025-11-25`（現行安定版）
- トランスポート: Streamable HTTP
- 実装方式: ステートレス（リクエストごとに `McpServer` をインスタンス化）

### SDK

- `@modelcontextprotocol/sdk` v1.30.x
- 入力バリデーション: Zod

### 実装

Hono ルート `POST /mcp` で JSON-RPC リクエストを受け付ける。処理する JSON-RPC メソッド:

- `initialize` -- クライアントとのハンドシェイク
- `tools/list` -- 利用可能なツール一覧の返却
- `tools/call` -- ツールの実行

**GET リクエストには 405 Method Not Allowed を返す**。本サーバは SSE ストリームを提供しないステートレス実装であり、Streamable HTTP 仕様に基づきサーバは GET に対して 405 を返してよい。

## ツール定義

本サーバは 10 のツールを提供する（記録系 6 + セッション写真 1 + Atlas 筋肉管理 2 + 機能リクエスト 1）。以下、各ツールの説明文（LLM が読む文言）、入力スキーマ、挙動、エラー応答を記述する。

### search_exercises

登録済み種目の検索。

**説明文** (LLM 向け):

> 登録済みの筋トレ種目を検索します。名前の部分一致、カテゴリで絞り込めます。新しい種目を登録する前に、既存の種目がないか必ず確認してください。

**入力スキーマ**:

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "名前・別名の部分一致検索キーワード"
    },
    "category": {
      "type": "string",
      "enum": ["strength", "cardio", "flexibility", "other"],
      "description": "カテゴリでの絞り込み"
    }
  }
}
```

両方省略で全件取得。

**挙動**:

1. `exercises` テーブルと `exercise_aliases` テーブルを JOIN し、`query` を LIKE で部分一致検索する
2. `category` が指定されていれば AND 条件で絞り込む
3. 結果を以下の形式で返す:

```json
{
  "exercises": [
    {
      "id": 1,
      "name": "カイザーチェストプレス",
      "category": "strength",
      "equipment": "カイザー空圧マシン",
      "target_muscles": null,
      "aliases": ["Keiser Chest Press", "カイザーCP"]
    }
  ]
}
```

**エラー応答**:

- 0 件の場合は空配列 `{"exercises": []}` を返す（エラーにしない）

### register_exercise

種目の新規登録。

**説明文** (LLM 向け):

> 新しい筋トレ種目をマスタに登録します。重複を避けるため、必ず先に search_exercises で既存種目を確認してください。

**入力スキーマ**:

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "description": "種目の正規名称"
    },
    "category": {
      "type": "string",
      "enum": ["strength", "cardio", "flexibility", "other"],
      "default": "strength",
      "description": "カテゴリ"
    },
    "equipment": {
      "type": "string",
      "description": "使用器具"
    },
    "target_muscles": {
      "type": "string",
      "description": "対象部位"
    },
    "aliases": {
      "type": "array",
      "items": { "type": "string" },
      "description": "別名の配列"
    }
  },
  "required": ["name"]
}
```

**挙動**:

1. `exercises` テーブルに INSERT する
2. `aliases` が指定されていれば `exercise_aliases` テーブルにも INSERT する
3. 登録した種目の情報を返す

**エラー応答**:

- `name` または `alias` が既存の種目名・別名と重複する場合、既存種目の情報を含むエラーを返す（「この種目のことですか?」と LLM がユーザーに提示できるようにする）

### log_workout

1 日分のワークアウト記録。6 ツールの中核となるツール。

**説明文** (LLM 向け):

> 1日分のワークアウトを記録します。複数の種目とセット情報をまとめて登録できます。同じ日に既にセッションがある場合は種目を追加します。種目名は正式名称・別名のどちらでも指定でき、未登録の種目は自動登録されます。

**入力スキーマ**:

```json
{
  "type": "object",
  "properties": {
    "date": {
      "type": "string",
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
      "description": "セッション日付 (YYYY-MM-DD)。省略時は今日 (Asia/Tokyo)"
    },
    "goal": {
      "type": "string",
      "description": "目的 (例: ダイエット)"
    },
    "body_condition": {
      "type": "string",
      "description": "体調・怪我メモ"
    },
    "session_notes": {
      "type": "string",
      "description": "セッション全体のメモ"
    },
    "exercises": {
      "type": "array",
      "description": "種目とセット情報の配列",
      "items": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "description": "種目名 (正規名または別名)"
          },
          "equipment_note": {
            "type": "string",
            "description": "この実施での器具メモ"
          },
          "form_cues": {
            "type": "string",
            "description": "フォームキュー (改行区切りで複数指定可)"
          },
          "notes": {
            "type": "string",
            "description": "メモ"
          },
          "sets": {
            "type": "array",
            "description": "セット情報の配列",
            "items": {
              "type": "object",
              "properties": {
                "reps": {
                  "type": "integer",
                  "description": "回数"
                },
                "weight": {
                  "type": "number",
                  "description": "重量またはレベル値"
                },
                "weight_unit": {
                  "type": "string",
                  "enum": ["kg", "lbs", "level"],
                  "description": "重量の単位"
                },
                "duration_minutes": {
                  "type": "number",
                  "description": "時間 (分)"
                },
                "distance_km": {
                  "type": "number",
                  "description": "距離 (km)"
                },
                "speed_min": {
                  "type": "number",
                  "description": "速度下限 (km/h)"
                },
                "speed_max": {
                  "type": "number",
                  "description": "速度上限 (km/h)"
                },
                "incline_percent": {
                  "type": "number",
                  "description": "傾斜 (%)"
                },
                "angle_degrees": {
                  "type": "number",
                  "description": "角度 (度)"
                },
                "is_planned": {
                  "type": "boolean",
                  "default": false,
                  "description": "true=計画, false=実績"
                },
                "notes": {
                  "type": "string",
                  "description": "セットのメモ"
                }
              }
            }
          }
        },
        "required": ["name"]
      }
    }
  },
  "required": ["exercises"]
}
```

**挙動**:

1. `date` が省略された場合、Asia/Tokyo の今日の日付を使用する。Cloudflare Workers のランタイムは UTC のため、`new Date().toISOString()` から日付を切り出すと日本時間の午前 0〜9 時に前日扱いになる。既定日付は必ず `new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date())` で YYYY-MM-DD 形式の Asia/Tokyo 日付を導出すること
2. `workout_sessions` テーブルを日付で upsert する（既存セッションがあれば `goal` / `body_condition` / `session_notes` を更新、なければ INSERT）
3. 既存セッションへの追加時は `display_order` を既存最大値 + 1 から採番する
4. 各種目の名前を以下の順序で解決する:
   - `exercises.name` の完全一致 (COLLATE NOCASE)
   - `exercise_aliases.alias` の完全一致 (COLLATE NOCASE)
   - `exercises.name` / `exercise_aliases.alias` の部分一致 (LIKE)
   - いずれにもヒットしない場合は自動登録する（`duration_minutes` や `speed_min`/`speed_max` があれば `cardio`、なければ `strength` と推測）
5. `session_exercises` と `sets` を INSERT する。`sets.set_order` は `is_planned` の値（0=実績 / 1=計画）ごとに独立して 1 から連番を付与する（[database.md](./database.md) の計画 vs 実績セクション参照）
6. サマリーを返す（日付、登録種目数、セット数、自動登録された種目名）

**重複対策**:

同日に再度呼び出された場合は既存セッションに**追記**する（上書きしない）。既存記録の修正には `update_workout` を使用する。

### update_workout

記録の修正。

**説明文** (LLM 向け):

> ワークアウトの記録を修正します。日付と種目を指定して、器具メモ・フォームキュー・ステータス・セット情報を更新できます。

**入力スキーマ**:

```json
{
  "type": "object",
  "properties": {
    "date": {
      "type": "string",
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
      "description": "セッション日付 (YYYY-MM-DD)"
    },
    "session_exercise_id": {
      "type": "integer",
      "description": "種目実施 ID (直接指定する場合)"
    },
    "exercise_name": {
      "type": "string",
      "description": "種目名で対象を指定する場合"
    },
    "exercise_order": {
      "type": "integer",
      "description": "同日に同名種目が複数ある場合の何番目か (1-based)"
    },
    "equipment_note": {
      "type": "string",
      "description": "器具メモの更新値"
    },
    "form_cues": {
      "type": "string",
      "description": "フォームキューの更新値"
    },
    "status": {
      "type": "string",
      "enum": ["planned", "completed", "skipped"],
      "description": "ステータスの更新値"
    },
    "notes": {
      "type": "string",
      "description": "メモの更新値"
    },
    "sets": {
      "type": "array",
      "description": "セット情報の更新値。指定時は既存セットを全削除して差し替え",
      "items": {
        "type": "object",
        "properties": {
          "reps": { "type": "integer" },
          "weight": { "type": "number" },
          "weight_unit": { "type": "string", "enum": ["kg", "lbs", "level"] },
          "duration_minutes": { "type": "number" },
          "distance_km": { "type": "number" },
          "speed_min": { "type": "number" },
          "speed_max": { "type": "number" },
          "incline_percent": { "type": "number" },
          "angle_degrees": { "type": "number" },
          "is_planned": { "type": "boolean", "default": false },
          "notes": { "type": "string" }
        }
      }
    }
  },
  "required": ["date"]
}
```

**挙動**:

1. 対象の特定: `session_exercise_id` が指定されていればそれを使用、なければ `date` + `exercise_name` で検索する
2. 同日に同名種目が複数ある場合、`exercise_order` で何番目かを指定する
3. 指定されたフィールドのみを更新する（未指定フィールドは変更しない）
4. `sets` が指定された場合、既存のセットを**全削除**して新しいセットに差し替える

**エラー応答**:

- 指定した日付にセッションが存在しない -> 404 相当のエラー
- 指定した種目名が見つからない -> 404 相当のエラー
- 同名種目が複数あり `exercise_order` が未指定 -> 候補一覧を返して選択を促す

### delete_workout

記録の削除。

**説明文** (LLM 向け):

> ワークアウトの記録を削除します。特定の種目だけを削除するか、セッション全体を削除できます。

**入力スキーマ**:

```json
{
  "type": "object",
  "properties": {
    "date": {
      "type": "string",
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
      "description": "セッション日付 (YYYY-MM-DD)"
    },
    "session_exercise_id": {
      "type": "integer",
      "description": "種目実施 ID (直接指定する場合)"
    },
    "exercise_name": {
      "type": "string",
      "description": "種目名で対象を指定する場合"
    },
    "exercise_order": {
      "type": "integer",
      "description": "同日に同名種目が複数ある場合の何番目か (1-based)"
    },
    "delete_entire_session": {
      "type": "boolean",
      "default": false,
      "description": "true の場合、セッション全体を削除する"
    }
  },
  "required": ["date"]
}
```

**挙動**:

- `delete_entire_session = true` の場合: 写真本体を R2 から削除してから `workout_sessions` を DELETE する。CASCADE により配下の `session_photos`、`session_exercises`、`sets` も削除される
- `delete_entire_session = false` の場合: 指定した `session_exercises` を DELETE する。CASCADE により配下の `sets` も削除される

**エラー応答**:

- `update_workout` と同様の対象特定エラー
- R2 の写真削除に失敗した場合はセッションを削除せず、写真削除の再試行を促すエラー

### get_history

履歴照会。

**説明文** (LLM 向け):

> 過去のワークアウト履歴を照会します。特定種目の前回の重量・回数の確認、期間指定の一覧、最近のセッション一覧に使えます。

**入力スキーマ**:

```json
{
  "type": "object",
  "properties": {
    "exercise_name": {
      "type": "string",
      "description": "種目名で絞り込み (正規名・別名どちらでも可)"
    },
    "date_from": {
      "type": "string",
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
      "description": "検索開始日 (YYYY-MM-DD)"
    },
    "date_to": {
      "type": "string",
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
      "description": "検索終了日 (YYYY-MM-DD)"
    },
    "last_n_sessions": {
      "type": "integer",
      "default": 5,
      "description": "取得するセッション数の上限"
    },
    "include_sets": {
      "type": "boolean",
      "default": true,
      "description": "セット詳細を含めるか"
    }
  }
}
```

**挙動**:

- **種目指定**: その種目の履歴をセット付きで返す。「前回のシーテッドロウ何 kg?」のような質問に回答できる
- **期間指定**: 範囲内のセッション一覧を返す
- **無指定**: 最新 5 セッション（`last_n_sessions` のデフォルト値）の概要を返す
- `include_sets = false` の場合、セット詳細を省略してセッションと種目名のみを返す（一覧表示用）

**エラー応答**:

- 該当データなしの場合は空の結果を返す（エラーにしない）

### create_photo_upload_link

登録済みワークアウトへノート写真を追加するため、ブラウザのアップロード画面へのリンクを返す。

**説明文** (LLM 向け):

> ワークアウト記録に使った写真を保存するためのアップロード画面のリンクを返します。写真は MCP 経由では送れないため、ユーザーにこのリンクを案内してください

**入力スキーマ**:

```json
{
  "type": "object",
  "properties": {
    "date": {
      "type": "string",
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
      "description": "セッション日付 (YYYY-MM-DD)"
    }
  },
  "required": ["date"]
}
```

**挙動**:

1. `date` で `workout_sessions` を検索する
2. セッションがあれば、`session_id`、`date`、`https://training-logger.discord.jp/sessions/{session_id}#photos`、上限情報を返す
3. ユーザーには返された URL をブラウザで開き、写真セクションから同じ写真を選ぶよう案内する

```json
{
  "session_id": 42,
  "date": "2026-08-16",
  "url": "https://training-logger.discord.jp/sessions/42#photos",
  "max_photos": 4,
  "max_bytes": 10485760,
  "allowed_types": ["image/jpeg", "image/png", "image/webp"],
  "note": "ブラウザで開き、写真セクションから同じ写真を選んでアップロードしてください"
}
```

**エラー応答**:

- 指定日のセッションがない場合は `isError: true` と「先に `log_workout` で登録してください」を返す
- `date` の形式が不正な場合は MCP の入力バリデーションエラーを返す

### create_feedback

training-logger への機能要望・不具合報告・種目追加要望を GitHub issue として起票。

**説明文** (LLM 向け):

> training-logger への機能要望・不具合報告・種目追加要望を GitHub issue として起票します。ツールのスキーマで表現できない単位や項目に遭遇したとき、ユーザーの同意を得てから使ってください。

**入力スキーマ**:

```json
{
  "type": "object",
  "properties": {
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200,
      "description": "Issue のタイトル（1〜200文字）"
    },
    "body": {
      "type": "string",
      "minLength": 1,
      "description": "Issue の本文（要望・不具合・種目追加の詳細）"
    },
    "category": {
      "type": "string",
      "enum": ["feature", "bug", "exercise_request", "other"],
      "default": "feature",
      "description": "フィードバックのカテゴリ"
    }
  },
  "required": ["title", "body"]
}
```

**挙動**:

1. `env.GITHUB_TOKEN` が未設定の場合、`isError: true` とともに事前入力済み URL `https://github.com/{owner}/{repo}/issues/new?title=<encoded>&body=<encoded>&labels=enhancement,from-mcp` を返し、LLM が手動起票を案内できるようにする。リポジトリは環境変数 `GITHUB_REPO_OWNER` / `GITHUB_REPO_NAME` で上書き可能（既定値: `japan4415` / `training-logger`）
2. `GET https://api.github.com/repos/{owner}/{repo}/issues?state=open&per_page=100&page=N` を `page=1` から順に呼び出し、返却件数が 100 未満になるまで（上限 10 ページ）走査する。返却要素のうち Pull Request（`pull_request` フィールドを持つ要素）を除外した上で、`title` が完全一致（trim 後）する open issue があれば新規起票せず `{ duplicate: true, issue_number, html_url, title }` を返す。上限 10 ページに達した場合は走査を打ち切り、それ以降の重複は検出しない
3. `POST https://api.github.com/repos/{owner}/{repo}/issues` を `fetch` で呼ぶ。ヘッダに `Accept: application/vnd.github+json`、`Authorization: Bearer <token>`、`X-GitHub-Api-Version: 2022-11-28`、`User-Agent: training-logger-mcp`、`Content-Type: application/json` を設定。本文末尾に `\n\n---\n起票元: training-logger MCP create_feedback (category: <category>)` を付加し、ラベルに `["enhancement", "from-mcp"]` を指定する
4. 201 成功時は `{ issue_number, html_url, title, state }` を返す

**エラー応答**:

- `GITHUB_TOKEN` 未設定時: `isError: true` でエラーメッセージと手動起票用の事前入力 URL を返す
- GitHub API エラー（401 / 403 / 422 / 5xx）: `isError: true` で HTTP ステータスコードと GitHub のエラーメッセージを含む LLM 向けメッセージを返す

## ツール設計の指針

### ツール設計と責務の分離

LLM のツール選択精度はツール数が増加するほど低下する。そのため本サーバではツールを必要最小限の 10 ツール（記録系 6 + セッション写真 1 + Atlas 筋肉管理 2 + 機能リクエスト 1）に整理している。日常的な筋トレ記録の CRUD（検索・登録・記録・更新・削除・照会）、登録後の写真アップロード画面の案内、Atlas 筋肉割当、およびスキーマで表現できない要望の issue 起票に絞り、明確な責務分離を行っている。

### 説明文の書き方

各ツールの説明文は LLM が読んでツール選択の判断材料にする。以下の方針で記述している:

- **使うべき場面**を明記する（例: get_history の「前回の重量・回数の確認」）
- **使う前の前提**を明記する（例: register_exercise の「必ず先に search_exercises で確認」）
- **ツール間の関係**を暗示する（例: log_workout の「未登録の種目は自動登録されます」）

### 1 日分まとめて登録できる設計の理由

`log_workout` は 1 回の呼び出しで複数種目・複数セットをまとめて登録できる。これはノートの写真を撮って「この記録を登録して」と指示するユースケースを想定している。種目ごとに個別のツール呼び出しが必要な設計では、1 セッション分の登録に 7~10 回のツール呼び出しが発生し、レイテンシとトークン消費が増大する。

### サーバーレベルの instructions

`McpServer` コンストラクタの `instructions` フィールド（MCP 仕様の `InitializeResult.instructions`）に、ツール横断の運用ルールを以下の 5 セクションでスリムに記述している:

1. **種目の登録** -- 新規登録前に `search_exercises` で日本語名・英語名の両方を検索して重複確認
2. **日時の扱い** -- すべて Asia/Tokyo。`date` 省略時は JST の今日。相対表現も JST で解釈
3. **記録の運用** -- 同日の `log_workout` 再呼び出しは追記。修正は `update_workout`、削除は `delete_workout`。ノート画像からの登録は、不明点を確認し下書きをユーザーに見せて承認を得てから `log_workout` を呼ぶ。ノート写真を保存したい場合は `log_workout` の後に `create_photo_upload_link` でリンクを案内する（画像本体は MCP では送れない。詳細な手順は Skill `log-workout` を参照）
4. **対応できない入力** -- スキーマで表現できない項目・単位に遭遇したらユーザーに伝え、同意を得て `create_feedback` で issue を起票する
5. **手書きノートの速記法** -- 「reps/weight」形式（例「20/10」= 20 回・重量 10）。複数並ぶ場合は各々を独立したセットとして扱う。単位不明なら `get_history` で前回を参照するかユーザーに確認

ノート画像からの詳細な登録手順は Skill（[docs/skill.md](./skill.md)）を参照のこと。

各ツールの `description` は個々のツールの用途・引数を説明する場であり、横断ルールまで繰り返すと冗長になるため、サーバーレベルの instructions で一元管理する。Claude の Skill（`claude_skill`）ではなく MCP ネイティブの `instructions` を採用したのは、ChatGPT を含むすべての MCP クライアントに配信でき、クライアント固有の設定に依存しないためである。

## 接続手順

MCP エンドポイント URL:

```
https://training-logger.discord.jp/mcp
```

カスタムドメインを設定済み。写真を保存する場合は、どの MCP クライアントでも記録後に `create_photo_upload_link` が返す URL をブラウザで開いてアップロードする。画像本体は MCP 経由では送信しない。

`POST /mcp` は JSON-RPC とツール結果だけを扱い、保存済み画像の本体は配信しない。画像本体の取得は `GET /api/sessions/:id/photos/:photoId`、ブラウザからの追加・削除は写真用 REST API を使用する。

### セキュリティ境界

`/mcp` は現在認証なしで公開しているが、写真本体を書き込むツールは提供しない。写真の保存は Access 保護下のブラウザ用 REST API だけで行う。

一方、ブラウザ経由の `POST /api/sessions/:id/photos` と `DELETE /api/sessions/:id/photos/:photoId` は `requireAccessUser` による Fetch Metadata の CSRF 検査と Cloudflare Access JWT 検証で保護する。Zero Trust では custom domain の `/mcp` だけを Bypass とし、`/sessions/*` と `/api/*` は Allow ポリシー配下に置く。Skill の公開配布 URL が必要な場合は `/skills/*` も限定的に Bypass できる。

`wrangler.jsonc` は `workers_dev: false` に設定済みであり、`*.workers.dev` URL は無効である。公開経路は Access を設定した custom domain のみとする。設定方法は [deployment.md](./deployment.md) を参照。

### ChatGPT

出典: https://developers.openai.com/api/docs/mcp

1. Settings -> Apps -> Advanced で **Developer mode** を有効化する
2. Settings -> Apps -> **Connectors** -> Create を選択する
3. URL にエンドポイント URL を入力し、Authentication は **None** を選択する
4. 保存する

**注意事項**:

- 書き込みツール（`log_workout`, `update_workout`, `delete_workout`, `register_exercise`）は通常チャットで利用可能（実行前に確認あり）
- Deep Research モードでは read-only（`search_exercises`, `get_history` のみ利用可能）
- モバイルアプリからの MCP コネクタ利用は非対応
- 添付画像の保存には `create_photo_upload_link` の URL をブラウザで開き、同じ画像を選択する

### claude.ai

出典: https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp

1. Settings -> **Connectors** -> Add custom connector を選択する
2. URL にエンドポイント URL を入力し、認証は **None** を選択する
3. 保存する

**注意事項**:

- Free プランでもカスタムコネクタを 1 個まで登録可能
- 添付画像の保存には `create_photo_upload_link` の URL をブラウザで開き、同じ画像を選択する

### Claude Desktop

2 つの接続方法がある。

#### 方法 A: リモートコネクタ（推奨）

1. Claude Desktop の Settings -> **Connectors** を開く
2. エンドポイント URL をカスタムコネクタとして登録する

添付画像の保存は `create_photo_upload_link` が返す URL をブラウザで開き、同じ画像を選択して行う。

#### 方法 B: mcp-remote ブリッジ

`claude_desktop_config.json` に以下を追加する:

```json
{
  "mcpServers": {
    "training-logger": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://training-logger.discord.jp/mcp"
      ]
    }
  }
}
```

出典: https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop

**注意**: `mcp-remote` は npm に公開されている実在のパッケージである。`@anthropic-ai/mcp-proxy` のような実在しないパッケージ名を使用しないこと。

## 利用例

### 例 1: 筋トレ記録の登録

**ユーザー**:
> 今日はシーテッドロウ 16kg 15回2セットやったよ

**LLM の処理**: `log_workout` を呼び出す

```json
{
  "exercises": [
    {
      "name": "シーテッドロウ",
      "sets": [
        { "reps": 15, "weight": 16, "weight_unit": "kg" },
        { "reps": 15, "weight": 16, "weight_unit": "kg" }
      ]
    }
  ]
}
```

**LLM の応答**:
> 記録しました! 今日のシーテッドロウ: 16kg x 15回 x 2セット。

### 例 2: 前回の記録確認

**ユーザー**:
> 前回のアダクター何ポンドだった?

**LLM の処理**: `get_history` を呼び出す

```json
{
  "exercise_name": "アダクター",
  "last_n_sessions": 1
}
```

**LLM の応答**:
> 前回 (8/16) のアダクターは 20回2セットで、1セット目 50 lbs、2セット目 45 lbs でした。

### 例 3: ノート写真からの一括登録

**ユーザー**:
> (ノートの写真を添付して) この記録を登録して

**LLM の処理**: 写真を読み取り、`log_workout` を呼び出す

```json
{
  "date": "2026-08-16",
  "goal": "ダイエット",
  "exercises": [
    {
      "name": "ウォーキング",
      "sets": [
        { "duration_minutes": 10, "speed_min": 3.5, "speed_max": 5.0, "incline_percent": 0.5 }
      ]
    },
    {
      "name": "ストレッチボード",
      "notes": "20度がちょうど",
      "sets": [
        { "angle_degrees": 20 }
      ]
    },
    {
      "name": "グッドモーニングEX",
      "equipment_note": "2kgバー",
      "sets": [
        { "reps": 15, "weight": 2, "weight_unit": "kg" },
        { "reps": 15, "weight": 2, "weight_unit": "kg" }
      ]
    },
    {
      "name": "アダクター",
      "sets": [
        { "reps": 20, "weight": 50, "weight_unit": "lbs" },
        { "reps": 20, "weight": 45, "weight_unit": "lbs" }
      ]
    },
    {
      "name": "アブダクター",
      "sets": [
        { "reps": 20, "weight": 50, "weight_unit": "lbs" },
        { "reps": 20, "weight": 45, "weight_unit": "lbs" }
      ]
    },
    {
      "name": "シーテッドロウ",
      "form_cues": "背中の空間をつぶす",
      "sets": [
        { "reps": 15, "weight": 16, "weight_unit": "kg" },
        { "reps": 15, "weight": 16, "weight_unit": "kg" }
      ]
    },
    {
      "name": "バタフライ",
      "sets": [
        { "reps": 15, "weight": 30, "weight_unit": "lbs" },
        { "reps": 15, "weight": 40, "weight_unit": "lbs" }
      ]
    },
    {
      "name": "レッグレイズ",
      "form_cues": "肩を上げない\n足を下げると浮く\n手首注意",
      "sets": [
        { "reps": 20, "is_planned": true },
        { "reps": 20, "is_planned": true },
        { "reps": 20, "is_planned": false },
        { "reps": 10, "is_planned": false },
        { "reps": 10, "is_planned": false }
      ]
    },
    {
      "name": "ウォーキング",
      "sets": [
        { "duration_minutes": 10, "speed_min": 4.0, "speed_max": 5.0, "incline_percent": 0.5 }
      ]
    }
  ]
}
```

**LLM の応答**:
> 8/16 の記録を登録しました! 9種目の実施記録（ウォーキング2回を含む）、計16セットを記録しています。レッグレイズは計画2セットに対して実績3セットも記録しました。

### 例 4: 登録に使ったノート写真の保存

ワークアウト登録が完了した後に、元の写真も保存するか確認する。承認前や登録前にはアップロードを促さない。

**LLM**:
> 2026-08-16 の記録を登録しました。元の写真も保存しますか?

**ユーザー**:
> お願いします

`create_photo_upload_link` を呼び出す。

```json
{
  "date": "2026-08-16"
}
```

**LLM の応答**:
> [写真セクション](https://training-logger.discord.jp/sessions/42#photos)をブラウザで開き、登録に使った写真を選んでアップロードしてください。JPEG / PNG / WebP、1 枚 10 MiB 以下、1 セッション 4 枚までです。

どのクライアントでも、ユーザーが保存を希望した場合に限り、返されたリンクをブラウザで開いてアップロードする。

### 例 5: スキーマで表現できない項目の要望起票（create_feedback）

**ユーザー**:
> 心拍数ゾーンごとの滞在時間も記録したいんだけど、入力できる?

**LLM の処理**: スキーマで対応していないことを説明し、ユーザーの同意を得てから `create_feedback` を呼び出す

```json
{
  "title": "有酸素運動における心拍数ゾーン滞在時間の記録サポート要望",
  "body": "ウォーキングやランニングの記録時に、心拍数ゾーン（ゾーン2など）の滞在時間を記録したいという要望です。現行スキーマでは時間・距離・速度・傾斜のみ対応しています。",
  "category": "feature"
}
```

**LLM の応答**:
> GitHub issue #58 を起票しました: [有酸素運動における心拍数ゾーン滞在時間の記録サポート要望](https://github.com/japan4415/training-logger/issues/58)
> 機能が追加されるまで、当面はセットのメモ欄（notes）に「ゾーン2: 15分」のように記録しておくことをお勧めします。

## Atlas筋肉の管理

`register_exercise` は任意の `atlas_muscles` を受け付ける。構造は `{primary: string[], secondary: string[], unavailable: string[]}`。primary/secondaryは配信済み筋肉ID（FJ形式と補完モデルのFMA形式）、unavailableはAtlas未収録の筋肉名。省略時は既知種目の初期プロファイルを採用し、明示NULLは従来の部位メモによる参考表示へ戻す。3配列が空のオブジェクトは対象筋なしの明示指定。

- `list_atlas_muscles(query?: string)`: ID・英語名・日本語名でカタログを検索し、`{id,name,label,groupLabel}` を返す。左右を含む正確なIDを確認してから割り当てる。筋肉の未収録を別筋で代用しない。
- `set_exercise_muscles(exercise_id: number, atlas_muscles: object | null)`: 種目の割当全体を置き換える。種目IDは正の整数。不明ID・不明筋肉IDはエラーとし、DBを変更しない。
- `search_exercises` / `register_exercise` のレスポンスに、デコード済み `atlas_muscles` を含む。

primary/secondaryはそれぞれ最大200件、unavailableは最大50件・名称100文字。primaryとsecondaryに重複するIDはprimaryを優先する。RESTの種目詳細・一覧も `atlas_muscles` を返す。セッションAPIは従来の `target_muscles_summary` に加え、完了種目の明示割当を集約した `atlas_muscles_summary` と各種目の `atlas_muscles` を返す。NULLの従来値は新しいID集約には含めない。
