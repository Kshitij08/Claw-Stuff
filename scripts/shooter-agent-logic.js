/**
 * Shooter agent logic: join, wait for match start, run game loop (move + shoot) until match ends or agent is out.
 * Uses baseUrl for /api/shooter/* endpoints.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

function distance(x1, z1, x2, z2) {
  return Math.sqrt((x2 - x1) ** 2 + (z2 - z1) ** 2);
}

/** Angle in radians from (x1,z1) toward (x2,z2). 0 = +z, π/2 = +x */
function angleTo(x1, z1, x2, z2) {
  return Math.atan2(x2 - x1, z2 - z1);
}

/** Parse JSON from response; throw clear error if server returned HTML (e.g. 404 or wrong base URL). */
async function parseJsonResponse(res, url) {
  const contentType = res.headers.get('content-type') || '';
  const text = await res.text();
  if (!contentType.includes('application/json')) {
    const snippet = text.slice(0, 80).replace(/\s+/g, ' ');
    throw new Error(
      `Server returned ${res.status} (expected JSON). Is the shooter API deployed? URL: ${url}. Response: ${snippet}...`
    );
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON from ${url}: ${e.message}. Response: ${text.slice(0, 100)}...`);
  }
}

/**
 * Join shooter lobby, wait for phase active, then run game loop until match ends or agent is dead.
 * Agent strategy: move toward nearest pickup or nearest enemy; shoot when enemy in range.
 */
export async function runShooterAgent({ key, name }, baseUrl, options = {}) {
  const { quiet = false } = options;
  const HEADERS = makeHeaders(key);
  const prefix = `[${name}]`;

  if (!quiet) console.log(`${prefix} Shooter: starting...`);

  const statusUrl = `${baseUrl}/api/shooter/status`;
  const joinRes = await fetch(statusUrl, { headers: HEADERS });
  const status = await parseJsonResponse(joinRes, statusUrl);
  const current = status.currentMatch;
  if (!current || (current.phase !== 'lobby' && current.phase !== 'countdown')) {
    if (!quiet) console.log(`${prefix} No shooter lobby open (current: ${current?.phase ?? 'none'}). Exiting.`);
    return;
  }

  if (!quiet) console.log(`${prefix} Joining shooter match...`);
  const joinBody = { displayName: name, characterId: `G_${(Math.floor(Math.random() * 10) % 10) + 1}` };
  const joinUrl = `${baseUrl}/api/shooter/match/join`;
  const joinPost = await fetch(joinUrl, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(joinBody),
  });
  const join = await parseJsonResponse(joinPost, joinUrl);

  if (!join.success) {
    if (!quiet) console.log(`${prefix} Failed to join: ${join.message}`);
    return;
  }

  if (!quiet) console.log(`${prefix} Joined as ${join.playerId}. Match starts at ${join.startsAt ? new Date(join.startsAt).toISOString() : 'TBD'}`);

  if (!quiet) console.log(`${prefix} Waiting for match to start...`);
  let state;
  const currentUrl = `${baseUrl}/api/shooter/match/current`;
  while (true) {
    const res = await fetch(currentUrl, { headers: HEADERS });
    state = await parseJsonResponse(res, currentUrl);
    if (state.phase === 'active') {
      if (!quiet) console.log(`${prefix} Match started!`);
      break;
    }
    if (state.phase === 'finished') {
      if (!quiet) console.log(`${prefix} Match already finished. Exiting.`);
      return;
    }
    await sleep(500);
  }

  let tickCount = 0;
  while (true) {
    try {
      const res = await fetch(currentUrl, { headers: HEADERS });
      state = await parseJsonResponse(res, currentUrl);

      if (state.phase !== 'active') {
        if (!quiet) console.log(`${prefix} Match ended (phase=${state.phase}).`);
        break;
      }

      const me = state.you;
      if (!me || !me.alive) {
        if (!quiet) console.log(`${prefix} Out of lives. Final score=${me?.score ?? 0} kills=${me?.kills ?? 0}`);
        break;
      }

      const myX = me.x;
      const myZ = me.z;
      const myAngle = me.angle;

      let targetAngle = myAngle;
      let shouldShoot = false;

      const enemies = (state.players || []).filter((p) => p.alive);
      let nearestEnemy = null;
      let nearestEnemyDist = Infinity;
      for (const e of enemies) {
        const d = distance(myX, myZ, e.x, e.z);
        if (d < nearestEnemyDist) {
          nearestEnemyDist = d;
          nearestEnemy = e;
        }
      }

      const pickups = state.pickups || [];
      let nearestPickup = null;
      let nearestPickupDist = Infinity;
      for (const p of pickups) {
        const d = distance(myX, myZ, p.x, p.z);
        if (d < nearestPickupDist) {
          nearestPickupDist = d;
          nearestPickup = p;
        }
      }

      const shootRange = 25;
      if (nearestEnemy && nearestEnemyDist < shootRange) {
        targetAngle = angleTo(myX, myZ, nearestEnemy.x, nearestEnemy.z);
        shouldShoot = true;
      } else if (nearestPickup && nearestPickupDist < 50) {
        targetAngle = angleTo(myX, myZ, nearestPickup.x, nearestPickup.z);
      } else if (nearestEnemy) {
        targetAngle = angleTo(myX, myZ, nearestEnemy.x, nearestEnemy.z);
        if (nearestEnemyDist < shootRange + 10) shouldShoot = true;
      } else if (nearestPickup) {
        targetAngle = angleTo(myX, myZ, nearestPickup.x, nearestPickup.z);
      }

      await fetch(`${baseUrl}/api/shooter/match/action`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ angle: targetAngle, shoot: shouldShoot, move: true }),
      });

      tickCount++;
      if (!quiet && tickCount % 30 === 0) {
        const timeLeft = Math.floor(state.timeRemaining ?? 0);
        console.log(`${prefix} [${timeLeft}s] score=${me.score} kills=${me.kills} lives=${me.lives} hp=${me.health}`);
      }

      await sleep(80);
    } catch (err) {
      if (!quiet) console.error(`${prefix} Error:`, err.message || err);
      await sleep(1000);
    }
  }
}
