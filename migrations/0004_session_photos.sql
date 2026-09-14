CREATE TABLE session_photos (
    id TEXT PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES workout_sessions(id) ON DELETE CASCADE,
    r2_key TEXT NOT NULL UNIQUE,
    content_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX idx_session_photos_session_id ON session_photos(session_id);
