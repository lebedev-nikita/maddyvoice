-- migrate:up
-- Names found in Maddyson's text posts and not in assets/names.json, keyed by their
-- normalized spelling (lower case, ё as е). A name is `moved` once the deployed file holds
-- it, and `rejected` when it leaves the file, is listed in assets/names-rejected.json or is
-- rejected by hand; neither comes back.
CREATE TABLE name_additions (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status ENUM('added', 'moved', 'rejected') NOT NULL DEFAULT 'added',
  -- Unset for a name rejected before any post mentioned it.
  first_post INTEGER,
  posts INTEGER NOT NULL DEFAULT 0,
  last_seen TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Text posts whose names have been extracted, so each is read and counted once.
CREATE TABLE name_posts (
  channel TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  scanned_at TEXT NOT NULL,
  PRIMARY KEY (channel, message_id)
);

-- Every name and alias of the deployed assets/names.json, to notice the ones removed from it.
CREATE TABLE name_dictionary (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

-- migrate:down
DROP TABLE name_dictionary;
DROP TABLE name_posts;
DROP TABLE name_additions;
