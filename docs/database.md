# データベース設計

training-logger のデータベース設計について記述する。DBMS は Cloudflare D1 (SQLite ベース) を使用する。

## 設計方針

ユーザー方針「筋トレの種類テーブル + 筋トレ内容テーブル」を核に、以下の 8 テーブルへ正規化する。画像本体は D1 に格納せず、Cloudflare R2 に保存する。

- **`users`** -- アプリ内部のユーザー。外部 IdP の識別子を直接使わず、内部 ID でデータを所有する
- **`user_identities`** -- 外部 IdP (例: Cloudflare Access) の識別子と `users` の対応。`subject` / `email` でユーザーを解決する
- **`exercises`** -- 種目マスタ。種目の正規名・カテゴリ・器具・対象部位を保持
- **`exercise_aliases`** -- 種目の別名（表記揺れ対策）
- **`workout_sessions`** -- ワークアウトセッション。1 ユーザー 1 日 1 行で日付・目的・体調メモを管理
- **`session_exercises`** -- セッション内の種目実施。順序付きで、同一種目の同日複数回出現に対応
- **`sets`** -- セット単位の計測値。筋力系・有酸素系・柔軟系のパラメータを NULL 許容カラムで持つ
- **`session_photos`** -- セッションに紐づく写真のメタデータ。画像本体の R2 キー・形式・サイズを保持

### 単位の扱い

入力値をそのまま保持し、kg/lbs 間の変換は行わない。`sets.weight_unit` カラム (`kg` / `lbs` / `level`) で単位を記録する。`level` はカイザー空圧マシンなどのマシン抵抗レベルに使用し、自重種目では `weight_value` と `weight_unit` の両方が NULL になる。

### 範囲値

速度のように範囲で記録される値（例: 3.0~3.5 km/h）は `speed_min` / `speed_max` の 2 カラムで表現する。単一値の場合は min = max とする。

### 計画 vs 実績

