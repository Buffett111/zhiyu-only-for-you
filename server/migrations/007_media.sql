CREATE TABLE media_events (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, event_id text NOT NULL,
 video_id text, title text NOT NULL, channel text, watched_at timestamptz NOT NULL,
 actual_seconds integer, precision text NOT NULL DEFAULT 'exact', topics jsonb NOT NULL DEFAULT '[]',
 topic_source text, source text NOT NULL, PRIMARY KEY(user_id,event_id)
);
CREATE INDEX media_events_date ON media_events(user_id,watched_at DESC);
CREATE INDEX media_events_video ON media_events(user_id,video_id,precision);
CREATE TABLE media_imports (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, hash text NOT NULL,
 source text NOT NULL, inserted integer NOT NULL, skipped integer NOT NULL, imported_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,hash)
);
CREATE TABLE media_classifications (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, video_id text NOT NULL,
 topics jsonb NOT NULL, model text NOT NULL, generated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,video_id)
);
CREATE TABLE media_ai_state (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 attempt_id uuid NOT NULL, last_attempt timestamptz NOT NULL DEFAULT now(), status text NOT NULL, error text
);
