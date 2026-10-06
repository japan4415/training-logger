-- ユーザーと外部 IdP 識別子の対応を新設する (docs/database.md 参照)。
-- users はアプリ内部の識別子で、外部の subject を直接 user_id には使わない。
--
-- D1 は外部キーを常時有効にし、PRAGMA foreign_keys = off は使えない。
-- workout_sessions だけを DROP すると ON DELETE CASCADE により
-- session_exercises / sets / session_photos の全行が消えるため、4 テーブルを同時に再構築する。
PRAGMA defer_foreign_keys = on;

CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    display_name TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member'))
);

-- 既定オーナー。既存データはすべて user 1 に帰属させる。
INSERT INTO users (id, display_name, status, role) VALUES (1, NULL, 'active', 'owner');

CREATE TABLE user_identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,              -- 例: 'cloudflare-access'
    subject TEXT,                        -- IdP の subject。email のみの招待行では NULL
    email TEXT COLLATE NOCASE UNIQUE,    -- 照合用。大文字小文字を区別しない一意制約
    UNIQUE (provider, subject),
    -- subject も email も無い行はユーザーを解決できないため登録させない。
    CHECK (subject IS NOT NULL OR email IS NOT NULL)
);
CREATE INDEX idx_user_identities_user_id ON user_identities(user_id);

-- 1 日 1 行 (session_date UNIQUE) から 1 ユーザー 1 日 1 行 (UNIQUE(user_id, session_date)) へ変更する。
CREATE TABLE workout_sessions_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 1 REFERENCES users(id),
    session_date TEXT NOT NULL,          -- 'YYYY-MM-DD' (Asia/Tokyo)
    goal TEXT,                           -- 例: "ダイエット"
    body_condition TEXT,                 -- 体調・怪我メモ
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE (user_id, session_date)
);

-- 子の *_new は workout_sessions_new / session_exercises_new を参照する。
-- 旧テーブルの DROP で CASCADE を起こさないよう参照先を *_new にしておく。
CREATE TABLE session_exercises_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES workout_sessions_new(id) ON DELETE CASCADE,
    exercise_id INTEGER NOT NULL REFERENCES exercises(id),
    display_order INTEGER NOT NULL,      -- セッション内の表示順 (1-based)
    status TEXT NOT NULL DEFAULT 'completed'
        CHECK (status IN ('planned', 'completed', 'skipped')),
    equipment_note TEXT,                 -- この実施での器具メモ (例: "木の台・小", "2kgバー")
    form_cues TEXT,                      -- フォームキュー (改行区切り)
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE (session_id, display_order)
);

CREATE TABLE sets_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_exercise_id INTEGER NOT NULL REFERENCES session_exercises_new(id) ON DELETE CASCADE,
    set_order INTEGER NOT NULL,          -- セット番号 (1-based。計画系列と実績系列でそれぞれ 1 から)
    is_planned INTEGER NOT NULL DEFAULT 0 CHECK (is_planned IN (0, 1)), -- 0=実績, 1=計画
    reps INTEGER,
    weight_value REAL,
    weight_unit TEXT CHECK (weight_unit IN ('kg', 'lbs', 'level') OR weight_unit IS NULL),
    duration_minutes REAL,
    distance_km REAL,
    speed_min REAL,                      -- km/h 下限
    speed_max REAL,                      -- km/h 上限 (単一値は min=max)
    incline_percent REAL,
    angle_degrees REAL,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE (session_exercise_id, set_order, is_planned)
);

