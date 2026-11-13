-- migrate:up
-- Recordings after this message are published as episodes; earlier ones stay single videos.
ALTER TABLE sources ADD COLUMN episodes_after INTEGER;
UPDATE sources SET episodes_after = cursor;

-- The first recording of an episode carries its upload; the others name it in episode_id.
ALTER TABLE jobs ADD COLUMN episode_id TEXT;
ALTER TABLE jobs ADD COLUMN episode_offset REAL;
ALTER TABLE jobs ADD COLUMN chapter TEXT;

CREATE TABLE episodes (
  id TEXT PRIMARY KEY REFERENCES jobs(id),
  number INTEGER NOT NULL UNIQUE,
  duration REAL,
  topic TEXT,
  thumbnail_quote TEXT,
  tags TEXT[],
  generation_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Transcripts are paid for once per recording and model, and kept.
CREATE TABLE transcripts (
  job_id TEXT NOT NULL REFERENCES jobs(id),
  model TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, model)
);

-- The model's verdict on each common word that may be a name, per transcript.
CREATE TABLE name_verdicts (
  job_id TEXT NOT NULL REFERENCES jobs(id),
  model TEXT NOT NULL,
  trigger TEXT NOT NULL,
  name BOOLEAN NOT NULL,
  PRIMARY KEY (job_id, model, trigger)
);

-- migrate:down
DROP TABLE name_verdicts;
DROP TABLE transcripts;
DROP TABLE episodes;
ALTER TABLE jobs DROP COLUMN chapter;
ALTER TABLE jobs DROP COLUMN episode_offset;
ALTER TABLE jobs DROP COLUMN episode_id;
ALTER TABLE sources DROP COLUMN episodes_after;
