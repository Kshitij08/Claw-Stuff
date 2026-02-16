/**
 * Test shooter agent – plays the Claw Shooter game via REST API.
 *
 * Usage:
 *   node scripts/test-shooter-agent.js [API_KEY] [DISPLAY_NAME] [SERVER_URL]
 *
 * Defaults:
 *   API_KEY      = test_shooter_bot_1
 *   DISPLAY_NAME = TestShooterBot
 *   SERVER_URL   = http://localhost:3000
 */

const API_KEY = process.argv[2] || 'test_shooter_bot_1';
const DISPLAY_NAME = process.argv[3] || 'TestShooterBot';
const BASE_URL = process.argv[4] || 'http://localhost:3000';

const HEADERS = {
  'Authorization': `Bearer ${API_KEY}`,
  'Content-Type': 'application/json',
};

const TICK_MS = 200; // 5 actions per second

// ── Helpers ────────────────────────────────────────────────────────

function angleTo(from, to) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  return (Math.atan2(dz, dx) * 180) / Math.PI;
}

function dist(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);
}

async function post(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  return res.json();
}

async function get(path) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: HEADERS });
  return res.json();
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log(`[Agent] Starting ${DISPLAY_NAME} (key=${API_KEY})`);
  console.log(`[Agent] Server: ${BASE_URL}`);

  // Wait for lobby
  let joined = false;
  while (!joined) {
    try {
      const status = await get('/api/shooter/status');
      const phase = status.currentMatch?.phase;
      console.log(`[Agent] Match phase: ${phase ?? 'none'}, players: ${status.currentMatch?.playerCount ?? 0}`);

      if (phase === 'lobby' || phase === 'countdown' || phase === 'active') {
        const joinResp = await post('/api/shooter/join', {
          displayName: DISPLAY_NAME,
          strategyTag: 'Test Bot',
        });
        console.log(`[Agent] Join response:`, joinResp);
        if (joinResp.success) {
          joined = true;
        }
      }
    } catch (err) {
      console.error(`[Agent] Error checking status:`, err.message);
    }

    if (!joined) {
      await sleep(3000);
    }
  }

  // Game loop
  console.log(`[Agent] Entering game loop`);
  let wanderAngle = Math.random() * 360;
  let lastWanderChange = Date.now();

  while (true) {
    try {
      const state = await get('/api/shooter/state');

      if (!state || state.phase === 'finished') {
        console.log('[Agent] Match finished, waiting for next...');
        joined = false;
        await sleep(5000);

        // Try to rejoin
        while (!joined) {
          try {
            const joinResp = await post('/api/shooter/join', {
              displayName: DISPLAY_NAME,
              strategyTag: 'Test Bot',
            });
            if (joinResp.success) {
              joined = true;
              console.log('[Agent] Rejoined!');
            }
          } catch { /* retry */ }
          if (!joined) await sleep(3000);
        }
        continue;
      }

      if (state.phase !== 'active' || !state.you || !state.you.alive) {
        await sleep(1000);
        continue;
      }

      const me = state.you;
      const enemies = (state.players || []).filter((p) => p.alive);
      const pickups = state.weaponPickups || [];

      // Priority 1: Get a gun if knife-only
      if (me.weapon === 'knife' && pickups.length > 0) {
        const nearest = pickups.reduce((best, p) =>
          dist(me, p) < dist(me, best) ? p : best
        );
        const d = dist(me, nearest);
        if (d < 1.5) {
          await post('/api/shooter/action', { action: 'pickup' });
        } else {
          const angle = angleTo(me, nearest);
          await post('/api/shooter/action', { action: 'move', angle });
        }
        await sleep(TICK_MS);
        continue;
      }

      // Priority 2: Fight enemies
      if (enemies.length > 0) {
        const nearest = enemies.reduce((best, e) =>
          dist(me, e) < dist(me, best) ? e : best
        );
        const d = dist(me, nearest);

        if (me.weapon === 'knife') {
          // Rush with knife
          if (d < 2.5) {
            await post('/api/shooter/action', { action: 'melee' });
          } else {
            const angle = angleTo(me, nearest);
            await post('/api/shooter/action', { action: 'move', angle });
          }
        } else {
          // Shoot
          const aim = angleTo(me, nearest);
          await post('/api/shooter/action', { action: 'shoot', aimAngle: aim });

          // Strafe
          const strafe = aim + (Math.random() > 0.5 ? 90 : -90);
          await post('/api/shooter/action', { action: 'move', angle: strafe });
        }

        await sleep(TICK_MS);
        continue;
      }

      // Priority 3: Wander
      if (Date.now() - lastWanderChange > 2000) {
        wanderAngle = Math.random() * 360;
        lastWanderChange = Date.now();
      }
      await post('/api/shooter/action', { action: 'move', angle: wanderAngle });

      // Also look for pickups while wandering
      if (pickups.length > 0 && me.weapon === 'knife') {
        const nearest = pickups.reduce((best, p) =>
          dist(me, p) < dist(me, best) ? p : best
        );
        wanderAngle = angleTo(me, nearest);
      }

    } catch (err) {
      console.error(`[Agent] Error:`, err.message);
    }

    await sleep(TICK_MS);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch(console.error);
