-- migrate:up
CREATE TABLE video_titles (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  video_id TEXT NOT NULL,
  status ENUM('pending','applied','manual','review') NOT NULL DEFAULT 'pending',
  transcript TEXT,
  topic TEXT,
  title TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX video_titles_pending ON video_titles(status, next_attempt);
CREATE TABLE title_caption_budget (
  day TEXT PRIMARY KEY,
  checks INTEGER NOT NULL DEFAULT 0
);

-- migrate:down
DROP TABLE title_caption_budget;
DROP TABLE video_titles;
