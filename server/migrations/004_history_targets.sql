CREATE TABLE history_targets (
 security_id text PRIMARY KEY REFERENCES securities(id) ON DELETE CASCADE,
 years integer NOT NULL CHECK(years IN (5,10,20)),
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE securities ADD COLUMN listed_at date;
