/**
 * Multi-agent script for Claw Shooter (production): runs 5 named bots against Railway/prod.
 * Each bot joins the shooter lobby; when 2+ have joined, a 90s countdown starts and the match begins.
 *
 * Loads .env; required there or in env:
 *   PROD_BOT_AGENTS  JSON array of { key, name, color } for each bot (same as snake).
 * Optional: CLAW_IO_BASE_URL (default https://claw-io.up.railway.app)
 */

import 'dotenv/config';
import { runShooterAgent } from './scripts/shooter-agent-logic.js';

const BASE_URL = process.env.CLAW_IO_BASE_URL || 'https://claw-io.up.railway.app';

const PROD_BOT_NAMES = [
  'OpenClaw_Test_Bot',
  'SerpentSage8301',
  'PixelatedPixieDust',
  'Caramelo',
  'Nevo',
];

const DEFAULT_COLORS = [
  '#FF6B6B',
  '#45B7D1',
  '#96CEB4',
  '#FFEAA7',
  '#DDA0DD',
];

function loadProdAgents() {
  const raw = process.env.PROD_BOT_AGENTS;
  if (!raw) {
    console.error('Missing PROD_BOT_AGENTS. Set it to a JSON array of { key, name, color } for each bot.');
    console.error('Example: PROD_BOT_AGENTS=\'[{"key":"sk_...","name":"OpenClaw_Test_Bot","color":"#FF6B6B"}, ...]\'');
    process.exit(1);
  }
  try {
    const jsonStr = raw.replace(/\\"/g, '"');
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      console.error('PROD_BOT_AGENTS must be a non-empty array.');
      process.exit(1);
    }
    const byName = new Map(parsed.map((a) => [a.name, a]));
    const agents = [];
    for (let i = 0; i < PROD_BOT_NAMES.length; i++) {
      const name = PROD_BOT_NAMES[i];
      const entry = byName.get(name);
      if (!entry || typeof entry.key !== 'string') {
        console.error(`Missing or invalid PROD_BOT_AGENTS entry for name "${name}".`);
        process.exit(1);
      }
      agents.push({
        key: entry.key,
        name: entry.name,
        color: entry.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length],
      });
    }
    return agents;
  } catch (e) {
    console.error('Invalid PROD_BOT_AGENTS JSON:', e.message);
    process.exit(1);
  }
}

const PROD_AGENTS = loadProdAgents();

async function main() {
  console.log(`Starting 5 shooter bots in prod: ${BASE_URL}\n`);
  console.log('Bots:', PROD_AGENTS.map((a) => a.name).join(', '));
  console.log('');

  await Promise.all(PROD_AGENTS.map((agent) => runShooterAgent(agent, BASE_URL)));
  console.log('\nMulti-agent shooter prod run complete.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
