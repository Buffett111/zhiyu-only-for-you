CREATE TABLE media_video_metadata (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 video_id text NOT NULL,
 title text, channel text, channel_key text,
 status text NOT NULL CHECK(status IN ('ready','unavailable','error')),
 checked_at timestamptz NOT NULL DEFAULT now(), retry_after timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,video_id)
);
CREATE INDEX media_metadata_channel ON media_video_metadata(user_id,channel_key);
CREATE TABLE media_channel_labels (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 channel_key text NOT NULL,
 category text NOT NULL,
 confidence float8 NOT NULL,
 evidence jsonb NOT NULL DEFAULT '[]',
 model text NOT NULL, version text NOT NULL, input_hash text NOT NULL,
 generated_at timestamptz NOT NULL DEFAULT now(),
 override_category text, reviewed_at timestamptz,
 PRIMARY KEY(user_id,channel_key)
);
CREATE TABLE media_processing (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 auto_classify boolean NOT NULL DEFAULT false,
 generation uuid NOT NULL,
 last_attempt timestamptz, last_success timestamptz,
 status text NOT NULL DEFAULT 'idle', error text,
 usage_day date, daily_batches int NOT NULL DEFAULT 0
);
CREATE INDEX media_events_channel_video ON media_events(user_id,channel,video_id);
