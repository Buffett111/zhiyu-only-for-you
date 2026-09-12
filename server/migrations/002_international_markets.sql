ALTER TABLE securities DROP CONSTRAINT securities_market_check;
ALTER TABLE securities ADD CONSTRAINT securities_market_check
 CHECK (market IN ('TWSE','TPEx','NASDAQ','NYSE','NYSEARCA','NYSEAMERICAN','CBOE','TSE'));
ALTER TABLE securities ADD CONSTRAINT securities_currency_market_check CHECK (
 (market IN ('TWSE','TPEx') AND currency='TWD') OR
 (market='TSE' AND currency='JPY') OR
 (market IN ('NASDAQ','NYSE','NYSEARCA','NYSEAMERICAN','CBOE') AND currency='USD')
);
