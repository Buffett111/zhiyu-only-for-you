CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY, email text NOT NULL UNIQUE, display_name text NOT NULL,
 role text NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
 disabled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS user_modules (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, module_id text NOT NULL,
 enabled boolean NOT NULL DEFAULT true, config_version integer NOT NULL DEFAULT 1,
 config jsonb NOT NULL DEFAULT '{}', widgets jsonb NOT NULL DEFAULT '[]',
 PRIMARY KEY (user_id,module_id)
);
CREATE TABLE IF NOT EXISTS securities (
 id text PRIMARY KEY, symbol text NOT NULL, name text NOT NULL,
 market text NOT NULL CHECK (market IN ('TWSE','TPEx')), asset_type text NOT NULL CHECK (asset_type IN ('stock','etf')),
 currency text NOT NULL DEFAULT 'TWD', sector text, aliases jsonb NOT NULL DEFAULT '[]', source_url text NOT NULL,
 active boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (market,symbol)
);
CREATE TABLE IF NOT EXISTS quotes (
 security_id text NOT NULL REFERENCES securities(id), date date NOT NULL, data jsonb NOT NULL,
 fetched_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (security_id,date)
);
CREATE TABLE IF NOT EXISTS fundamentals (
 security_id text PRIMARY KEY REFERENCES securities(id), data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fundamental_versions (
 security_id text NOT NULL REFERENCES securities(id), fingerprint text NOT NULL, data jsonb NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (security_id,fingerprint)
);
CREATE TABLE IF NOT EXISTS watchlist (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, security_id text NOT NULL REFERENCES securities(id),
 held boolean NOT NULL DEFAULT false, interested boolean NOT NULL DEFAULT true, group_name text NOT NULL DEFAULT '我的清單',
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (user_id,security_id)
);
CREATE TABLE IF NOT EXISTS news (
 id text PRIMARY KEY, data jsonb NOT NULL, published_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS news_date_idx ON news (published_at DESC);
CREATE INDEX IF NOT EXISTS news_securities_idx ON news USING gin ((data->'securityIds'));
CREATE TABLE IF NOT EXISTS source_runs (
 id text PRIMARY KEY, name text NOT NULL, status text NOT NULL DEFAULT 'pending',
 last_attempt timestamptz, last_success timestamptz, data_date date, error text, count integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS digests (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, date date NOT NULL, data jsonb NOT NULL,
 read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,date)
);
CREATE TABLE IF NOT EXISTS history_progress (
 security_id text NOT NULL REFERENCES securities(id), month text NOT NULL, status text NOT NULL,
 error text, last_attempt timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(security_id,month)
);
CREATE TABLE IF NOT EXISTS scheduler_state (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