`sets.is_planned` フラグ（0=実績, 1=計画）で区別する。詳細は [計画 vs 実績](#計画-vs-実績) セクションを参照。

### 曜日

曜日カラムは持たない。`session_date` から表示時に導出する。保存すると日付との矛盾リスクが生じるため、意図的に省略している。

### タイムゾーン

- 日付: `TEXT 'YYYY-MM-DD'` 形式。Asia/Tokyo の日付として記録する
- タイムスタンプ (`created_at`, `updated_at`): ISO 8601 UTC 形式 (`YYYY-MM-DDTHH:MM:SSZ`)
- アプリの実行環境（Cloudflare Workers）は UTC であるため、「今日」の算出は Intl API で Asia/Tokyo に変換して行う（実装方法は [mcp-server.md](./mcp-server.md) の log_workout の項を参照）

### D1 (SQLite) の型

SQLite のカラム型として `TEXT` / `INTEGER` / `REAL` を使用する。BOOLEAN は `INTEGER` (0/1) で表現する。

## ER 図

```mermaid
erDiagram
    users ||--o{ user_identities : "authenticates as"
    users ||--o{ workout_sessions : "records"
    exercises ||--o{ exercise_aliases : "has aliases"
    exercises ||--o{ session_exercises : "performed in"
    workout_sessions ||--o{ session_exercises : "contains"
    workout_sessions ||--o{ session_photos : "has photos"
    session_exercises ||--o{ sets : "measured by"

    users {
        INTEGER id PK
        TEXT created_at "NOT NULL"
        TEXT display_name
        TEXT status "NOT NULL active/disabled"
        TEXT role "NOT NULL owner/member"
    }

    user_identities {
        INTEGER id PK
        INTEGER user_id FK
        TEXT provider "NOT NULL"
        TEXT subject "NULL for invite rows"
        TEXT email "NOCASE UNIQUE"
    }

    exercises {
        INTEGER id PK
        TEXT name "NOT NULL UNIQUE"
        TEXT category "NOT NULL"
        TEXT equipment
        TEXT target_muscles
        TEXT atlas_muscles "NULL or JSON object"
        TEXT notes
        TEXT created_at
        TEXT updated_at
    }

    exercise_aliases {
        INTEGER id PK
        INTEGER exercise_id FK
        TEXT alias "NOT NULL UNIQUE"
    }

    workout_sessions {
        INTEGER id PK
        INTEGER user_id FK "NOT NULL DEFAULT 1"
        TEXT session_date "NOT NULL; UNIQUE(user_id, session_date)"
        TEXT goal
        TEXT body_condition
        TEXT notes
        TEXT created_at
        TEXT updated_at
    }

    session_exercises {
        INTEGER id PK
        INTEGER session_id FK
        INTEGER exercise_id FK
        INTEGER display_order "NOT NULL"
        TEXT status "NOT NULL"
        TEXT equipment_note
        TEXT form_cues
        TEXT notes
        TEXT created_at
    }

    sets {
        INTEGER id PK
        INTEGER session_exercise_id FK
        INTEGER set_order "NOT NULL"
        INTEGER is_planned "NOT NULL"
        INTEGER reps
        REAL weight_value
        TEXT weight_unit
        REAL duration_minutes
        REAL distance_km
        REAL speed_min
        REAL speed_max
        REAL incline_percent
        REAL angle_degrees
        TEXT notes
        TEXT created_at
    }

    session_photos {
        TEXT id PK
        INTEGER session_id FK
        TEXT r2_key "NOT NULL UNIQUE"
        TEXT content_type "NOT NULL"
        INTEGER size_bytes "NOT NULL CHECK >= 0"
        TEXT created_at "NOT NULL"
    }
```

## テーブル定義

### users (アプリ内ユーザー)

アプリ内部のユーザーを表す。外部 IdP の識別子（`subject` など）は直接ここに持たず、`user_identities` を経由して解決する。

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | アプリ内部のユーザー ID。`workout_sessions.user_id` から参照される |
| `created_at` | TEXT | NOT NULL DEFAULT (UTC) | 作成日時 ISO 8601 UTC |
| `display_name` | TEXT | | 表示名 |
| `status` | TEXT | NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')) | `active` / `disabled`。`disabled` は認証を拒否する |
| `role` | TEXT | NOT NULL DEFAULT 'member' CHECK(role IN ('owner','member')) | `owner` / `member`。共有マスタの更新は `owner` に限定する |

`0005_users_and_user_id.sql` は既定オーナー `id = 1`（`role = 'owner'`）を投入する。migration 適用前から存在するすべての `workout_sessions` は `user_id = 1` に帰属させる。

### user_identities (外部 IdP 識別子)

外部 IdP（例: Cloudflare Access）の識別子と `users` の対応を管理する。`(provider, subject)` でユーザーを解決する。`subject` は IdP 側で削除→再追加すると変わり得るため、email だけを持つ招待行（`subject` は NULL）を事前登録し、検証済み email が一致したときだけ `subject` を確定する運用も想定する。

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | 対応 ID |
| `user_id` | INTEGER | NOT NULL, FK -> users(id) ON DELETE CASCADE | 対応するアプリ内ユーザー |
| `provider` | TEXT | NOT NULL | IdP 名（例: `cloudflare-access`） |
| `subject` | TEXT | | IdP の主体識別子。email のみの招待行では NULL |
| `email` | TEXT | COLLATE NOCASE UNIQUE | 照合用 email。大文字小文字を区別しない一意制約 |

制約:

- `UNIQUE(provider, subject)` -- 同一 IdP 内で `subject` は一意。`subject` が NULL の招待行は複数登録できる
- `CHECK(subject IS NOT NULL OR email IS NOT NULL)` -- `subject` と `email` の両方が NULL の行はユーザーを解決できないため登録できない

インデックス:

- `idx_user_identities_user_id` -- `user_id` でユーザーの識別子一覧を取得

### exercises (種目マスタ)

種目の正規名称と属性を管理するマスタテーブル。

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | 種目 ID |
| `name` | TEXT | NOT NULL COLLATE NOCASE UNIQUE | 正規名称（例: "シーテッドロウ"）。大文字小文字を区別しない一意制約 |
| `category` | TEXT | NOT NULL DEFAULT 'strength' | カテゴリ。`strength` / `cardio` / `flexibility` / `other` のいずれか |
| `equipment` | TEXT | | 器具（例: "カイザー空圧マシン"）。自重種目は NULL |
| `target_muscles` | TEXT | | 対象部位（例: "背中"） |
| `atlas_muscles` | TEXT | CHECK(atlas_muscles IS NULL OR (json_valid(atlas_muscles) AND json_type(atlas_muscles) = 'object')) | `0002_atlas_muscles.sql` で追加。Atlas 筋肉の割当 JSON object（`{"primary":[],"secondary":[],"unavailable":[]}`）。NULL は従来の部位メモ表示 |
| `notes` | TEXT | | メモ |
| `created_at` | TEXT | NOT NULL DEFAULT (UTC) | 作成日時 ISO 8601 UTC |
| `updated_at` | TEXT | NOT NULL DEFAULT (UTC) | 更新日時 ISO 8601 UTC |

### exercise_aliases (種目別名)

表記揺れを吸収するための別名テーブル。1 つの種目に複数の別名を登録できる。

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | 別名 ID |
| `exercise_id` | INTEGER | NOT NULL, FK -> exercises(id) ON DELETE CASCADE | 親種目 ID |
| `alias` | TEXT | NOT NULL COLLATE NOCASE UNIQUE | 別名（例: "Keiser Chest Press"）。大文字小文字を区別しない一意制約 |

インデックス:

- `idx_exercise_aliases_exercise_id` -- `exercise_id` で検索
- `idx_exercise_aliases_alias` -- `alias` (COLLATE NOCASE) で大文字小文字を区別しない検索

### workout_sessions (ワークアウトセッション)

1 ユーザー 1 日 1 行のセッション管理テーブル。

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | セッション ID |
| `user_id` | INTEGER | NOT NULL DEFAULT 1, FK -> users(id) | 所有ユーザー。`0005_users_and_user_id.sql` で追加 |
| `session_date` | TEXT | NOT NULL | セッション日付 'YYYY-MM-DD' (Asia/Tokyo) |
| `goal` | TEXT | | 目的（例: "ダイエット"） |
| `body_condition` | TEXT | | 体調・怪我メモ |
| `notes` | TEXT | | メモ |
| `created_at` | TEXT | NOT NULL DEFAULT (UTC) | 作成日時 ISO 8601 UTC |
| `updated_at` | TEXT | NOT NULL DEFAULT (UTC) | 更新日時 ISO 8601 UTC |

制約:

- `UNIQUE(user_id, session_date)` -- 同一ユーザー内で日付は一意。別ユーザーは同じ日付を記録できる

インデックス:

- `idx_workout_sessions_date` -- `session_date` で範囲検索・ソート

> **DEFAULT 1 について**: `user_id` の `DEFAULT 1` は、migration 0005 適用直後も `user_id` を指定しない旧コードの INSERT が壊れないようにする過渡的な措置である。リポジトリ層で `user_id` の明示指定が徹底された後、別 migration で DEFAULT を外すか、DEFAULT を残す場合はテストで明示指定を強制する。

> **所有境界**: `session_exercises` / `sets` / `session_photos` は `user_id` を持たず、所有境界は親 `workout_sessions.user_id` に一本化する。子テーブルへの ID 直指定の更新・削除は、必ず親セッションの所有を検証してから行う。

> **現状の制約**: `updated_at` は「更新日時」と定義しているが、同日再記録時にメタデータ（`goal` / `body_condition` / `notes`）を更新する `updateSession` は `updated_at` を書き換えない。DB 層で `updated_at` を更新するのは `set_exercise_muscles` による `exercises.updated_at` だけである。

### session_photos (セッション写真)

ワークアウト登録に使ったノート写真のメタデータを管理する。画像本体は R2 バケット `training-logger-photos` に保存し、D1 には参照に必要な情報だけを保持する。1 セッションにつき最大 4 枚、1 枚につき最大 10 MiB というアプリケーション制約がある。

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | 写真 ID。`crypto.randomUUID()` で生成 |
| `session_id` | INTEGER | NOT NULL, FK -> workout_sessions(id) ON DELETE CASCADE | 親セッション ID |
| `r2_key` | TEXT | NOT NULL UNIQUE | R2 オブジェクトキー |
| `content_type` | TEXT | NOT NULL | magic bytes から判定した MIME type（`image/jpeg` / `image/png` / `image/webp`） |
| `size_bytes` | INTEGER | NOT NULL, CHECK(size_bytes >= 0) | 画像本体のバイト数 |
| `created_at` | TEXT | NOT NULL DEFAULT (UTC) | 作成日時 ISO 8601 UTC |

インデックス:

- `idx_session_photos_session_id` -- `session_id` でセッション内の写真を取得

R2 キーは `sessions/{YYYY-MM-DD}/{sessionId}/{uuid}.{ext}` 形式で、`YYYY-MM-DD` は親セッションの `session_date`、`sessionId` は親セッションの不変な ID、拡張子は検出した形式に応じてサーバが `jpg` / `png` / `webp` から決める。例えば `sessions/2026-08-16/42/550e8400-e29b-41d4-a716-446655440000.jpg` に対応する D1 行の `r2_key` には同じ文字列を保存する。R2 put 時の HTTP metadata は、検出した `contentType` と `cacheControl: "private, no-store"` である。

枚数上限は、件数確認と INSERT を分離せず、`INSERT ... SELECT ... WHERE (SELECT COUNT(*) ...) < 4` の単一 SQL 文で強制する。保存順序は R2 put、D1 INSERT の順であり、上限超過または INSERT 失敗時には直前に作成した R2 オブジェクトを補償削除する。

### session_exercises (セッション内種目実施)

セッション内で実施した種目を順序付きで管理する。同一種目が同日に複数回出現するケース（例: ウォーキングを最初と最後に実施）にも対応する。

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | 種目実施 ID |
| `session_id` | INTEGER | NOT NULL, FK -> workout_sessions(id) ON DELETE CASCADE | セッション ID |
| `exercise_id` | INTEGER | NOT NULL, FK -> exercises(id) | 種目 ID |
| `display_order` | INTEGER | NOT NULL | セッション内の表示順 (1-based) |
| `status` | TEXT | NOT NULL DEFAULT 'completed' | 状態。`planned` / `completed` / `skipped` のいずれか |
| `equipment_note` | TEXT | | この実施での器具メモ（例: "木の台・小", "2kgバー"） |
| `form_cues` | TEXT | | フォームキュー（改行区切りで複数記録） |
| `notes` | TEXT | | メモ |
| `created_at` | TEXT | NOT NULL DEFAULT (UTC) | 作成日時 ISO 8601 UTC |

制約:

- `UNIQUE(session_id, display_order)` -- 同一セッション内で表示順は一意

インデックス:

- `idx_session_exercises_session` -- `session_id` でセッション内の種目を取得
- `idx_session_exercises_exercise` -- `exercise_id` で種目の履歴を横断検索

### sets (セット)

セット単位の計測値を記録する。筋力系・有酸素系・柔軟系のパラメータを NULL 許容カラムで持ち、種目のカテゴリに応じて該当カラムのみを使用する。

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | セット ID |
| `session_exercise_id` | INTEGER | NOT NULL, FK -> session_exercises(id) ON DELETE CASCADE | 種目実施 ID |
| `set_order` | INTEGER | NOT NULL | セット番号 (1-based)。計画系列と実績系列でそれぞれ 1 から採番 |
| `is_planned` | INTEGER | NOT NULL DEFAULT 0 | 0=実績, 1=計画 |
| `reps` | INTEGER | | 回数（筋力系） |
| `weight_value` | REAL | | 重量またはレベル値 |
| `weight_unit` | TEXT | | 単位。`kg` / `lbs` / `level` のいずれか。自重は NULL |
| `duration_minutes` | REAL | | 時間（分。有酸素系） |
| `distance_km` | REAL | | 距離（km。有酸素系） |
| `speed_min` | REAL | | 速度下限 (km/h)。単一値の場合は min=max |
| `speed_max` | REAL | | 速度上限 (km/h) |
| `incline_percent` | REAL | | 傾斜 (%) |
| `angle_degrees` | REAL | | 角度（度。柔軟系） |
| `notes` | TEXT | | メモ |
| `created_at` | TEXT | NOT NULL DEFAULT (UTC) | 作成日時 ISO 8601 UTC |

制約:

- `UNIQUE(session_exercise_id, set_order, is_planned)` -- 同一種目実施内でセット番号と計画/実績の組み合わせは一意

インデックス:

- `idx_sets_session_exercise` -- `session_exercise_id` で種目実施に紐づくセットを取得

#### カラム使用パターン

| カテゴリ | 主に使用するカラム | 例 |
|---|---|---|
| strength | `reps`, `weight_value`, `weight_unit` | ベンチプレス 10回 60kg |
| cardio | `duration_minutes`, `speed_min`, `speed_max`, `incline_percent`, `distance_km` | ウォーキング 10分 4.0~5.0km/h 傾斜0.5% |
| flexibility | `angle_degrees`, `reps` | ストレッチボード 20度 |
| マシンレベル | `reps`, `weight_value` (レベル値), `weight_unit='level'` | カイザーチェストプレス 20回 レベル15 |

## DDL (初期スキーマの抜粋)

以下は `migrations/0001_initial_schema.sql` の初期 5 テーブル（`exercises` / `exercise_aliases` / `workout_sessions` / `session_exercises` / `sets`）の抜粋である。`session_photos` は `0004` で追加し、「セッション写真マイグレーション」節に DDL を載せる。`users` / `user_identities` の追加と `workout_sessions` の再構築（`user_id` と `UNIQUE(user_id, session_date)`）は `0005` で行い、「ユーザー分離マイグレーション」節に適用後の DDL を載せる。**したがって、この抜粋の `workout_sessions` は現在の定義ではなく 0001 時点のものである**（最終形は後述の節を参照）。

```sql
-- 種目マスタ
CREATE TABLE exercises (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE, -- 正規名 (例: "シーテッドロウ")
    category TEXT NOT NULL DEFAULT 'strength'
        CHECK (category IN ('strength', 'cardio', 'flexibility', 'other')),
    equipment TEXT,                      -- 器具 (例: "カイザー空圧マシン"。自重は NULL)
    target_muscles TEXT,                 -- 対象部位 (例: "背中")
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- 種目の別名（表記揺れ対策）
CREATE TABLE exercise_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exercise_id INTEGER NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
    alias TEXT NOT NULL COLLATE NOCASE UNIQUE
);
CREATE INDEX idx_exercise_aliases_exercise_id ON exercise_aliases(exercise_id);
CREATE INDEX idx_exercise_aliases_alias ON exercise_aliases(alias COLLATE NOCASE);

-- ワークアウトセッション（1日1行）
-- 0005 適用後は user_id を持ち、UNIQUE は UNIQUE(user_id, session_date) になる
-- （適用後の定義は「ユーザー分離マイグレーション」節を参照）。
CREATE TABLE workout_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_date TEXT NOT NULL UNIQUE,   -- 'YYYY-MM-DD' (Asia/Tokyo)
    goal TEXT,                           -- 例: "ダイエット"
    body_condition TEXT,                 -- 体調・怪我メモ
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX idx_workout_sessions_date ON workout_sessions(session_date);

-- セッション内の種目実施（順序付き。同一種目の同日複数回出現に対応）
CREATE TABLE session_exercises (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES workout_sessions(id) ON DELETE CASCADE,
    exercise_id INTEGER NOT NULL REFERENCES exercises(id),
    display_order INTEGER NOT NULL,      -- セッション内の表示順 (1-based)
    status TEXT NOT NULL DEFAULT 'completed'
        CHECK (status IN ('planned', 'completed', 'skipped')),
    equipment_note TEXT,                 -- この実施での器具メモ (例: "木の台・小", "2kgバー")
    form_cues TEXT,                      -- フォームキュー (改行区切り)
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE(session_id, display_order)
);
CREATE INDEX idx_session_exercises_session ON session_exercises(session_id);
CREATE INDEX idx_session_exercises_exercise ON session_exercises(exercise_id);

-- セット（計測値。筋力系・有酸素系・柔軟系のパラメータを NULL 許容カラムで持つ）
CREATE TABLE sets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_exercise_id INTEGER NOT NULL REFERENCES session_exercises(id) ON DELETE CASCADE,
    set_order INTEGER NOT NULL,          -- セット番号 (1-based。計画系列と実績系列でそれぞれ 1 から)
    is_planned INTEGER NOT NULL DEFAULT 0 CHECK (is_planned IN (0, 1)), -- 0=実績, 1=計画
    -- 筋力系
    reps INTEGER,
    weight_value REAL,
    weight_unit TEXT CHECK (weight_unit IN ('kg', 'lbs', 'level') OR weight_unit IS NULL),
        -- 'level' はカイザー等のマシン抵抗レベル。自重は NULL
    -- 有酸素系
    duration_minutes REAL,
    distance_km REAL,
    speed_min REAL,                      -- km/h 下限
    speed_max REAL,                      -- km/h 上限（単一値は min=max）
    incline_percent REAL,
    -- 柔軟/その他
    angle_degrees REAL,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE(session_exercise_id, set_order, is_planned)
);
CREATE INDEX idx_sets_session_exercise ON sets(session_exercise_id);
```

### セッション写真マイグレーション

`migrations/0004_session_photos.sql` は `session_photos` テーブルと `idx_session_photos_session_id` を追加する。

```sql
CREATE TABLE session_photos (
    id TEXT PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES workout_sessions(id) ON DELETE CASCADE,
    r2_key TEXT NOT NULL UNIQUE,
    content_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX idx_session_photos_session_id ON session_photos(session_id);
```

`ON DELETE CASCADE` が削除するのは D1 の `session_photos` 行だけで、R2 オブジェクトは削除しない。このため `deleteSession` は D1 のセッションを DELETE する前に写真の `r2_key` を列挙し、R2 をアプリケーション側で削除する。R2 削除に 1 件でも失敗した場合は D1 のセッション削除を中断してエラーを返し、写真行と `r2_key` を保持する。D1 のセッション削除後はセッション固有プレフィックス `sessions/{session_date}/{session_id}/` を列挙し、削除と同時進行したアップロードが残したオブジェクトを best-effort で事後スイープする。日付が同じでも ID が異なる再作成後のセッションは対象に含めない。スイープ失敗は記録し、完了済みの D1 削除結果は維持する。

R2 を先に削除した後で D1 の削除に失敗すると、写真行が欠損オブジェクトを一時的に参照し得る。API 一覧と SSR 写真断片は最大 4 行を `head` で確認し、R2 に存在しない行を D1 から除外・削除する。本体 GET も R2 miss 時に 404 を返して該当行を削除し、再アクセス時に自己修復する。R2 put 後の D1 INSERT 失敗や枚数上限では R2 の補償削除を試みるが、その補償失敗は元の結果・例外を上書きせずログへ記録する。

### ユーザー分離マイグレーション

`migrations/0005_users_and_user_id.sql` は `users` / `user_identities` を新設し、`workout_sessions` に `user_id` を追加して `session_date` の単独 UNIQUE を `UNIQUE(user_id, session_date)` に置き換える。

D1 は外部キーを常時有効にし、migration 中も `PRAGMA foreign_keys = off` を使えない。`session_exercises` / `sets` / `session_photos` は `workout_sessions` を `ON DELETE CASCADE` で参照しているため、`workout_sessions` だけを `DROP` すると子テーブルの全行が消える（`PRAGMA defer_foreign_keys` は検査を遅らせるだけで CASCADE を止めない）。そこで 0005 は 4 テーブルを 1 つの migration で同時に再構築する。

1. `PRAGMA defer_foreign_keys = on`
2. `users` / `user_identities` を作成し、既定オーナー `id = 1` を投入
3. `*_new` を作成（子の `REFERENCES` は `*_new` を指す）
4. AUTOINCREMENT の採番位置を引き継ぐ（後述）
5. `id` を保持して親 → 子の順にコピー
6. 子から `DROP`（`sets` → `session_photos` → `session_exercises` → `workout_sessions`）
7. 親から `RENAME`（`workout_sessions_new` → `workout_sessions`。子の参照は SQLite が自動で追随する）
8. インデックスを再作成

再構築後も件数・ID・`CHECK`・`UNIQUE`・`ON DELETE CASCADE` は 0001〜0004 と同等に保たれる。`exercises` / `exercise_aliases` は変更しない（共有マスタ維持）。適用前検証は `test/db/migration-0005.test.ts` が 0001〜0004 相当のデータを投入し、実際の 0005 の SQL を適用して件数・ID・全列の値・`PRAGMA foreign_key_check`・CASCADE・複合 `UNIQUE`・削除済み id が再利用されないことを確認する。

#### AUTOINCREMENT の採番位置

`DROP TABLE` は旧テーブルの `sqlite_sequence` 行も消すため、`*_new` 側の採番位置はコピーした `MAX(id)` まで下がる。末尾で削除した id が再利用されると、期限の無い `/sessions/:id` リンクが別セッションを指し得る。0005 は旧 `sqlite_sequence` の値と同じ id の一時行を `*_new` へ 1 行だけ `INSERT` してすぐ `DELETE` し、通常の AUTOINCREMENT の仕組みで高水位だけを引き継ぐ（`DELETE` では採番位置は下がらない）。`sqlite_sequence` は直接書き換えない。

#### 0005 適用後のスキーマ

```sql
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    display_name TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member'))
);

CREATE TABLE user_identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,              -- 例: 'cloudflare-access'
    subject TEXT,                        -- email のみの招待行では NULL
    email TEXT COLLATE NOCASE UNIQUE,
    UNIQUE (provider, subject),
    CHECK (subject IS NOT NULL OR email IS NOT NULL)
);
CREATE INDEX idx_user_identities_user_id ON user_identities(user_id);

CREATE TABLE workout_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 1 REFERENCES users(id),
    session_date TEXT NOT NULL,          -- 'YYYY-MM-DD' (Asia/Tokyo)
    goal TEXT,
    body_condition TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE (user_id, session_date)
);
CREATE INDEX idx_workout_sessions_date ON workout_sessions(session_date);
```

`session_exercises` / `sets` / `session_photos` は 0001・0004 と同じ定義で再作成し、それぞれのインデックスも再作成する（子テーブルの定義は変更しない）。再構築の手順と本番適用手順は [migrations/README.md](../migrations/README.md) を参照。

## 計画 vs 実績

セットレベルで計画と実績を区別する。

- `sets.is_planned = 1` -- 計画（予定していた回数・重量）
- `sets.is_planned = 0` -- 実績（実際に実施した回数・重量）
- `session_exercises.status` -- 種目レベルの実施状態。`completed`（実施済み。ノートのチェックマークに対応）、`planned`（未実施）、`skipped`（スキップ）

### 計画と実績が異なる例

ノートの「レッグレイズ 20回x2セット (計画) -> 実績 20回/10回/10回」は以下のように格納する。

**session_exercises**: status = 'completed'（実施はしたため）

**sets**:

| set_order | is_planned | reps | 意味 |
|---|---|---|---|
| 1 | 1 | 20 | 計画: 1セット目 20回 |
| 2 | 1 | 20 | 計画: 2セット目 20回 |
| 1 | 0 | 20 | 実績: 1セット目 20回 |
| 2 | 0 | 10 | 実績: 2セット目 10回 |
| 3 | 0 | 10 | 実績: 3セット目 10回 |

`set_order` は計画系列 (is_planned=1) と実績系列 (is_planned=0) でそれぞれ 1 から採番する。UNIQUE 制約 `(session_exercise_id, set_order, is_planned)` により整合性を保証する。

### ノートのチェックマークとステータスの解釈

手書きノートでは実施済みの種目にチェックマーク (✓) が付く。データベースへの反映ルール:

- チェックマークあり -> `status = 'completed'`
- チェックマークなし、かつ具体的な数値が記録されている -> `status = 'completed'`（具体値があれば実施したと判断する。2026-08-15 のデータがこのケースに該当する）
- チェックマークなし、具体値もなし -> `status = 'planned'`

## 表記揺れ対策

ユーザーが LLM に「カイザーチェストプレスの前回の記録は?」と聞く場合、入力の表記が正規名と一致しない可能性がある。以下の順序で種目を解決する。

1. `exercises.name` の完全一致 (COLLATE NOCASE)
2. `exercise_aliases.alias` の完全一致 (COLLATE NOCASE)
3. `exercises.name` または `exercise_aliases.alias` の部分一致 (LIKE '%query%')

UNIQUE 制約自体が NOCASE であるため、大文字小文字違いの重複登録は DB レベルで防止される。

### 別名の例

| 正規名 | 想定される別名 |
|---|---|
| カイザーチェストプレス | Keiser Chest Press, カイザーCP |
| ラットプルダウン | Keiser Lat Pulldown, カイザーラットプルダウン, カイザーラット |
| グッドモーニング | グッドモーニングEX, グッドモーニングエクステンション, Good Morning EX |
| バンド肩回し | スポバンド肩まわし, スポーツバンド肩回し |

別名は `register_exercise` ツールの `aliases` パラメータで登録する。LLM が日常会話で使われるバリエーションを予測し、種目登録時に併せて登録することを想定している。

## マイグレーション管理

Cloudflare D1 のマイグレーションは `wrangler d1 migrations` コマンドで管理する。

### ファイル配置

```
migrations/
  0001_initial_schema.sql
  0002_atlas_muscles.sql
  0003_atlas_trunk_muscles.sql
  0004_session_photos.sql
  0005_users_and_user_id.sql
```

### コマンド

| 操作 | コマンド |
|---|---|
| 新規マイグレーション作成 | `pnpm exec wrangler d1 migrations create training-logger-db <name>` |
| ローカル適用（開発） | `pnpm exec wrangler d1 migrations apply training-logger-db --local` |
| リモート適用（本番） | `pnpm exec wrangler d1 migrations apply training-logger-db --remote` |

### CI での構文検証

CI パイプラインでは `pnpm exec wrangler d1 migrations apply training-logger-db --local` を実行してマイグレーション SQL の構文を検証する。詳細は [デプロイメント](./deployment.md) を参照。

## データマッピング検証

手書きノートの 2026-08-15 / 2026-08-16 の全行がデータベースに格納できることを検証する。

### workout_sessions

| id | session_date | goal | body_condition | notes |
|---|---|---|---|---|
| 1 | 2026-08-15 | ダイエット | 左足首・膝の怪我歴あり、少し不安 | 1年半前くらいまでパーソナルジムに通っていた |
| 2 | 2026-08-16 | ダイエット | NULL | NULL |

### exercises

この 2 日分で登録される 14 種目。

| id | name | category | equipment | target_muscles |
|---|---|---|---|---|
| 1 | ウォーキング | cardio | トレッドミル | NULL |
| 2 | ベンチステップ | strength | NULL | NULL |
| 3 | バランスボールスクワット | strength | NULL | NULL |
| 4 | カーフレイズ | strength | NULL | NULL |
| 5 | バンド肩回し | flexibility | NULL | NULL |
| 6 | カイザーチェストプレス | strength | カイザー空圧マシン | NULL |
| 7 | ラットプルダウン | strength | カイザー空圧マシン | NULL |
| 8 | ストレッチボード | flexibility | NULL | NULL |
| 9 | グッドモーニング | strength | NULL | もも裏 |
| 10 | アダクター | strength | NULL | NULL |
| 11 | アブダクター | strength | NULL | NULL |
| 12 | シーテッドロウ | strength | NULL | NULL |
| 13 | バタフライ | strength | NULL | NULL |
| 14 | レッグレイズ | strength | NULL | NULL |

手書きノートの表記（スポバンド肩まわし・カイザーラットプルダウン・グッドモーニングEX）は正規名の別名（`register_exercise` の `aliases`）として登録する。`src/domain/atlas-profiles.json` の初期割当はプロファイルの `names` と種目の `name` だけを照合する（`exercise_aliases` は参照しない）ため、別名のままでは既定の Atlas 割当は付かない。

### 2026-08-15 のセッション

> **注記**: 8/15 のノートにはチェックマークがないが、各種目に具体的な数値（回数・レベル・速度等）が記録されているため、実績 (status='completed') として扱う。

#### session_exercises

| id | session_id | exercise_id | (種目名) | display_order | status | equipment_note | form_cues | notes |
|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 1 | ウォーキング | 1 | completed | NULL | NULL | NULL |
| 2 | 1 | 2 | ベンチステップ | 2 | completed | 木の台・小 | NULL | NULL |
| 3 | 1 | 3 | バランスボールスクワット | 3 | completed | NULL | NULL | NULL |
| 4 | 1 | 4 | カーフレイズ | 4 | completed | NULL | NULL | NULL |
| 5 | 1 | 5 | バンド肩回し | 5 | completed | NULL | NULL | NULL |
| 6 | 1 | 6 | カイザーチェストプレス | 6 | completed | NULL | NULL | NULL |
| 7 | 1 | 7 | ラットプルダウン | 7 | completed | NULL | NULL | NULL |

*(種目名) 列は参照用。実テーブルには存在しない。*

#### sets

**ウォーキング** (session_exercise_id=1):

| set_order | is_planned | duration_minutes | speed_min | speed_max | incline_percent |
|---|---|---|---|---|---|
| 1 | 0 | 5 | 3.0 | 3.5 | 0.5 |

**ベンチステップ** (session_exercise_id=2):

| set_order | is_planned | reps |
|---|---|---|
| 1 | 0 | 20 |

**バランスボールスクワット** (session_exercise_id=3):

| set_order | is_planned | reps |
|---|---|---|
| 1 | 0 | 20 |
| 2 | 0 | 10 |

**カーフレイズ** (session_exercise_id=4):

| set_order | is_planned | reps |
|---|---|---|
| 1 | 0 | 20 |
| 2 | 0 | 20 |

**バンド肩回し** (session_exercise_id=5):

| set_order | is_planned | reps |
|---|---|---|
| 1 | 0 | 10 |
| 2 | 0 | 10 |

**カイザーチェストプレス** (session_exercise_id=6):

| set_order | is_planned | reps | weight_value | weight_unit |
|---|---|---|---|---|
| 1 | 0 | 20 | 5 | level |
| 2 | 0 | 20 | 10 | level |
| 3 | 0 | 20 | 15 | level |

**ラットプルダウン** (session_exercise_id=7):

| set_order | is_planned | reps | weight_value | weight_unit |
|---|---|---|---|---|
| 1 | 0 | 20 | 10 | level |
| 2 | 0 | 20 | 15 | level |

### 2026-08-16 のセッション

#### session_exercises

| id | session_id | exercise_id | (種目名) | display_order | status | equipment_note | form_cues | notes |
|---|---|---|---|---|---|---|---|---|
| 8 | 2 | 1 | ウォーキング | 1 | completed | NULL | NULL | NULL |
| 9 | 2 | 8 | ストレッチボード | 2 | completed | NULL | NULL | 20度がちょうど |
| 10 | 2 | 9 | グッドモーニング | 3 | completed | 2kgバー | NULL | NULL |
| 11 | 2 | 10 | アダクター | 4 | completed | NULL | NULL | NULL |
| 12 | 2 | 11 | アブダクター | 5 | completed | NULL | NULL | NULL |
| 13 | 2 | 12 | シーテッドロウ | 6 | completed | NULL | 背中の空間をつぶす | NULL |
| 14 | 2 | 13 | バタフライ | 7 | completed | NULL | NULL | NULL |
| 15 | 2 | 14 | レッグレイズ | 8 | completed | NULL | 肩を上げない\n足を下げると浮く\n手首注意 | NULL |
| 16 | 2 | 1 | ウォーキング | 9 | completed | NULL | NULL | NULL |

*(種目名) 列は参照用。form_cues 内の `\n` は改行文字。*

ウォーキングが display_order 1 と 9 に 2 回出現している。`session_exercises` は `exercise_id` に UNIQUE 制約を持たず `(session_id, display_order)` で一意性を管理するため、同一種目の複数出現に対応できる。

#### sets

**ウォーキング (1回目)** (session_exercise_id=8):

| set_order | is_planned | duration_minutes | speed_min | speed_max | incline_percent |
|---|---|---|---|---|---|
| 1 | 0 | 10 | 3.5 | 5.0 | 0.5 |

**ストレッチボード** (session_exercise_id=9):

| set_order | is_planned | angle_degrees |
|---|---|---|
| 1 | 0 | 20 |

**グッドモーニング** (session_exercise_id=10):

| set_order | is_planned | reps | weight_value | weight_unit |
|---|---|---|---|---|
| 1 | 0 | 15 | 2 | kg |
| 2 | 0 | 15 | 2 | kg |

**アダクター** (session_exercise_id=11):

| set_order | is_planned | reps | weight_value | weight_unit |
|---|---|---|---|---|
| 1 | 0 | 20 | 50 | lbs |
| 2 | 0 | 20 | 45 | lbs |

**アブダクター** (session_exercise_id=12):

| set_order | is_planned | reps | weight_value | weight_unit |
|---|---|---|---|---|
| 1 | 0 | 20 | 50 | lbs |
| 2 | 0 | 20 | 45 | lbs |

**シーテッドロウ** (session_exercise_id=13):

| set_order | is_planned | reps | weight_value | weight_unit |
|---|---|---|---|---|
| 1 | 0 | 15 | 16 | kg |
| 2 | 0 | 15 | 16 | kg |

**バタフライ** (session_exercise_id=14):

| set_order | is_planned | reps | weight_value | weight_unit |
|---|---|---|---|---|
| 1 | 0 | 15 | 30 | lbs |
| 2 | 0 | 15 | 40 | lbs |

**レッグレイズ** (session_exercise_id=15) -- 計画と実績が異なる例:

| set_order | is_planned | reps | 意味 |
|---|---|---|---|
| 1 | 1 | 20 | 計画 1セット目 |
| 2 | 1 | 20 | 計画 2セット目 |
| 1 | 0 | 20 | 実績 1セット目 |
| 2 | 0 | 10 | 実績 2セット目 |
| 3 | 0 | 10 | 実績 3セット目 |

**ウォーキング (2回目)** (session_exercise_id=16):

| set_order | is_planned | duration_minutes | speed_min | speed_max | incline_percent |
|---|---|---|---|---|---|
| 1 | 0 | 10 | 4.0 | 5.0 | 0.5 |

### 網羅性チェックリスト

ノートに含まれる全要素がデータベースで表現できることを確認する。

- [x] **範囲速度** -- `speed_min` / `speed_max` で表現（例: 3.0~3.5 km/h -> min=3.0, max=3.5）
- [x] **単位混在** -- `weight_unit` カラムで kg / lbs を区別（アダクター 50 lbs、シーテッドロウ 16 kg が同日に共存）
- [x] **マシンレベル** -- `weight_unit='level'` で表現（カイザーチェストプレス レベル 5/10/15）
- [x] **角度** -- `angle_degrees` カラム（ストレッチボード 20度）
- [x] **計画 vs 実績** -- `is_planned` フラグで区別（レッグレイズ: 計画 20x2 -> 実績 20/10/10）
- [x] **同日同種目複数回** -- `session_exercises` の `display_order` で区別（8/16 ウォーキングが order 1 と 9）
- [x] **フォームキュー** -- `session_exercises.form_cues` に改行区切りで格納（レッグレイズ: 3つのキュー）
- [x] **器具メモ** -- `session_exercises.equipment_note`（ベンチステップ "木の台・小"、グッドモーニング "2kgバー"）
- [x] **体調メモ** -- `workout_sessions.body_condition`（"左足首・膝の怪我歴あり、少し不安"）
- [x] **目的** -- `workout_sessions.goal`（"ダイエット"）
- [x] **セットごとの重量差** -- セット単位で `weight_value` を個別記録（アダクター 50 lbs / 45 lbs）
- [x] **傾斜** -- `incline_percent` カラム（ウォーキング 0.5%）
- [x] **種目属性（器具・対象部位）** -- `exercises.equipment` / `exercises.target_muscles`（カイザー空圧マシン、もも裏）

## 却下した代替案

### 汎用 JSON カラム案

セット情報を JSON カラム（例: `sets_json TEXT`）に格納する案。

**却下理由**:

- SQL 集計関数 (`MAX`, `AVG`, `SUM`) を直接使えない。`json_extract` を組み合わせる必要があり、クエリが複雑化する
- `json_extract` にはインデックスが効かないため、データ量増加時にパフォーマンスが劣化する
- 型安全性が失われる。不正な構造の JSON が挿入されてもデータベース層で検出できない
- セットのパラメータ（reps, weight, duration, speed 等）は有限個であり、NULL 許容カラムで十分に表現できる

### 計画/実績の別テーブル案

計画用テーブル (`planned_sets`) と実績用テーブル (`actual_sets`) を分ける案。

**却下理由**:

- 計画と実績を対比するクエリで JOIN が複雑化する
- 大半のセットは実績のみで、計画テーブルが空行になる
- `is_planned` フラグで同一テーブル内に統合した方がシンプル

### マスタなし文字列直記録案

種目名を正規化せず、`session_exercises` に自由テキストで記録する案。

**却下理由**:

- 表記揺れ（「カイザーチェストプレス」「カイザーCP」「Keiser CP」）により、同一種目の進捗グラフを統合できなくなる
- 種目の属性（カテゴリ・器具・対象部位）を種目実施ごとに重複記録することになる
- 別名テーブルによる表記揺れ吸収が利用できない

## Atlas筋肉の構造化

`migrations/0002_atlas_muscles.sql` で種目マスタへ nullable TEXT の `atlas_muscles` を追加する。列定義には `CHECK(atlas_muscles IS NULL OR (json_valid(atlas_muscles) AND json_type(atlas_muscles) = 'object'))` があり、JSON object 以外は保存できない。値は `{"primary":["FJ1447","FJ1447M"],"secondary":[],"unavailable":[]}` のJSONオブジェクト。primary/secondaryは配信Atlasの筋肉ID、unavailableはモデル未収録の筋肉名。アプリ層でID実在・配列・重複・主優先を検証する。左右・筋頭・筋部を個別IDで選べる。

NULLは従来の部位名による参考表示、空の3配列は明示的に対象筋なしを意味する。既存 `target_muscles` は変更しない。移行時はレビュー済み14種目と明示した別名の完全一致に限って初期割当を保存する。未知種目に推測で割当は付けない。新規登録では同じプロファイルを既定値とし、指定された割当があればそちらを優先する。更新はMCPの `set_exercise_muscles` から行う。

初期対応表は `src/domain/atlas-profiles.json`。適用済みmigrationは変更せず、その後のプロファイル改訂で既存DBも更新する場合は新しいmigrationを追加する。出典と前提は [anatomy.md](./anatomy.md) を参照。
