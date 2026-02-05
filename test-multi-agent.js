// Multi-agent test script: spawns 5 agents with different names and colors

const BASE_URL = 'http://localhost:3000';

// Each agent gets its own test API key, name, and color
const AGENTS = [
  { key: 'test_OpenClaw_Test_Bot', name: 'OpenClaw_Test_Bot', color: '#FF6B6B' },
  { key: 'test_FiverrClawOfficial', name: 'FiverrClawOfficial', color: '#45B7D1' },
  { key: 'test_MonkeNigga', name: 'MonkeNigga', color: '#4ECDC4' },
  { key: 'test_Stromfee', name: 'Stromfee', color: '#BB8FCE' },
  { key: 'test_moltscreener', name: 'moltscreener', color: '#F7DC6F' },
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeHeaders(apiKey) {
  return {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

function getAngleTo(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let angle = Math.atan2(dy, dx) * 180 / Math.PI;
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
  const rad = angle * Math.PI / 180;
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

async function runAgent({ key, name, color }) {
  const HEADERS = makeHeaders(key);
  const prefix = `[${name}]`;

  console.log(`${prefix} Starting...`);

  // Join match
  console.log(`${prefix} Joining match...`);
  const joinRes = await fetch(`${BASE_URL}/api/match/join`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ displayName: name, color }),
  });
  const join = await joinRes.json();

  if (!join.success) {
    console.log(`${prefix} Failed to join: ${join.message}`);
    return;
  }

  console.log(`${prefix} Joined as ${join.playerId} (${color})`);

  // Wait for match to start
  console.log(`${prefix} Waiting for match to start...`);
  let state;
  while (true) {
    const stateRes = await fetch(`${BASE_URL}/api/match/current`, { headers: HEADERS });
    state = await stateRes.json();

    if (state.phase === 'active') {
      console.log(`${prefix} Match started!`);
      break;
    }
    if (state.phase === 'finished') {
      console.log(`${prefix} Match already finished. Exiting.`);
      return;
    }
    await sleep(500);
  }

  // Game loop
  let lastScore = 0;
  let tickCount = 0;

  while (true) {
    try {
      const stateRes = await fetch(`${BASE_URL}/api/match/current`, { headers: HEADERS });
      state = await stateRes.json();

      if (state.phase !== 'active') {
        console.log(`${prefix} Match ended (phase=${state.phase}). Final score=${lastScore}`);
        break;
      }

      if (!state.you || !state.you.alive) {
        console.log(`${prefix} Died. Final score=${state.you?.score ?? lastScore}`);
        break;
      }

      const me = state.you;
      const myPos = { x: me.x, y: me.y };

      // --- Phase & leaderboard awareness ---
      const timeLeft = state.timeRemaining ?? 0;
      const earlyGame = timeLeft > 180;   // first minute
      const lateGame = timeLeft <= 60;    // last minute
      const midGame = !earlyGame && !lateGame;

      const isLeader =
        Array.isArray(state.leaderboard) &&
        state.leaderboard.length > 0 &&
        state.leaderboard[0].id === me.id;

      // --- Enemy awareness: find nearest other snake ---
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

      const enemyIsSmaller =
        nearestEnemy && me.length > nearestEnemy.length * 1.3;
      const enemyIsBigger =
        nearestEnemy && nearestEnemy.length > me.length * 1.2;
      const enemyClose = nearestEnemy && nearestEnemyDist < 200;

      // Choose best food
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

      // If bigger than a nearby enemy, try to pressure them (except very early or if leading late)
      if (
        nearestEnemy &&
        enemyIsSmaller &&
        enemyClose &&
        (midGame || (lateGame && !isLeader))
      ) {
        const enemyPos = { x: nearestEnemy.x, y: nearestEnemy.y };
        const angleToEnemy = getAngleTo(myPos, enemyPos);
        targetAngle = angleToEnemy;
      }

      // If a much bigger enemy is very close, steer away to survive
      if (nearestEnemy && enemyIsBigger && nearestEnemyDist < 150) {
        const enemyPos = { x: nearestEnemy.x, y: nearestEnemy.y };
        const angleToEnemy = getAngleTo(myPos, enemyPos);
        targetAngle = normalizeAngle(angleToEnemy + 180);
      }

      // Self-collision avoidance
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

      // Wall avoidance
      const margin = 100;
      const lookAhead = 80;
      const futureX = myPos.x + Math.cos(me.angle * Math.PI / 180) * lookAhead;
      const futureY = myPos.y + Math.sin(me.angle * Math.PI / 180) * lookAhead;

      let wallDanger = false;
      if (futureX < margin || futureX > state.arena.width - margin ||
          futureY < margin || futureY > state.arena.height - margin) {
        wallDanger = true;
        const centerX = state.arena.width / 2;
        const centerY = state.arena.height / 2;
        targetAngle = getAngleTo(myPos, { x: centerX, y: centerY });
      }

      // Turn control
      let turn = getShortestTurn(me.angle, targetAngle);
      let maxTurn = 20;
      if (wallDanger || selfDanger) maxTurn = 45;
      else if (Math.abs(turn) < 10) maxTurn = 10;
      turn = Math.max(-maxTurn, Math.min(maxTurn, turn));

      // Boost decision with phase-aware strategy
      let shouldBoost = false;

      const enemyVeryClose = nearestEnemy && nearestEnemyDist < 120;
      const safeFromBigEnemy = !enemyIsBigger || !enemyVeryClose;

      if (!wallDanger && !selfDanger && me.length > 15 && safeFromBigEnemy) {
        if (earlyGame) {
          shouldBoost = minDist < 40 && !enemyVeryClose;
        } else if (midGame) {
          shouldBoost =
            minDist < 60 ||
            (enemyIsSmaller && enemyVeryClose);
        } else if (lateGame) {
          if (isLeader) {
            shouldBoost = minDist < 30 && !enemyVeryClose;
          } else {
            shouldBoost =
              minDist < 70 ||
              (enemyIsSmaller && enemyVeryClose);
          }
        }
      }

      // Send action
      const actionRes = await fetch(`${BASE_URL}/api/match/action`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ action: 'steer', angleDelta: turn, boost: shouldBoost }),
      });
      await actionRes.json(); // ignore body

      // Logging
      tickCount++;
      if (tickCount % 20 === 0 || me.score !== lastScore) {
        const logTime = Math.floor(timeLeft);
        const foodInfo = bestFood ? `Food=${Math.round(minDist)}u` : 'No food';
        let status = '';
        if (wallDanger) status = 'WALL';
        else if (selfDanger) status = 'SELF';
        else if (shouldBoost) status = 'BOOST';
        console.log(`${prefix} [${timeLeft}s] score=${me.score} len=${me.length} ${foodInfo} turn=${turn.toFixed(0)} ${status}`);
        lastScore = me.score;
      }

      await sleep(200);
    } catch (err) {
      console.error(`${prefix} Error:`, err.message || err);
      await sleep(1000);
    }
  }
}

async function main() {
  console.log('Starting multi-agent test (5 agents)...\n');
  await Promise.all(AGENTS.map(agent => runAgent(agent)));
  console.log('\nMulti-agent test complete.');
}

main().catch(err => {
  console.error('Fatal error in multi-agent test:', err);
});

