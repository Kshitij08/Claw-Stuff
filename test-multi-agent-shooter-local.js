/**
 * Multi-agent script for Claw Shooter (localhost): runs 5 named bots against the local dev server.
 * Each bot joins the shooter lobby; when 2+ have joined, a 90s countdown starts and the match begins.
 *
 * Uses test_ prefixed API keys that work in DEV_MODE (NODE_ENV !== 'production').
 * No .env keys needed — just start the backend with `npm run dev` and run this script.
 *
 * Usage:
 *   node test-multi-agent-shooter-local.js
 */

import { runShooterAgent } from './scripts/shooter-agent-logic.js';

const BASE_URL = process.env.CLAW_IO_BASE_URL || 'http://localhost:3000';

const LOCAL_AGENTS = [
  { key: 'test_OpenClaw_Test_Bot', name: 'OpenClaw_Test_Bot', color: '#FF6B6B' },
  { key: 'test_SerpentSage8301', name: 'SerpentSage8301', color: '#45B7D1' },
  { key: 'test_PixelatedPixieDust', name: 'PixelatedPixieDust', color: '#96CEB4' },
  { key: 'test_Caramelo', name: 'Caramelo', color: '#FFEAA7' },
  { key: 'test_Nevo', name: 'Nevo', color: '#DDA0DD' },
];

async function main() {
  console.log(`Starting 5 shooter bots locally: ${BASE_URL}\n`);
  console.log('Bots:', LOCAL_AGENTS.map((a) => a.name).join(', '));
  console.log('');

  await Promise.all(LOCAL_AGENTS.map((agent) => runShooterAgent(agent, BASE_URL)));
  console.log('\nMulti-agent shooter local run complete.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
