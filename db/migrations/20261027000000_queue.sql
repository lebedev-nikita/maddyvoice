-- migrate:up
CREATE TABLE sources (
  channel TEXT PRIMARY KEY,
  cursor INTEGER NOT NULL,
  checked_at TEXT NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  audio_index INTEGER NOT NULL,
  published_at TEXT NOT NULL,
  source_url TEXT NOT NULL,
  caption TEXT NOT NULL,
  status ENUM('pending','ready','uploading','uploaded','review') NOT NULL DEFAULT 'pending',
  origin ENUM('live','history') NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  video_path TEXT,
  video_sha256 TEXT,
  video_size INTEGER,
  upload_session TEXT,
  youtube_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(channel, message_id, audio_index)
);
CREATE INDEX jobs_pending ON jobs(status, next_attempt, published_at);

-- migrate:down
DROP TABLE jobs;
DROP TABLE sources;
