CREATE TABLE financial_reports (
 security_id text NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
 period_end date NOT NULL,
 basis text NOT NULL CHECK(basis IN ('quarter','annual')),
 data jsonb NOT NULL,
 fetched_at timestamptz NOT NULL DEFAULT now(),
 observed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(security_id,period_end,basis)
);
CREATE TABLE content_progress (
 security_id text NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('financials','news')),
 status text NOT NULL CHECK(status IN ('pending','success','partial','error')),
 last_attempt timestamptz NOT NULL,
 last_success timestamptz,
 error text,
 PRIMARY KEY(security_id,kind)
);
CREATE INDEX quotes_fetched_at_idx ON quotes(fetched_at);
