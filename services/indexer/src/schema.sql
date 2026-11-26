-- Tourbillon indexer schema (Backend spec section 8), launch core: samples, board votes and finals, positions.
-- Amounts are on-chain integers (numeric(78,0): uint256 fits); times are block timestamps in seconds.

CREATE TABLE IF NOT EXISTS cursors (
  name        text PRIMARY KEY,         -- one per watched contract
  next_block  bigint NOT NULL
);

-- samples(market, level, t, s_wad, sigma_bps): the price path the book records (level 0 = 5 min, 1 = hourly, 2 = daily)
CREATE TABLE IF NOT EXISTS samples (
  market     text     NOT NULL,
  level      smallint NOT NULL,
  t          bigint   NOT NULL,
  s_wad      numeric(78,0) NOT NULL,
  sigma_bps  integer  NOT NULL,
  PRIMARY KEY (market, level, t)
);

-- board_votes(key, round, signer, value, ts) and board_finals(key, round, median, published, ts)
CREATE TABLE IF NOT EXISTS board_keys (
  key     text PRIMARY KEY,             -- bytes32 hex
  market  text NOT NULL,
  kind    text NOT NULL                 -- MARK | VOL | EQUITY
);
CREATE TABLE IF NOT EXISTS board_votes (
  key      text   NOT NULL,
  round    bigint NOT NULL,
  signer   text   NOT NULL,
  value    numeric(78,0) NOT NULL,
  ts       bigint NOT NULL,
  dropped  boolean NOT NULL DEFAULT false,   -- dropped by the board as stale when a later vote arrived
  PRIMARY KEY (key, round, signer)
);
CREATE TABLE IF NOT EXISTS board_finals (
  key        text   NOT NULL,
  round      bigint NOT NULL,
  median     numeric(78,0) NOT NULL,
  published  numeric(78,0) NOT NULL,         -- after the step clamp
  votes      integer NOT NULL,
  ts         bigint NOT NULL,
  PRIMARY KEY (key, round)
);

-- the terms of every series positions refer to
CREATE TABLE IF NOT EXISTS series (
  id         numeric(78,0) PRIMARY KEY,
  market     text   NOT NULL,
  shape      boolean NOT NULL,
  legs_json  jsonb  NOT NULL,                -- [{ isCall, k, qty }] (strike and amount as decimal strings, WAD)
  movement   jsonb  NOT NULL                 -- [{ tempo, weight }]
);

-- positions(id, owner, market, legs_json, tempo_or_movement, norm, last_accrual): who holds what, held directly or
-- in the AgentRouter sub-account; raw is the book balance; norm is the last norm seen (units = raw × norm)
CREATE TABLE IF NOT EXISTS positions (
  id                 numeric(78,0) NOT NULL,
  owner              text   NOT NULL,
  held               text   NOT NULL,      -- direct | agentRouter
  market             text   NOT NULL,
  legs_json          jsonb  NOT NULL,
  tempo_or_movement  jsonb  NOT NULL,
  raw                numeric(78,0) NOT NULL,
  norm               numeric(78,0) NOT NULL,
  last_accrual       bigint NOT NULL,
  PRIMARY KEY (id, owner, held)
);
CREATE INDEX IF NOT EXISTS positions_owner ON positions (owner) WHERE raw > 0;

-- marks(market, ts, source, px, accepted): the audit trail of marks by source (Backend §8). RH7: one row per MARK
-- final of the quorum (source 'quorum'); px is the published value; accepted is true when it equals the quorum's
-- median, false when the board's step clamp or the out-of-session band held it back. The native source adds rows
-- once Robinhood Chain publishes its mark interface (the adapter is a stub today).
CREATE TABLE IF NOT EXISTS marks (
  market    text    NOT NULL,
  ts        bigint  NOT NULL,
  source    text    NOT NULL,
  round     bigint  NOT NULL,              -- the board round (quorum), for idempotency
  px        numeric(78,0) NOT NULL,        -- WAD
  median    numeric(78,0) NOT NULL,        -- the quorum's median before the clamp, WAD
  accepted  boolean NOT NULL,
  PRIMARY KEY (market, source, round)
);

-- hedges(id, market, side, sz, px, sent_at, reconciled_at, filled_sz, via) (Backend §8). RH6/RH7: the pool's on-chain
-- stock hedge swaps (via 'onchain_dex'), one row per HedgeSwapped event; id is the transaction hash and log index;
-- sz and filled_sz are the token amount in its own units, px the router mark (WAD) the pool checked against; settlement_amount is
-- the USDC side. Exchange hedges (via 'cex_api') are off-chain: hedger-cex logs them in the same shape.
CREATE TABLE IF NOT EXISTS hedges (
  id             text    PRIMARY KEY,
  market         text    NOT NULL,
  side           text    NOT NULL,       -- buy | sell (of the stock)
  sz             numeric(78,0) NOT NULL,
  px             numeric(78,0) NOT NULL,
  settlement_amount numeric(78,0) NOT NULL,
  sent_at        bigint  NOT NULL,
  reconciled_at  bigint  NOT NULL,
  filled_sz      numeric(78,0) NOT NULL,
  via            text    NOT NULL
);
