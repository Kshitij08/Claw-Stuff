import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

// In local dev you can point this at a local Postgres instance.
// In production (Railway), set DATABASE_URL in the service settings.
export const pool = connectionString
  ? new Pool({ connectionString })
  : null;

export async function dbQuery<T = any>(text: string, params: any[] = []): Promise<T[]> {
  if (!pool) {
    console.warn('[db] DATABASE_URL not set, skipping query');
    return [];
  }

  const res = await pool.query(text, params);
  return res.rows as T[];
}

// Helper functions for arena-specific writes. These are best-effort and
// should not break the game loop if the database is unavailable.

export async function recordAgentJoin(opts: {
  agentName: string;
  apiKey: string;
  playerId: string;
  matchId: string;
  color?: string;
}) {
  try {
    await dbQuery(
      `
      INSERT INTO agents (name, api_key)
      VALUES ($1, $2)
      ON CONFLICT (name) DO UPDATE
      SET api_key = EXCLUDED.api_key;
    `,
      [opts.agentName, opts.apiKey],
    );

    await dbQuery(
      `
      INSERT INTO match_players (match_id, player_id, agent_name, color)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (match_id, player_id) DO NOTHING;
    `,
      [opts.matchId, opts.playerId, opts.agentName, opts.color ?? null],
    );
  } catch (err) {
    console.error('[db] recordAgentJoin failed:', err);
  }
}

export async function recordMatchEnd(opts: {
  matchId: string;
  winnerName: string | null;
  endedAt: number;
  finalScores: { name: string; score: number; kills: number }[];
}) {
  try {
    await dbQuery(
      `
      INSERT INTO matches (id, winner_name, ended_at)
      VALUES ($1, $2, to_timestamp($3 / 1000.0))
      ON CONFLICT (id) DO UPDATE
      SET winner_name = EXCLUDED.winner_name,
          ended_at    = EXCLUDED.ended_at;
    `,
      [opts.matchId, opts.winnerName, opts.endedAt],
    );

    for (const row of opts.finalScores) {
      await dbQuery(
        `
        INSERT INTO match_players (match_id, agent_name, score, kills)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (match_id, agent_name) DO UPDATE
        SET score = EXCLUDED.score,
            kills = EXCLUDED.kills;
      `,
        [opts.matchId, row.name, row.score, row.kills],
      );
    }
  } catch (err) {
    console.error('[db] recordMatchEnd failed:', err);
  }
}

/**
 * Suggested schema (PostgreSQL):
 *
 * CREATE TABLE agents (
 *   id      serial PRIMARY KEY,
 *   name    text UNIQUE NOT NULL,
 *   api_key text UNIQUE NOT NULL
 * );
 *
 * CREATE TABLE matches (
 *   id          text PRIMARY KEY, -- e.g. "match_1"
 *   winner_name text,
 *   ended_at    timestamptz NOT NULL DEFAULT now()
 * );
 *
 * CREATE TABLE match_players (
 *   match_id   text NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
 *   player_id  text,
 *   agent_name text NOT NULL REFERENCES agents(name) ON DELETE CASCADE,
 *   color      text,
 *   score      integer NOT NULL DEFAULT 0,
 *   kills      integer NOT NULL DEFAULT 0,
 *   PRIMARY KEY (match_id, agent_name)
 * );
 */

