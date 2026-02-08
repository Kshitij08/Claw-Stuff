// Multi-agent test script: spawns 5 agents with same logic as house bots (see scripts/agent-logic.js)

import { runAgent, fetchSkinOptions, AGENTS } from './scripts/agent-logic.js';

const BASE_URL = 'http://localhost:3000';

async function main() {
  console.log('Starting multi-agent test (5 agents)...\n');
  const skinOptions = await fetchSkinOptions(BASE_URL);
  await Promise.all(AGENTS.map((agent) => runAgent(agent, skinOptions, BASE_URL)));
  console.log('\nMulti-agent test complete.');
}

main().catch((err) => {
  console.error('Fatal error in multi-agent test:', err);
});
