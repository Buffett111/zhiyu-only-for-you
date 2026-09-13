ALTER TABLE media_processing ADD COLUMN retry_after timestamptz;
ALTER TABLE media_processing ADD COLUMN active_batches int NOT NULL DEFAULT 0;
-- Public images are cached per saved channel; clearing media removes the cache
-- for that user, and no additional viewing history is sent to the image host.
CREATE TABLE media_channel_icons (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 channel_key text NOT NULL,
 icon_url text,
 checked_at timestamptz NOT NULL DEFAULT now(),
 retry_after timestamptz NOT NULL,
 PRIMARY KEY(user_id,channel_key)
);
