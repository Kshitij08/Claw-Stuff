import { Pool } from 'pg';
import { SKIN_PRESETS, DEFAULT_SKIN_ID } from '../shared/skins.js';

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
  skinId?: string;
  strategyTag?: string;
}) {
  try {
    // Ensure the match exists in the database before inserting into match_players
    await ensureMatchExists(opts.matchId);

    await dbQuery(
      `
      INSERT INTO agents (name, api_key)
      VALUES ($1, $2)
      ON CONFLICT (name) DO UPDATE
      SET api_key = EXCLUDED.api_key,
          strategy_tag = COALESCE(EXCLUDED.strategy_tag, agents.strategy_tag);
    `,
      [opts.agentName, opts.apiKey, opts.strategyTag ?? null],
    );

    await dbQuery(
      `
      INSERT INTO match_players (match_id, player_id, agent_name, color, skin_id, strategy_tag)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (match_id, agent_name) DO UPDATE
      SET player_id = EXCLUDED.player_id,
          color     = COALESCE(EXCLUDED.color, match_players.color),
          skin_id   = COALESCE(EXCLUDED.skin_id, match_players.skin_id),
          strategy_tag = COALESCE(EXCLUDED.strategy_tag, match_players.strategy_tag);
    `,
      [opts.matchId, opts.playerId, opts.agentName, opts.color ?? null, opts.skinId ?? null, opts.strategyTag ?? null],
    );
  } catch (err) {
    console.error('[db] recordAgentJoin failed:', err);
  }
}

export async function recordMatchEnd(opts: {
  matchId: string;
  /** Canonical agent name (from agents table) so leaderboard wins match correctly. */
  winnerAgentName: string | null;
  endedAt: number;
  /** Use agent_name (canonical) so match_players rows are updated correctly. */
  finalScores: { agentName: string; score: number; kills: number }[];
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
      [opts.matchId, opts.winnerAgentName, opts.endedAt],
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
        [opts.matchId, row.agentName, row.score, row.kills],
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
  strategyTag?: string | null;
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

    let leaderboard: GlobalLeaderboardRow[] = [];

    // First try the extended query that includes strategy_tag.
    try {
      const rowsWithTag = await dbQuery<{
        agent_name: string;
        matches_played: string;
        wins: string;
        strategy_tag: string | null;
      }>(
        `
        SELECT
          mp.agent_name,
          COUNT(DISTINCT mp.match_id)::text AS matches_played,
          COALESCE(SUM(CASE WHEN m.winner_name = mp.agent_name THEN 1 ELSE 0 END), 0)::text AS wins,
          MAX(mp.strategy_tag) AS strategy_tag
        FROM match_players mp
        JOIN matches m ON m.id = mp.match_id
        GROUP BY mp.agent_name
        HAVING COUNT(DISTINCT mp.match_id) > 0;
      `,
      );

      leaderboard = rowsWithTag.map((row) => {
        const matches = parseInt(row.matches_played, 10) || 0;
        const wins = parseInt(row.wins, 10) || 0;
        const winRate = matches > 0 ? wins / matches : 0;
        return {
          agentName: row.agent_name,
          matches,
          wins,
          winRate,
          strategyTag: row.strategy_tag,
        };
      });
    } catch (err) {
      // Backward‑compatible fallback for older schemas without strategy_tag.
      console.warn('[db] getGlobalLeaderboard: strategy_tag column missing, falling back to legacy query');
      const rowsLegacy = await dbQuery<{
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

      leaderboard = rowsLegacy.map((row) => {
        const matches = parseInt(row.matches_played, 10) || 0;
        const wins = parseInt(row.wins, 10) || 0;
        const winRate = matches > 0 ? wins / matches : 0;
        return {
          agentName: row.agent_name,
          matches,
          wins,
          winRate,
          strategyTag: null,
        };
      });
    }

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
 *   skin_id    text,
 *   score      integer NOT NULL DEFAULT 0,
 *   kills      integer NOT NULL DEFAULT 0,
 *   PRIMARY KEY (match_id, agent_name)
 * );
 *
 * CREATE TABLE agent_skins (
 *   agent_name text NOT NULL REFERENCES agents(name) ON DELETE CASCADE,
 *   skin_id    text NOT NULL,
 *   granted_at timestamptz NOT NULL DEFAULT now(),
 *   PRIMARY KEY (agent_name, skin_id)
 * );
 */

// ============ Skins / Cosmetics ============

export async function getAgentSkins(agentName: string): Promise<string[]> {
  // If there is no database configured, assume only the default skin is available.
  if (!pool) {
    return [DEFAULT_SKIN_ID];
  }

  try {
    const rows = await dbQuery<{ skin_id: string }>(
      `
      SELECT skin_id
      FROM agent_skins
      WHERE agent_name = $1;
    `,
      [agentName],
    );

    const owned = rows.map((r) => r.skin_id);

    // Always ensure the default skin is owned.
    if (!owned.includes(DEFAULT_SKIN_ID)) {
      owned.push(DEFAULT_SKIN_ID);
    }

    // Filter to preset skin IDs (custom JSON combos are not in agent_skins).
    const validIds = new Set(Object.keys(SKIN_PRESETS));
    const uniqueOwned = Array.from(new Set(owned)).filter((id) => validIds.has(id));

    return uniqueOwned.length > 0 ? uniqueOwned : [DEFAULT_SKIN_ID];
  } catch (err) {
    console.error('[db] getAgentSkins failed:', err);
    return [DEFAULT_SKIN_ID];
  }
}

export async function grantSkinToAgent(agentName: string, skinId: string): Promise<void> {
  if (!pool) {
    console.warn('[db] DATABASE_URL not set, skipping grantSkinToAgent');
    return;
  }

  const validIds = new Set(Object.keys(SKIN_PRESETS));
  if (!validIds.has(skinId)) {
    console.warn(`[db] grantSkinToAgent called with unknown preset skinId: ${skinId}`);
    return;
  }

  try {
    await dbQuery(
      `
      INSERT INTO agent_skins (agent_name, skin_id)
      VALUES ($1, $2)
      ON CONFLICT (agent_name, skin_id) DO NOTHING;
    `,
      [agentName, skinId],
    );
  } catch (err) {
    console.error('[db] grantSkinToAgent failed:', err);
  }
}

export async function agentOwnsSkin(agentName: string, skinId: string): Promise<boolean> {
  // Always allow default skin.
  if (skinId === DEFAULT_SKIN_ID) {
    return true;
  }

  if (!pool) {
    // Without a database, only default is guaranteed.
    return false;
  }

  try {
    const rows = await dbQuery<{ exists: boolean }>(
      `
      SELECT EXISTS (
        SELECT 1
        FROM agent_skins
        WHERE agent_name = $1 AND skin_id = $2
      ) AS exists;
    `,
      [agentName, skinId],
    );

    return rows.length > 0 && !!rows[0].exists;
  } catch (err) {
    console.error('[db] agentOwnsSkin failed:', err);
    return false;
  }
}


