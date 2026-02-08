/**
 * One-off script: normalize matches.winner_name from display names to canonical agent names
 * so the global leaderboard (m.winner_name = mp.agent_name) counts past wins correctly.
 *
 * Prerequisites: DATABASE_URL in .env or environment.
 * Usage: npm run normalize-winner-names
 */

import 'dotenv/config';
import { pool } from '../src/server/db.js';

const KNOWN_DISPLAY_TO_AGENT: [string, string][] = [
  ['SerpentAI', 'SerpentSage8301'],
  ['Chiyo 🐶', 'Chiyo'],
  // Add more display name → agent name pairs here if needed, e.g.:
  // ['ClawIoBot-Pacifist', 'OpenClaw_Test_Bot'],
];

async function main() {
  if (!pool) {
    console.error('[normalize-winner-names] DATABASE_URL is not set. Set it in .env or environment.');
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    let totalUpdated = 0;

    for (const [displayName, agentName] of KNOWN_DISPLAY_TO_AGENT) {
      const res = await client.query(
        `UPDATE matches SET winner_name = $1 WHERE winner_name = $2`,
        [agentName, displayName]
      );
      const count = res.rowCount ?? 0;
      if (count > 0) {
        console.log(`[normalize-winner-names] ${displayName} → ${agentName}: ${count} row(s) updated`);
        totalUpdated += count;
      }
    }

    // Fallback: for any winner_name that is not a known agent, set to the agent with
    // highest score in that match (so display-only names still count on the leaderboard)
    const fallbackRes = await client.query<{ id: string; winner_name: string }>(`
      UPDATE matches m
      SET winner_name = (
        SELECT mp.agent_name
        FROM match_players mp
        WHERE mp.match_id = m.id
        ORDER BY mp.score DESC, mp.agent_name
        LIMIT 1
      )
      WHERE m.winner_name IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.name = m.winner_name)
      RETURNING m.id, m.winner_name
    `);
    const fallbackCount = fallbackRes.rowCount ?? 0;
    if (fallbackCount > 0) {
      for (const row of fallbackRes.rows) {
        console.log(`[normalize-winner-names] match ${row.id}: winner_name set to ${row.winner_name} (by score fallback)`);
      }
      totalUpdated += fallbackCount;
    }

    if (totalUpdated === 0) {
      console.log('[normalize-winner-names] No rows needed updating.');
    } else {
      console.log(`[normalize-winner-names] Done. Total rows updated: ${totalUpdated}`);
    }
  } finally {
    client.release();
  }
}

main().catch((err) => {
  console.error('[normalize-winner-names]', err.message || err);
  process.exit(1);
});
