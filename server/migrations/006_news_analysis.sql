CREATE TABLE news_analysis (
 security_id text NOT NULL REFERENCES securities(id), kind text NOT NULL, scope text NOT NULL,
 fingerprint text, data jsonb, status text NOT NULL DEFAULT 'empty', error text,
 attempt_id uuid, last_attempt timestamptz, PRIMARY KEY(security_id,kind,scope)
);
CREATE TABLE ai_daily_usage (
 day date PRIMARY KEY, requests integer NOT NULL DEFAULT 0,
 input_tokens bigint NOT NULL DEFAULT 0, output_tokens bigint NOT NULL DEFAULT 0
);
