-- Migration: Add familiarity column to vocab
-- Version: 2
-- Created: 2026-05-19

ALTER TABLE vocab ADD COLUMN familiarity INTEGER DEFAULT 0;
