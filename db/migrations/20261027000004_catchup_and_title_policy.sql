-- migrate:up
ALTER TABLE jobs ADD COLUMN catchup_batch TEXT;
ALTER TABLE video_titles ADD COLUMN generation_version INTEGER NOT NULL DEFAULT 0;

-- migrate:down
ALTER TABLE video_titles DROP COLUMN generation_version;
ALTER TABLE jobs DROP COLUMN catchup_batch;
