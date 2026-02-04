// Test agent that plays the game with a simple AI
const BASE_URL = 'http://localhost:3000';
const API_KEY = 'test_TestAgent';

const HEADERS = {
  'Authorization': `Bearer ${API_KEY}`,
  'Content-Type': 'application/json',
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getAngleTo(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let angle = Math.atan2(dy, dx) * 180 / Math.PI;
  // Normalize to [0, 360)
  if (angle < 0) angle += 360;
  return angle;
}

function normalizeAngle(angle) {
  angle = angle % 360;
  if (angle < 0) angle += 360;
  return angle;
}

function getShortestTurn(from, to) {
  // Get the shortest turn direction from 'from' angle to 'to' angle
  let diff = normalizeAngle(to) - normalizeAngle(from);
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return diff;
}

function distance(p1, p2) {
  return Math.sqrt((p1.x - p2.x) ** 2 + (p1.y - p2.y) ** 2);
}

// Check if a point is too close to any segment in a list
function isTooCloseToSegments(point, segments, minDistance, skipFirst = 0) {
  for (let i = skipFirst; i < segments.length; i++) {
    const seg = segments[i];
    if (distance(point, { x: seg[0], y: seg[1] }) < minDistance) {
      return true;
    }
  }
  return false;
}

// Check if path ahead is clear of own body
function checkSelfCollision(myPos, angle, mySegments, checkDistance = 60) {
  const rad = angle * Math.PI / 180;
  // Check multiple points along the path
  for (let dist = 20; dist <= checkDistance; dist += 20) {
    const checkPoint = {
      x: myPos.x + Math.cos(rad) * dist,
      y: myPos.y + Math.sin(rad) * dist
    };
    // Skip first 10 segments (they're close to head by design)
    if (isTooCloseToSegments(checkPoint, mySegments, 15, 10)) {
      return true; // Danger!
    }
  }
  return false;
}

async function main() {
  console.log('🐍 Test Agent Starting...\n');

  // 1. Check status
  console.log('Checking server status...');
  const statusRes = await fetch(`${BASE_URL}/api/status`);
  const status = await statusRes.json();
  console.log(`Current match: ${status.currentMatch?.id || 'None'} (${status.currentMatch?.phase || 'no match'})`);
  console.log(`Players in match: ${status.currentMatch?.playerCount || 0}`);

  // 2. Join match
  console.log('\nJoining match...');
  const joinRes = await fetch(`${BASE_URL}/api/match/join`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ displayName: 'TestSnake' }),
  });
  const join = await joinRes.json();
  
  if (!join.success) {
    console.log('Failed to join:', join.message);
    return;
  }
  console.log(`✓ Joined as ${join.playerId}`);
  console.log(`  Message: ${join.message}`);

  // 3. Wait for match to start
  console.log('\nWaiting for match to start...');
  let state;
  while (true) {
    const stateRes = await fetch(`${BASE_URL}/api/match/current`, {
      headers: HEADERS,
    });
    state = await stateRes.json();
    
    if (state.phase === 'active') {
      console.log('✓ Match started!');
      break;
    }
    
    if (state.phase === 'finished') {
      console.log('Match already finished. Try again.');
      return;
    }
    
    process.stdout.write('.');
    await sleep(500);
  }

  // 4. Game loop
  console.log('\n--- GAME LOOP STARTED ---');
  console.log('Press Ctrl+C to stop\n');
  
  let lastScore = 0;
  let tickCount = 0;
  
  while (true) {
    try {
      const stateRes = await fetch(`${BASE_URL}/api/match/current`, {
        headers: HEADERS,
      });
      state = await stateRes.json();
      
      // Check if match ended or we died
      if (state.phase !== 'active') {
        console.log(`\nMatch ended! Phase: ${state.phase}`);
        break;
      }
      
      if (!state.you || !state.you.alive) {
        console.log('\n💀 We died!');
        console.log(`Final score: ${state.you?.score || lastScore}`);
        break;
      }
      
      const me = state.you;
      const myPos = { x: me.x, y: me.y };

      // --- Phase & leaderboard awareness ---
      const timeLeft = state.timeRemaining ?? 0;
      const earlyGame = timeLeft > 180;   // first ~1 minute
      const lateGame = timeLeft <= 60;    // final minute
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

      // Find best food - prefer food that's more in front of us
      let targetAngle = me.angle;
      let bestFood = null;
      let bestScore = -Infinity;
      let minDist = Infinity;
      
      for (const food of state.food) {
        const foodPos = { x: food.x, y: food.y };
        const d = distance(myPos, foodPos);
        const angleToFood = getAngleTo(myPos, foodPos);
        const turnNeeded = Math.abs(getShortestTurn(me.angle, angleToFood));
        
        // Score: prefer close food that doesn't require much turning
        // Heavily penalize food that's behind us (>90 degree turn)
        const turnPenalty = turnNeeded > 90 ? 500 : turnNeeded * 2;
        const score = -d - turnPenalty;
        
        if (score > bestScore) {
          bestScore = score;
          bestFood = food;
          minDist = d;
        }
      }
      
      // Default: go toward best food
      if (bestFood) {
        targetAngle = getAngleTo(myPos, { x: bestFood.x, y: bestFood.y });
      }

      const enemyIsSmaller =
        nearestEnemy && me.length > nearestEnemy.length * 1.3;
      const enemyIsBigger =
        nearestEnemy && nearestEnemy.length > me.length * 1.2;
      const enemyClose = nearestEnemy && nearestEnemyDist < 200;

      // If we are much larger than a nearby enemy, and it's not early or we are not leading late, try to pressure them
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
      
      // Check for self-collision danger
      let selfDanger = false;
      if (me.segments.length > 15) {
        selfDanger = checkSelfCollision(myPos, me.angle, me.segments);
        
        if (selfDanger) {
          // Try turning left or right to find a safe path
          const leftAngle = normalizeAngle(me.angle - 45);
          const rightAngle = normalizeAngle(me.angle + 45);
          
          const leftSafe = !checkSelfCollision(myPos, leftAngle, me.segments);
          const rightSafe = !checkSelfCollision(myPos, rightAngle, me.segments);
          
          if (leftSafe && !rightSafe) {
            targetAngle = leftAngle;
          } else if (rightSafe && !leftSafe) {
            targetAngle = rightAngle;
          } else if (leftSafe && rightSafe) {
            // Both safe, pick the one closer to our current direction
            const leftTurn = Math.abs(getShortestTurn(me.angle, leftAngle));
            const rightTurn = Math.abs(getShortestTurn(me.angle, rightAngle));
            targetAngle = leftTurn < rightTurn ? leftAngle : rightAngle;
          } else {
            // Neither safe, try more extreme turn
            targetAngle = normalizeAngle(me.angle + 90);
          }
        }
      }
      
      // If a much bigger enemy is very close, steer away (survival)
      if (nearestEnemy && enemyIsBigger && nearestEnemyDist < 150) {
        const enemyPos = { x: nearestEnemy.x, y: nearestEnemy.y };
        const angleToEnemy = getAngleTo(myPos, enemyPos);
        // Steer roughly opposite of the enemy
        targetAngle = normalizeAngle(angleToEnemy + 180);
      }

      // Wall avoidance - check if we're heading toward a wall
      const margin = 100;
      const lookAhead = 80;
      const futureX = myPos.x + Math.cos(me.angle * Math.PI / 180) * lookAhead;
      const futureY = myPos.y + Math.sin(me.angle * Math.PI / 180) * lookAhead;
      
      let wallDanger = false;
      if (futureX < margin || futureX > state.arena.width - margin ||
          futureY < margin || futureY > state.arena.height - margin) {
        wallDanger = true;
        // Turn toward center
        const centerX = state.arena.width / 2;
        const centerY = state.arena.height / 2;
        targetAngle = getAngleTo(myPos, { x: centerX, y: centerY });
      }
      
      // Calculate turn amount using shortest path
      let turn = getShortestTurn(me.angle, targetAngle);
      
      // Use proportional control - smaller turns when angle difference is small
      let maxTurn = 20; // Default max turn
      if (wallDanger || selfDanger) maxTurn = 45; // Turn faster to avoid danger
      else if (Math.abs(turn) < 10) maxTurn = 10; // Gentle correction when almost aligned
      
      turn = Math.max(-maxTurn, Math.min(maxTurn, turn));
      
      // Decide on boost - strategy-aware:
      // - Early game: grow safely, only boost for very close food and no close enemies.
      // - Mid game: boost for close food and when chasing smaller enemies.
      // - Late game:
      //     * If leader: play safe, boost rarely.
      //     * If behind: more aggressive boosting.
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
            // Leader: small, safe boosts only
            shouldBoost = minDist < 30 && !enemyVeryClose;
          } else {
            // Not leader: take more risks
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
      const action = await actionRes.json();
      
      // Log status every 10 ticks
      tickCount++;
      if (tickCount % 10 === 0 || me.score !== lastScore) {
        const logTime = Math.floor(timeLeft);
        const foodInfo = bestFood ? `Food: ${Math.round(minDist)}u` : 'No food';
        let status = '';
        if (wallDanger) status = '⚠️ WALL';
        else if (selfDanger) status = '🔄 SELF';
        else if (shouldBoost) status = '🚀';
        console.log(`[${timeLeft}s] Score: ${me.score} | Len: ${me.length} | ${foodInfo} | Turn: ${turn.toFixed(0)}° ${status}`);
        lastScore = me.score;
      }
      
      await sleep(200); // 5 actions per second
      
    } catch (error) {
      console.error('Error:', error.message);
      await sleep(1000);
    }
  }
  
  console.log('\n--- GAME OVER ---');
}

main().catch(console.error);
