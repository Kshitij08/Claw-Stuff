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

export async function getHighestMatchId(): Promise<number> {
  try {
    // Extract numeric part from match IDs like "match_1", "match_2", etc.
    // Using regex substring to get the number after "match_"
    const rows = await dbQuery<{ max_id: string }>(
      `
      SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 'match_(\\d+)') AS INTEGER)), 0) AS max_id
      FROM matches
      WHERE id LIKE 'match_%';
    `,
    );
    if (rows.length > 0 && rows[0].max_id) {
      return parseInt(rows[0].max_id, 10);
    }
    return 0;
  } catch (err) {
    console.error('[db] getHighestMatchId failed:', err);
    return 0;
  }
}

export async function ensureMatchExists(matchId: string) {
  try {
    await dbQuery(
      `
      INSERT INTO matches (id, winner_name)
      VALUES ($1, NULL)
      ON CONFLICT (id) DO NOTHING;
    `,
      [matchId],
    );
  } catch (err) {
    console.error('[db] ensureMatchExists failed:', err);
  }
}

export async function recordAgentJoin(opts: {
  agentName: string;
  apiKey: string;
  playerId: string;
  matchId: string;
  color?: string;
}) {
  try {
    // Ensure the match exists in the database before inserting into match_players
    await ensureMatchExists(opts.matchId);

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
      ON CONFLICT (match_id, agent_name) DO UPDATE
      SET player_id = EXCLUDED.player_id,
          color     = COALESCE(EXCLUDED.color, match_players.color);
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
    // Ensure the match row exists before recording the final result
    await ensureMatchExists(opts.matchId);

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

export type GlobalLeaderboardRow = {
  agentName: string;
  matches: number;
  wins: number;
  winRate: number;
};

export async function getGlobalLeaderboard(): Promise<{
  totalBots: number;
  totalGames: number;
  leaderboard: GlobalLeaderboardRow[];
}> {
  if (!pool) {
    console.warn('[db] DATABASE_URL not set, global leaderboard unavailable');
    return { totalBots: 0, totalGames: 0, leaderboard: [] };
  }

  try {
    const totalBotsRows = await dbQuery<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM agents;`,
    );
    const totalBots = totalBotsRows.length ? parseInt(totalBotsRows[0].count, 10) : 0;

    const totalGamesRows = await dbQuery<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM matches;`,
    );
    const totalGames = totalGamesRows.length ? parseInt(totalGamesRows[0].count, 10) : 0;

    const rows = await dbQuery<{
      agent_name: string;
      matches_played: string;
      wins: string;
    }>(
      `
      SELECT
        mp.agent_name,
        COUNT(DISTINCT mp.match_id)::text AS matches_played,
        COALESCE(SUM(CASE WHEN m.winner_name = mp.agent_name THEN 1 ELSE 0 END), 0)::text AS wins
      FROM match_players mp
      JOIN matches m ON m.id = mp.match_id
      GROUP BY mp.agent_name
      HAVING COUNT(DISTINCT mp.match_id) > 0;
    `,
    );

    const leaderboard: GlobalLeaderboardRow[] = rows.map((row) => {
      const matches = parseInt(row.matches_played, 10) || 0;
      const wins = parseInt(row.wins, 10) || 0;
      const winRate = matches > 0 ? wins / matches : 0;
      return {
        agentName: row.agent_name,
        matches,
        wins,
        winRate,
      };
    });

    // Sort by winRate desc, then by matches desc, then name
    leaderboard.sort((a, b) => {
      if (b.winRate !== a.winRate) return b.winRate - a.winRate;
      if (b.matches !== a.matches) return b.matches - a.matches;
      return a.agentName.localeCompare(b.agentName);
    });

    return { totalBots, totalGames, leaderboard };
  } catch (err) {
    console.error('[db] getGlobalLeaderboard failed:', err);
    return { totalBots: 0, totalGames: 0, leaderboard: [] };
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

