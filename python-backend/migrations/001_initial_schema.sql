-- 初始 schema: 生词表 + 字幕表 + 学习记录表

CREATE TABLE IF NOT EXISTS subtitles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    start_time REAL NOT NULL,
    end_time REAL NOT NULL,
    language TEXT DEFAULT 'en',
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vocab (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word TEXT NOT NULL,
    translation TEXT,
    phonetic TEXT,
    part_of_speech TEXT,
    context TEXT,
    source_subtitle_id INTEGER REFERENCES subtitles(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_vocab_word ON vocab(word);

CREATE TABLE IF NOT EXISTS learning_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vocab_id INTEGER NOT NULL REFERENCES vocab(id) ON DELETE CASCADE,
    review_count INTEGER DEFAULT 0,
    correct_count INTEGER DEFAULT 0,
    last_reviewed_at TEXT,
    next_review_at TEXT,
    mastered INTEGER DEFAULT 0,
    difficulty INTEGER DEFAULT 3,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_learning_vocab ON learning_records(vocab_id);
CREATE INDEX IF NOT EXISTS idx_learning_mastered ON learning_records(mastered);
