-- migrate:up
ALTER TABLE video_titles ADD COLUMN thumbnail_quote TEXT;

-- migrate:down
ALTER TABLE video_titles DROP COLUMN thumbnail_quote;