CREATE TABLE session_photos_new (
    id TEXT PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES workout_sessions_new(id) ON DELETE CASCADE,
    r2_key TEXT NOT NULL UNIQUE,
    content_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- AUTOINCREMENT の採番位置を引き継ぐ。DROP は旧テーブルの sqlite_sequence 行も消し、
-- *_new 側はコピーした MAX(id) までしか進まないため、末尾で削除した id が再利用されてしまう
-- (例: 最後の 1 件を削除してから再構築すると、次の INSERT がその削除済み id を取得する)。
-- 旧 seq (旧 sqlite_sequence の値) と同じ id の一時行を 1 行だけ INSERT してすぐ DELETE する。
-- AUTOINCREMENT は「これまでに挿入した最大 rowid」を記録し DELETE では下がらないため、
-- 通常の INSERT/DELETE だけで高水位を引き継げる。sqlite_sequence は直接書き換えない
-- (本番 D1 での書き込み可否に依存しない)。一時行は NOT NULL を満たす番兵値で作り、
-- 外部キーは defer_foreign_keys で commit まで遅延させ、commit 前に必ず削除する。
--
-- 一時行の削除は id で照合せず *_new を全件 DELETE する。この時点の *_new には上の
-- 一時行しか入っておらず、実データのコピーはこの後なので全件削除で失うものはない。
-- seq が NULL (sqlite_sequence を手で書き換えた場合) だと id = (SELECT seq ...) は
-- NULL と比較されて一時行を消せず、番兵行 (workout_sessions の '0000-00-00' など) が
-- 残ったまま commit され得る。全件削除なら採番位置の引き継ぎは INSERT 時の
-- AUTOINCREMENT だけで完結し、この経路でも番兵行が残らない。
INSERT INTO workout_sessions_new (id, user_id, session_date)
    SELECT seq, 1, '0000-00-00' FROM sqlite_sequence WHERE name = 'workout_sessions';
DELETE FROM workout_sessions_new;

INSERT INTO session_exercises_new (id, session_id, exercise_id, display_order)
    SELECT seq, -1, -1, -1 FROM sqlite_sequence WHERE name = 'session_exercises';
DELETE FROM session_exercises_new;

INSERT INTO sets_new (id, session_exercise_id, set_order)
    SELECT seq, -1, -1 FROM sqlite_sequence WHERE name = 'sets';
DELETE FROM sets_new;

-- id を保持して親 -> 子の順にコピーする。
INSERT INTO workout_sessions_new (id, user_id, session_date, goal, body_condition, notes, created_at, updated_at)
SELECT id, 1, session_date, goal, body_condition, notes, created_at, updated_at FROM workout_sessions;

INSERT INTO session_exercises_new (id, session_id, exercise_id, display_order, status, equipment_note, form_cues, notes, created_at)
SELECT id, session_id, exercise_id, display_order, status, equipment_note, form_cues, notes, created_at FROM session_exercises;

INSERT INTO sets_new (id, session_exercise_id, set_order, is_planned, reps, weight_value, weight_unit, duration_minutes, distance_km, speed_min, speed_max, incline_percent, angle_degrees, notes, created_at)
SELECT id, session_exercise_id, set_order, is_planned, reps, weight_value, weight_unit, duration_minutes, distance_km, speed_min, speed_max, incline_percent, angle_degrees, notes, created_at FROM sets;

INSERT INTO session_photos_new (id, session_id, r2_key, content_type, size_bytes, created_at)
SELECT id, session_id, r2_key, content_type, size_bytes, created_at FROM session_photos;

-- 子 (旧) から DROP する。子を先に消せば親の DROP で CASCADE は発生しない。
DROP TABLE sets;
DROP TABLE session_photos;
DROP TABLE session_exercises;
DROP TABLE workout_sessions;

-- 親 -> 子 の順に RENAME する。*_new の REFERENCES は SQLite が自動で追随する。
ALTER TABLE workout_sessions_new RENAME TO workout_sessions;
ALTER TABLE session_exercises_new RENAME TO session_exercises;
ALTER TABLE sets_new RENAME TO sets;
ALTER TABLE session_photos_new RENAME TO session_photos;

-- インデックスを再作成する (旧テーブルの DROP で消えている)。
CREATE INDEX idx_workout_sessions_date ON workout_sessions(session_date);
CREATE INDEX idx_session_exercises_session ON session_exercises(session_id);
CREATE INDEX idx_session_exercises_exercise ON session_exercises(exercise_id);
CREATE INDEX idx_sets_session_exercise ON sets(session_exercise_id);
CREATE INDEX idx_session_photos_session_id ON session_photos(session_id);
