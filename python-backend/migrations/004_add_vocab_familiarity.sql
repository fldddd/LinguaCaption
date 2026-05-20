-- Migration: Add familiarity column to vocab table
-- Version: 004
-- Created: 2026-05-20

ALTER TABLE vocab ADD COLUMN familiarity INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_vocab_familiarity ON vocab(familiarity);
