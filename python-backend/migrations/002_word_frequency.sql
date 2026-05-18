-- Migration: Add word_frequency and word_occurrences tables
-- Version: 002
-- Created: 2026-05-18

PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS word_frequency (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word TEXT NOT NULL UNIQUE,
    cumulative_count INTEGER NOT NULL DEFAULT 0,
    session_count INTEGER NOT NULL DEFAULT 0,
    last_seen_at TEXT DEFAULT (datetime('now')),
    first_seen_at TEXT DEFAULT (datetime('now')),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_word_frequency_word ON word_frequency(word);
CREATE INDEX IF NOT EXISTS idx_word_frequency_cumulative ON word_frequency(cumulative_count DESC);
CREATE INDEX IF NOT EXISTS idx_word_frequency_session ON word_frequency(session_count DESC);

CREATE TABLE IF NOT EXISTS word_occurrences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'transcription',
    source_id TEXT NOT NULL DEFAULT '',
    subtitle_text TEXT DEFAULT '',
    start_time REAL DEFAULT 0,
    end_time REAL DEFAULT 0,
    occurred_at TEXT DEFAULT (datetime('now')),
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_word_occurrences_word ON word_occurrences(word);
CREATE INDEX IF NOT EXISTS idx_word_occurrences_source ON word_occurrences(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_word_occurrences_time ON word_occurrences(occurred_at DESC);
