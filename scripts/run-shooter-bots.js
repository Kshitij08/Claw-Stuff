/**
 * Keeps the shooter lobby filled with house bots. When a new lobby opens,
 * joins agents and runs them until the match ends, then repeats.
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 node scripts/run-shooter-bots.js
 *   Or: npm run shooter-bots
 */

import { runShooterAgent } from './shooter-agent-logic.js';

const BASE_URL = process.env.SHOOTER_BOTS_BASE_URL || process.env.BASE_URL || 'http://localhost:3000';
const BOT_COUNT = parseInt(process.env.SHOOTER_BOT_COUNT || '3', 10);
const POLL_MS = 2000;
const QUIET = process.env.SHOOTER_BOTS_QUIET === '1' || process.env.SHOOTER_BOTS_QUIET === 'true';

const DEFAULT_AGENTS = [
  { key: 'test_ShooterBot_Alpha', name: 'Alpha' },
  { key: 'test_ShooterBot_Bravo', name: 'Bravo' },
  { key: 'test_ShooterBot_Charlie', name: 'Charlie' },
  { key: 'test_ShooterBot_Delta', name: 'Delta' },
  { key: 'test_ShooterBot_Echo', name: 'Echo' },
];

function loadAgents() {
  const raw = process.env.SHOOTER_BOT_AGENTS;
  if (!raw) return DEFAULT_AGENTS.slice(0, BOT_COUNT);
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every(a => typeof a.key === 'string' && typeof a.name === 'string')) {
      return parsed.slice(0, BOT_COUNT);
    }
  } catch { /* fall through */ }
  return DEFAULT_AGENTS.slice(0, BOT_COUNT);
}

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
  const agents = loadAgents();
  console.log(`[ShooterBots] BASE_URL=${BASE_URL}, ${agents.length} bots: ${agents.map(a => a.name).join(', ')}\n`);

  let lastJoinedMatchId = null;

  while (true) {
    try {
      const status = await getShooterStatus();
      if (!status?.currentMatch) {
        await sleep(POLL_MS);
        continue;
      }

      const { phase, id: matchId } = status.currentMatch;

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
        console.log(`[ShooterBots] New lobby ${matchId}. Joining ${agents.length} bots...`);
      }

      // Stagger joins slightly to avoid race with the 5s lobby countdown
      const runners = agents.map((agent, i) =>
        new Promise((resolve) => setTimeout(resolve, i * 300)).then(() =>
          runShooterAgent(agent, BASE_URL, { quiet: QUIET })
        )
      );
      await Promise.all(runners);

      if (!QUIET) {
        console.log(`[ShooterBots] Match ended. Waiting for next lobby...\n`);
      }
    } catch (err) {
      console.error('[ShooterBots] Error:', err.message || err);
      await sleep(5000);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error in shooter bots:', err);
  process.exit(1);
});
