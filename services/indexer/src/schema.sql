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
