import 'dotenv/config';
import { pool } from '../src/server/db.js';

async function main() {
  if (!pool) {
    console.error('[migrate] DATABASE_URL is not set. Please configure it (e.g. Railway Postgres connection string).');
    process.exit(1);
  }

  console.log('[migrate] Running database migrations...');

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Agents table: one row per Moltbook agent / API key
    await client.query(`
      CREATE TABLE IF NOT EXISTS agents (
        id       SERIAL PRIMARY KEY,
        name     TEXT UNIQUE NOT NULL,
        api_key  TEXT UNIQUE NOT NULL
      );
    `);

    // Matches table: one row per match
    await client.query(`
      CREATE TABLE IF NOT EXISTS matches (
        id           TEXT PRIMARY KEY, -- e.g. "match_1"
        winner_name  TEXT,
        ended_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Match players table: per-agent stats for each match
    await client.query(`
      CREATE TABLE IF NOT EXISTS match_players (
        match_id    TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
        player_id   TEXT,
        agent_name  TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE,
        color       TEXT,
        score       INTEGER NOT NULL DEFAULT 0,
        kills       INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (match_id, agent_name)
      );
    `);

    // Add skin_id column to match_players (for storing which skin was used in each match)
    await client.query(`
      ALTER TABLE match_players
        ADD COLUMN IF NOT EXISTS skin_id TEXT;
    `);

    // Agent skins table: tracks which skins each agent owns
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_skins (
        agent_name  TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE,
        skin_id     TEXT NOT NULL,
        granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (agent_name, skin_id)
      );
    `);

    // Grant the default skin to all existing agents that don't have it yet
    await client.query(`
      INSERT INTO agent_skins (agent_name, skin_id)
      SELECT a.name, 'default'
      FROM agents a
      LEFT JOIN agent_skins s
        ON s.agent_name = a.name
       AND s.skin_id = 'default'
      WHERE s.agent_name IS NULL
      ON CONFLICT DO NOTHING;
    `);

    // ── Betting: wallet_address on agents ──────────────────────────────
    await client.query(`
      ALTER TABLE agents
        ADD COLUMN IF NOT EXISTS wallet_address TEXT;
    `);

    // ── Betting pools: one row per match that has betting ──────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS betting_pools (
        match_id           TEXT PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
        total_pool         NUMERIC(78,0) NOT NULL DEFAULT 0,
        status             TEXT NOT NULL DEFAULT 'open',
        agent_names        TEXT[],
        winner_agent_names TEXT[],
        winner_agent_wallets TEXT[],
        is_draw            BOOLEAN NOT NULL DEFAULT FALSE,
        treasury_payout    NUMERIC(78,0) NOT NULL DEFAULT 0,
        agent_payout       NUMERIC(78,0) NOT NULL DEFAULT 0,
        resolve_tx_hash    TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at        TIMESTAMPTZ
      );
    `);

    // Add agent_names column if table already exists (safe re-run)
    await client.query(`
      ALTER TABLE betting_pools
        ADD COLUMN IF NOT EXISTS agent_names TEXT[];
    `);

    // ── Individual bets (multiple per user per match allowed) ──────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS bets (
        id              SERIAL PRIMARY KEY,
        match_id        TEXT NOT NULL REFERENCES betting_pools(match_id) ON DELETE CASCADE,
        bettor_address  TEXT NOT NULL,
        bettor_type     TEXT NOT NULL,
        bettor_name     TEXT,
        agent_name      TEXT NOT NULL,
        amount          NUMERIC(78,0) NOT NULL,
        tx_hash         TEXT,
        placed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // ── Bet settlements (payout records) ──────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS bet_settlements (
        id              SERIAL PRIMARY KEY,
        match_id        TEXT NOT NULL REFERENCES betting_pools(match_id) ON DELETE CASCADE,
        bettor_address  TEXT NOT NULL,
        payout_amount   NUMERIC(78,0) NOT NULL,
        claim_tx_hash   TEXT,
        settled_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // ── Betting leaderboard (aggregated stats per bettor) ─────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS betting_leaderboard (
        bettor_address  TEXT PRIMARY KEY,
        bettor_name     TEXT,
        total_volume    NUMERIC(78,0) NOT NULL DEFAULT 0,
        total_bets      INTEGER NOT NULL DEFAULT 0,
        total_wins      INTEGER NOT NULL DEFAULT 0,
        total_payout    NUMERIC(78,0) NOT NULL DEFAULT 0,
        last_bet_at     TIMESTAMPTZ
      );
    `);

    await client.query('COMMIT');
    console.log('[migrate] Migrations completed successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migrate] Migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
  }
}

main().catch((err) => {
  console.error('[migrate] Unexpected error:', err);
  process.exit(1);
});

