CREATE TABLE etf_holdings (
 security_id text PRIMARY KEY REFERENCES securities(id) ON DELETE CASCADE,
 data jsonb,
 last_attempt timestamptz NOT NULL,
 last_success timestamptz,
 error text
);
