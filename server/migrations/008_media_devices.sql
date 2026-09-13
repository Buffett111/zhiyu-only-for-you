CREATE TABLE media_devices (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 label text NOT NULL, token_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), last_sync timestamptz, revoked_at timestamptz
);
CREATE INDEX media_devices_owner ON media_devices(user_id);
