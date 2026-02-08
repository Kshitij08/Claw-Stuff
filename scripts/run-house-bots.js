/**
 * Keeps the lobby filled with 5 house bots. When a new lobby opens, joins 5 agents
 * (same logic as test-multi-agent) and runs them until the match ends, then repeats.
 * New external bots can join the same lobby before the countdown ends.
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 node scripts/run-house-bots.js
 *   Or: npm run house-bots
 *
 * On Railway, run this as a separate process or worker with BASE_URL pointing to your app.
 */

import { runAgent, fetchSkinOptions, AGENTS } from './agent-logic.js';

const BASE_URL = process.env.HOUSE_BOTS_BASE_URL || process.env.BASE_URL || 'http://localhost:3000';
const POLL_MS = 2000;
const QUIET = process.env.HOUSE_BOTS_QUIET === '1' || process.env.HOUSE_BOTS_QUIET === 'true';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getStatus() {
  const res = await fetch(`${BASE_URL}/api/status`);
  if (!res.ok) return null;
  return res.json();
}

async function main() {
  console.log(`House bots runner: BASE_URL=${BASE_URL} (5 bots, same logic as test-multi-agent)\n`);

  let lastJoinedMatchId = null;
  const skinOptions = await fetchSkinOptions(BASE_URL);

  while (true) {
    try {
      const status = await getStatus();
      if (!status?.currentMatch) {
        await sleep(POLL_MS);
        continue;
      }

      const { phase, id: matchId, playerCount } = status.currentMatch;

      if (phase !== 'lobby') {
        lastJoinedMatchId = null;
        await sleep(POLL_MS);
        continue;
      }

      if (matchId === lastJoinedMatchId) {
        await sleep(POLL_MS);
        continue;
      }

      lastJoinedMatchId = matchId;
      if (!QUIET) {
        console.log(`[HouseBots] New lobby ${matchId} (${playerCount} players). Joining 5 bots...`);
      }

      const runners = AGENTS.map((agent) =>
        runAgent(agent, skinOptions, BASE_URL, { quiet: QUIET })
      );
      await Promise.all(runners);

      if (!QUIET) {
        console.log(`[HouseBots] Match ended. Waiting for next lobby...\n`);
      }
    } catch (err) {
      console.error('[HouseBots] Error:', err.message || err);
      await sleep(5000);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error in house bots:', err);
  process.exit(1);
});
