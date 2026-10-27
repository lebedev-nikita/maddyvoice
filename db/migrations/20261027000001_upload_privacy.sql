-- migrate:up
ALTER TABLE jobs ADD COLUMN upload_privacy ENUM('private','public','unlisted');

-- migrate:down
ALTER TABLE jobs DROP COLUMN upload_privacy;
