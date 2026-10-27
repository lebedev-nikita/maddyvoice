-- migrate:up
ALTER TABLE jobs ADD COLUMN publication_privacy ENUM('private','public','unlisted');

-- migrate:down
ALTER TABLE jobs DROP COLUMN publication_privacy;
