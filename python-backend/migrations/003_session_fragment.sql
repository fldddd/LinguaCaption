-- Migration 003: Add session_info and transcript_fragment tables

CREATE TABLE IF NOT EXISTS session_info (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_type VARCHAR(50) NOT NULL DEFAULT 'realtime',
    language VARCHAR(10) NOT NULL DEFAULT 'en',
    source_type VARCHAR(50) NOT NULL DEFAULT '',
    source_name VARCHAR(500) NOT NULL DEFAULT '',
    source_url TEXT,
    media_duration REAL NOT NULL DEFAULT 0,
    total_fragments INTEGER NOT NULL DEFAULT 0,
    total_words INTEGER NOT NULL DEFAULT 0,
    started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP,
    is_active BOOLEAN NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS transcript_fragment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    language VARCHAR(10) NOT NULL DEFAULT 'en',
    start_time REAL NOT NULL DEFAULT 0,
    end_time REAL NOT NULL DEFAULT 0,
    source_type VARCHAR(50) NOT NULL DEFAULT '',
    source_name VARCHAR(500) NOT NULL DEFAULT '',
    source_video_id VARCHAR(255) NOT NULL DEFAULT '',
    word_count INTEGER NOT NULL DEFAULT 0,
    parsed_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES session_info(id)
);

CREATE INDEX IF NOT EXISTS idx_transcript_fragment_session_id ON transcript_fragment(session_id);
CREATE INDEX IF NOT EXISTS idx_transcript_fragment_language ON transcript_fragment(language);
CREATE INDEX IF NOT EXISTS idx_session_info_is_active ON session_info(is_active);
CREATE INDEX IF NOT EXISTS idx_session_info_started_at ON session_info(started_at);
