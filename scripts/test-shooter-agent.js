/**
 * Quick test: run a single shooter agent with a chosen personality.
 *
 * Usage:
 *   node scripts/test-shooter-agent.js                     # Berserker (default)
 *   node scripts/test-shooter-agent.js Tactician           # specific personality
 *   node scripts/test-shooter-agent.js Predator my_api_key # custom API key
 *
 * Env:
 *   BASE_URL — Server URL (default: http://localhost:3000)
 */

import { runShooterAgent, PERSONALITIES } from './shooter-agent-logic.js';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

const personalityArg = (process.argv[2] || 'Berserker').toLowerCase();
const apiKeyArg = process.argv[3] || null;

const personalityMap = {};
for (const [key, p] of Object.entries(PERSONALITIES)) {
  personalityMap[p.name.toLowerCase()] = p;
  personalityMap[key.toLowerCase()] = p;
}

const personality = personalityMap[personalityArg];
if (!personality) {
  console.error(
    `Unknown personality: "${process.argv[2]}"\n` +
    `Available: ${Object.values(PERSONALITIES).map((p) => p.name).join(', ')}`,
  );
  process.exit(1);
}

const agent = {
  key: apiKeyArg || `test_ShooterTest_${personality.name}`,
  name: `TestAgent_${personality.name}`,
};

console.log(`\nShooter Test Agent`);
console.log(`  Personality : ${personality.name}`);
console.log(`  API Key     : ${agent.key}`);
console.log(`  Server      : ${BASE_URL}`);
console.log();

runShooterAgent(agent, personality, BASE_URL, { quiet: false }).then(() => {
  console.log('\nAgent finished.');
  process.exit(0);
}).catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
