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

