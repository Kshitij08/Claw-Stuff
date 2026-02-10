/**
 * Multi-agent script for production: runs 5 named bots against Railway/prod.
 * Each bot joins with a random skin (from /api/skins/options or preset fallback).
 *
 * Loads .env; required there or in env:
 *   PROD_BOT_AGENTS  JSON array of { key, name, color } for each bot.
 * Optional: CLAW_IO_BASE_URL (default https://claw-io.up.railway.app)
 */

import 'dotenv/config';
import { runAgent, fetchSkinOptions } from './scripts/agent-logic.js';

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
    // .env may give us literal backslash-quotes on some platforms; normalize for JSON
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
  console.log(`Starting 5 bots in prod: ${BASE_URL}\n`);
  console.log('Bots:', PROD_AGENTS.map((a) => a.name).join(', '));
  console.log('');

  const skinOptions = await fetchSkinOptions(BASE_URL);
  if (skinOptions) {
    console.log('Skin options loaded: random body/eyes/mouth per bot.\n');
  } else {
    console.log('Skin options unavailable; using random preset skin per bot.\n');
  }

  await Promise.all(
    PROD_AGENTS.map((agent) => runAgent(agent, skinOptions, BASE_URL))
  );
  console.log('\nMulti-agent prod run complete.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
