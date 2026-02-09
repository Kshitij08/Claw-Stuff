/**
 * Shared agent logic for test-multi-agent and run-house-bots.
 * One place for the same bot behavior (steering, food chase, survival).
 */

const FALLBACK_SKIN_IDS = ['default', 'neon', 'cyber'];

export async function fetchSkinOptions(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/api/skins/options`);
    const data = await res.json();
    if (data.bodies?.length && data.eyes?.length && data.mouths?.length) {
      return data;
    }
  } catch (err) {
    console.warn('Could not fetch skin options:', err.message);
  }
  return null;
}

export function randomSkinFromOptions(options) {
  if (!options) {
    return { skinId: FALLBACK_SKIN_IDS[Math.floor(Math.random() * FALLBACK_SKIN_IDS.length)] };
  }
  return {
    bodyId: options.bodies[Math.floor(Math.random() * options.bodies.length)],
    eyesId: options.eyes[Math.floor(Math.random() * options.eyes.length)],
    mouthId: options.mouths[Math.floor(Math.random() * options.mouths.length)],
  };
}

// Default dev agents (test_ keys) – safe for localhost only.
const DEFAULT_AGENTS = [
  { key: 'test_OpenClaw_Test_Bot', name: 'OpenClaw_Test_Bot', color: '#FF6B6B' },
  { key: 'test_FiverrClawOfficial', name: 'FiverrClawOfficial', color: '#45B7D1' },
  { key: 'test_monke', name: 'monke', color: '#4ECDC4' },
  { key: 'test_Stromfee', name: 'Stromfee', color: '#BB8FCE' },
  { key: 'test_moltscreener', name: 'moltscreener', color: '#F7DC6F' },
];

// In production / against Railway, override via HOUSE_BOT_AGENTS env var:
// HOUSE_BOT_AGENTS='[{"key":"moltbook_sk_...","name":"OpenClaw_Test_Bot","color":"#FF6B6B"}, ... ]'
function loadAgentsFromEnv() {
  const raw = process.env.HOUSE_BOT_AGENTS;
  if (!raw) return DEFAULT_AGENTS;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every(a => typeof a.key === 'string' && typeof a.name === 'string')) {
      return parsed;
    }
  } catch {
    // fall back to defaults on parse/shape error
  }
  return DEFAULT_AGENTS;
}

export const AGENTS = loadAgentsFromEnv();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

function getAngleTo(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (angle < 0) angle += 360;
  return angle;
}

function normalizeAngle(angle) {
  angle = angle % 360;
  if (angle < 0) angle += 360;
  return angle;
}

function getShortestTurn(from, to) {
  let diff = normalizeAngle(to) - normalizeAngle(from);
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return diff;
}

function distance(p1, p2) {
  return Math.sqrt((p1.x - p2.x) ** 2 + (p1.y - p2.y) ** 2);
}

function isTooCloseToSegments(point, segments, minDistance, skipFirst = 0) {
  for (let i = skipFirst; i < segments.length; i++) {
    const seg = segments[i];
    if (distance(point, { x: seg[0], y: seg[1] }) < minDistance) {
      return true;
    }
  }
  return false;
}

function checkSelfCollision(myPos, angle, mySegments, checkDistance = 60) {
  const rad = (angle * Math.PI) / 180;
  for (let dist = 20; dist <= checkDistance; dist += 20) {
    const checkPoint = {
      x: myPos.x + Math.cos(rad) * dist,
      y: myPos.y + Math.sin(rad) * dist,
    };
    if (isTooCloseToSegments(checkPoint, mySegments, 15, 10)) {
      return true;
    }
  }
  return false;
}

/**
 * Join, wait for match start, then run game loop until match ends or snake dies.
 * Uses baseUrl for all API calls.
 */
export async function runAgent({ key, name, color }, skinOptions, baseUrl, options = {}) {
  const { quiet = false } = options;
  const HEADERS = makeHeaders(key);
  const prefix = `[${name}]`;

  if (!quiet) console.log(`${prefix} Starting...`);

  const skin = randomSkinFromOptions(skinOptions);
  const joinBody = { displayName: name, color, ...skin };
  if (!quiet) console.log(`${prefix} Joining match...`);
  const joinRes = await fetch(`${baseUrl}/api/match/join`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(joinBody),
  });
  const join = await joinRes.json();

  if (!join.success) {
    if (!quiet) console.log(`${prefix} Failed to join: ${join.message}`);
    return;
  }

  if (!quiet) {
    const skinDesc = skin.skinId ? skin.skinId : `${skin.bodyId} + ${skin.eyesId} + ${skin.mouthId}`;
    console.log(`${prefix} Joined as ${join.playerId} (${color}, skin: ${skinDesc})`);
  }

  if (!quiet) console.log(`${prefix} Waiting for match to start...`);
  let state;
  while (true) {
    const stateRes = await fetch(`${baseUrl}/api/match/current`, { headers: HEADERS });
    state = await stateRes.json();

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

  let lastScore = 0;
  let tickCount = 0;

  while (true) {
    try {
      const stateRes = await fetch(`${baseUrl}/api/match/current`, { headers: HEADERS });
      state = await stateRes.json();

      if (state.phase !== 'active') {
        if (!quiet) console.log(`${prefix} Match ended (phase=${state.phase}). Final score=${lastScore}`);
        break;
      }

      if (!state.you || !state.you.alive) {
        if (!quiet) console.log(`${prefix} Died. Final score=${state.you?.score ?? lastScore}`);
        break;
      }

      const me = state.you;
      const myPos = { x: me.x, y: me.y };

      const timeLeft = state.timeRemaining ?? 0;
      const earlyGame = timeLeft > 180;
      const lateGame = timeLeft <= 60;
      const midGame = !earlyGame && !lateGame;

      const isLeader =
        Array.isArray(state.leaderboard) &&
        state.leaderboard.length > 0 &&
        state.leaderboard[0].id === me.id;

      let nearestEnemy = null;
      let nearestEnemyDist = Infinity;
      for (const enemy of state.players || []) {
        if (!enemy.alive) continue;
        const enemyHead = { x: enemy.x, y: enemy.y };
        const d = distance(myPos, enemyHead);
        if (d < nearestEnemyDist) {
          nearestEnemyDist = d;
          nearestEnemy = enemy;
        }
      }

      const enemyIsSmaller = nearestEnemy && me.length > nearestEnemy.length * 1.3;
      const enemyIsBigger = nearestEnemy && nearestEnemy.length > me.length * 1.2;
      const enemyClose = nearestEnemy && nearestEnemyDist < 200;

      let targetAngle = me.angle;
      let bestFood = null;
      let bestScore = -Infinity;
      let minDist = Infinity;

      for (const food of state.food) {
        const foodPos = { x: food.x, y: food.y };
        const d = distance(myPos, foodPos);
        const angleToFood = getAngleTo(myPos, foodPos);
        const turnNeeded = Math.abs(getShortestTurn(me.angle, angleToFood));
        const turnPenalty = turnNeeded > 90 ? 500 : turnNeeded * 2;
        const score = -d - turnPenalty;
        if (score > bestScore) {
          bestScore = score;
          bestFood = food;
          minDist = d;
        }
      }

      if (bestFood) {
        targetAngle = getAngleTo(myPos, { x: bestFood.x, y: bestFood.y });
      }

      if (
        nearestEnemy &&
        enemyIsSmaller &&
        enemyClose &&
        (midGame || (lateGame && !isLeader))
      ) {
        const enemyPos = { x: nearestEnemy.x, y: nearestEnemy.y };
        targetAngle = getAngleTo(myPos, enemyPos);
      }

      if (nearestEnemy && enemyIsBigger && nearestEnemyDist < 150) {
        const enemyPos = { x: nearestEnemy.x, y: nearestEnemy.y };
        const angleToEnemy = getAngleTo(myPos, enemyPos);
        targetAngle = normalizeAngle(angleToEnemy + 180);
      }

      let selfDanger = false;
      if (me.segments.length > 15) {
        selfDanger = checkSelfCollision(myPos, me.angle, me.segments);
        if (selfDanger) {
          const leftAngle = normalizeAngle(me.angle - 45);
          const rightAngle = normalizeAngle(me.angle + 45);
          const leftSafe = !checkSelfCollision(myPos, leftAngle, me.segments);
          const rightSafe = !checkSelfCollision(myPos, rightAngle, me.segments);
          if (leftSafe && !rightSafe) {
            targetAngle = leftAngle;
          } else if (rightSafe && !leftSafe) {
            targetAngle = rightAngle;
          } else if (leftSafe && rightSafe) {
            const leftTurn = Math.abs(getShortestTurn(me.angle, leftAngle));
            const rightTurn = Math.abs(getShortestTurn(me.angle, rightAngle));
            targetAngle = leftTurn < rightTurn ? leftAngle : rightAngle;
          } else {
            targetAngle = normalizeAngle(me.angle + 90);
          }
        }
      }

      let turn = getShortestTurn(me.angle, targetAngle);
      let maxTurn = 20;
      if (selfDanger) maxTurn = 45;
      else if (Math.abs(turn) < 10) maxTurn = 10;
      turn = Math.max(-maxTurn, Math.min(maxTurn, turn));

      await fetch(`${baseUrl}/api/match/action`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ action: 'steer', angleDelta: turn }),
      });

      tickCount++;
      if (!quiet && (tickCount % 20 === 0 || me.score !== lastScore)) {
        const logTime = Math.floor(timeLeft);
        const foodInfo = bestFood ? `Food=${Math.round(minDist)}u` : 'No food';
        const status = selfDanger ? 'SELF' : '';
        console.log(`${prefix} [${logTime}s] score=${me.score} len=${me.length} ${foodInfo} turn=${turn.toFixed(0)} ${status}`);
        lastScore = me.score;
      }

      await sleep(200);
    } catch (err) {
      if (!quiet) console.error(`${prefix} Error:`, err.message || err);
      await sleep(1000);
    }
  }
}
