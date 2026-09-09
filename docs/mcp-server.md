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

本サーバは 6 つのツールを提供する。以下、各ツールの説明文（LLM が読む文言）、入力スキーマ、挙動、エラー応答を記述する。

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

- `delete_entire_session = true` の場合: `workout_sessions` を DELETE する。CASCADE により配下の `session_exercises` と `sets` も削除される
- `delete_entire_session = false` の場合: 指定した `session_exercises` を DELETE する。CASCADE により配下の `sets` も削除される

**エラー応答**:

- `update_workout` と同様の対象特定エラー

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

## ツール設計の指針

### ツール数を 6 に絞った理由

LLM のツール選択精度はツール数が増えるほど低下する。日常的な筋トレ記録に必要な CRUD 操作（検索・登録・記録・更新・削除・照会）を必要最小限の 6 ツールに整理した。GitHub Issue の起票はチャットクライアント側の GitHub MCP コネクタや `gh` CLI で直接行う。

### 説明文の書き方

各ツールの説明文は LLM が読んでツール選択の判断材料にする。以下の方針で記述している:

- **使うべき場面**を明記する（例: get_history の「前回の重量・回数の確認」）
- **使う前の前提**を明記する（例: register_exercise の「必ず先に search_exercises で確認」）
- **ツール間の関係**を暗示する（例: log_workout の「未登録の種目は自動登録されます」）

### 1 日分まとめて登録できる設計の理由

`log_workout` は 1 回の呼び出しで複数種目・複数セットをまとめて登録できる。これはノートの写真を撮って「この記録を登録して」と指示するユースケースを想定している。種目ごとに個別のツール呼び出しが必要な設計では、1 セッション分の登録に 7~10 回のツール呼び出しが発生し、レイテンシとトークン消費が増大する。

### サーバーレベルの instructions

`McpServer` コンストラクタの `instructions` フィールド（MCP 仕様の `InitializeResult.instructions`）に、ツール横断の運用ルールを以下の 5 セクションで記述している:

1. **種目の登録** -- 新規登録前の重複確認（日本語名・英語名の両方で検索）
2. **日時の扱い** -- 全日付は Asia/Tokyo (JST) 基準。相対表現（「昨日」「先週月曜」等）も JST で解釈
3. **記録の運用** -- 同日の再呼び出しは追記（上書きではない）。修正は `update_workout`、削除は `delete_workout`
4. **対応できない入力** -- スキーマで表現できないパラメータに遭遇した場合の案内と issue 起票の誘導
5. **手書きノートの速記法** -- `reps/weight` 形式の速記（例: 「20/10」= 20回・重量10）の解釈ルール

各ツールの `description` は個々のツールの用途・引数を説明する場であり、横断ルールまで繰り返すと冗長になるため、サーバーレベルの instructions で一元管理する。Claude の Skill（`claude_skill`）ではなく MCP ネイティブの `instructions` を採用したのは、ChatGPT を含むすべての MCP クライアントに配信でき、クライアント固有の設定に依存しないためである。

## 接続手順

MCP エンドポイント URL:

```
https://training-logger.discord.jp/mcp
```

カスタムドメインを設定済み。`*.workers.dev` の URL（`https://<worker>.<account>.workers.dev/mcp`）も引き続き有効。

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

### claude.ai

出典: https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp

1. Settings -> **Connectors** -> Add custom connector を選択する
2. URL にエンドポイント URL を入力し、認証は **None** を選択する
3. 保存する

**注意事項**:

- Free プランでもカスタムコネクタを 1 個まで登録可能

### Claude Desktop

2 つの接続方法がある。

#### 方法 A: リモートコネクタ（推奨）

1. Claude Desktop の Settings -> **Connectors** を開く
2. エンドポイント URL をカスタムコネクタとして登録する

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

## Atlas筋肉の管理

`register_exercise` は任意の `atlas_muscles` を受け付ける。構造は `{primary: string[], secondary: string[], unavailable: string[]}`。primary/secondaryはFJ形式の配信済み筋肉ID、unavailableはAtlas未収録の筋肉名。省略時は既知種目の初期プロファイルを採用し、明示NULLは従来の部位メモによる参考表示へ戻す。3配列が空のオブジェクトは対象筋なしの明示指定。

- `list_atlas_muscles(query?: string)`: ID・英語名・日本語名でカタログを検索し、`{id,name,label,groupLabel}` を返す。左右を含む正確なIDを確認してから割り当てる。筋肉の未収録を別筋で代用しない。
- `set_exercise_muscles(exercise_id: number, atlas_muscles: object | null)`: 種目の割当全体を置き換える。種目IDは正の整数。不明ID・不明筋肉IDはエラーとし、DBを変更しない。
- `search_exercises` / `register_exercise` のレスポンスに、デコード済み `atlas_muscles` を含む。

primary/secondaryはそれぞれ最大200件、unavailableは最大50件・名称100文字。primaryとsecondaryに重複するIDはprimaryを優先する。RESTの種目詳細・一覧も `atlas_muscles` を返す。セッションAPIは従来の `target_muscles_summary` に加え、完了種目の明示割当を集約した `atlas_muscles_summary` と各種目の `atlas_muscles` を返す。NULLの従来値は新しいID集約には含めない。
