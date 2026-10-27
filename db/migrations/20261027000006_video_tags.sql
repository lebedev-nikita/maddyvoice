-- migrate:up
ALTER TABLE video_titles ADD COLUMN tags TEXT[];

-- migrate:down
ALTER TABLE video_titles DROP COLUMN tags;
