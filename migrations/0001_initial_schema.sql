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
