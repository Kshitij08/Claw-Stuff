/**
 * Keeps the shooter lobby filled with 5 house bots — one per personality.
 *
 * When a new shooter lobby opens, joins 5 agents (Berserker, Predator, Tactician,
 * Opportunist, Psychopath) and runs them until the match ends, then repeats.
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 node scripts/run-shooter-house-bots.js
 *   Or: npm run shooter-house-bots
 *
 * Env vars:
 *   BASE_URL / SHOOTER_HOUSE_BOTS_BASE_URL  — Server URL (default: localhost:3000)
 *   SHOOTER_HOUSE_BOT_AGENTS                — JSON array of [{key, name}] for production
 *   SHOOTER_HOUSE_BOTS_QUIET                — Set to "1" to suppress per-tick logs
 */

import { runShooterAgent, PERSONALITIES, SHOOTER_AGENTS } from './shooter-agent-logic.js';

const BASE_URL =
  process.env.SHOOTER_HOUSE_BOTS_BASE_URL ||
  process.env.BASE_URL ||
  'http://localhost:3000';

const POLL_MS = 2000;
const QUIET =
  process.env.SHOOTER_HOUSE_BOTS_QUIET === '1' ||
  process.env.SHOOTER_HOUSE_BOTS_QUIET === 'true';

const PERSONALITY_ORDER = [
  PERSONALITIES.BERSERKER,
  PERSONALITIES.PREDATOR,
  PERSONALITIES.TACTICIAN,
  PERSONALITIES.OPPORTUNIST,
  PERSONALITIES.PSYCHOPATH,
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getShooterStatus() {
  try {
    const res = await fetch(`${BASE_URL}/api/shooter/status`);
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function main() {
  console.log(
    `[ShooterHouseBots] BASE_URL=${BASE_URL} (5 bots for testing, 5 personalities)\n`,
  );

  let lastJoinedMatchId = null;

  while (true) {
    try {
      const status = await getShooterStatus();
      if (!status?.currentMatch) {
        await sleep(POLL_MS);
        continue;
      }

      const { phase, id: matchId } = status.currentMatch;

      if (phase !== 'lobby' && phase !== 'countdown') {
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
        console.log(`[ShooterHouseBots] New lobby ${matchId}. Joining 5 bots...`);
      }

      // Spawn only 5 bots for testing (one per personality)
      const agents = SHOOTER_AGENTS.slice(0, 5);
      const runners = agents.map((agent, i) => {
        const personality = PERSONALITY_ORDER[i % PERSONALITY_ORDER.length];
        return runShooterAgent(agent, personality, BASE_URL, { quiet: QUIET });
      });

      await Promise.all(runners);

      if (!QUIET) {
        console.log(`[ShooterHouseBots] Match ended. Waiting for next lobby...\n`);
      }
    } catch (err) {
      console.error('[ShooterHouseBots] Error:', err.message || err);
      await sleep(5000);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error in shooter house bots:', err);
  process.exit(1);
});
