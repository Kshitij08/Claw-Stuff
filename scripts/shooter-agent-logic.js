/**
 * Claw Shooter AI agent logic.
 *
 * Five bloodthirsty personality presets that Open Claw agents can use as a base.
 * All personalities are aggressive — they differ only in *how* they hunt.
 *
 * Usage:
 *   import { runShooterAgent, PERSONALITIES, SHOOTER_AGENTS } from './shooter-agent-logic.js';
 *   await runShooterAgent(
 *     { key: 'test_Bot1', name: 'Bot1' },
 *     PERSONALITIES.BERSERKER,
 *     'http://localhost:3000',
 *   );
 */

// ─── Constants (mirrored from src/shared/shooter-constants.ts) ──────────────

const WEAPON_STATS = {
  knife:          { damage: 25,  fireRate: 600, range: 2,  ammo: null, pellets: 1, isMelee: true  },
  pistol:         { damage: 15,  fireRate: 500, range: 50, ammo: 10,   pellets: 1, isMelee: false },
  smg:            { damage: 8,   fireRate: 120, range: 40, ammo: 20,   pellets: 1, isMelee: false },
  shotgun:        { damage: 12,  fireRate: 900, range: 25, ammo: 5,    pellets: 5, isMelee: false },
  assault_rifle:  { damage: 12,  fireRate: 150, range: 60, ammo: 15,   pellets: 1, isMelee: false },
};

const WEAPON_TIER = {
  assault_rifle: 5,
  shotgun: 4,
  smg: 3,
  pistol: 2,
  knife: 1,
};

const PICKUP_RADIUS = 1.5;
/** Use a slightly larger radius to decide to send pickup (avoids running past before next tick). */
const PICKUP_RADIUS_EARLY = 2.2;

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

function distance(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

function angleTo(from, to) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  return (Math.atan2(dz, dx) * 180) / Math.PI;
}

function normalizeAngle(a) {
  a = a % 360;
  if (a < 0) a += 360;
  return a;
}

function angleDiff(from, to) {
  let d = normalizeAngle(to) - normalizeAngle(from);
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

function isGun(weapon) {
  return weapon && weapon !== 'knife';
}

function weaponRange(weapon) {
  return WEAPON_STATS[weapon]?.range ?? 2;
}

function weaponDps(weapon) {
  const s = WEAPON_STATS[weapon];
  if (!s) return 0;
  return (s.damage * s.pellets) / (s.fireRate / 1000);
}

// ─── Personality presets ────────────────────────────────────────────────────

/**
 * Each personality tunes the decision engine via numeric weights and behaviour flags.
 *
 * aggression        0-1   How eagerly the agent seeks combat
 * weaponHunger      0-1   Priority of picking up a gun before fighting
 * healthCaution     0-1   How much low-health affects decisions
 * targetPreference  str   How the agent picks its primary target
 * meleeComfort      0-1   Willingness to fight with knife vs flee/kite
 * retreatThreshold  num   HP at which the agent briefly disengages (0 = never)
 * ammoConservation  0-1   How carefully ammo is spent (high = skip low-chance shots)
 * strafeBehavior    str   Movement pattern during combat
 * pickupAggression  str   How weapon pickups are handled mid-fight
 * tag               str   Strategy tag sent on join
 */

export const PERSONALITIES = {
  BERSERKER: {
    name: 'Berserker',
    tag: 'Berserker',
    aggression: 1.0,
    weaponHunger: 0.3,
    healthCaution: 0.1,
    targetPreference: 'nearest',
    meleeComfort: 1.0,
    retreatThreshold: 10,
    ammoConservation: 0.1,
    strafeBehavior: 'charge-straight',
    pickupAggression: 'ignore-if-fighting',
  },

  PREDATOR: {
    name: 'Predator',
    tag: 'Predator',
    aggression: 0.7,
    weaponHunger: 0.8,
    healthCaution: 0.4,
    targetPreference: 'weakest',
    meleeComfort: 0.5,
    retreatThreshold: 30,
    ammoConservation: 0.5,
    strafeBehavior: 'circle-strafe',
    pickupAggression: 'always-grab',
  },

  TACTICIAN: {
    name: 'Tactician',
    tag: 'Tactician',
    aggression: 0.4,
    weaponHunger: 0.9,
    healthCaution: 0.8,
    targetPreference: 'isolated',
    meleeComfort: 0.2,
    retreatThreshold: 50,
    ammoConservation: 0.9,
    strafeBehavior: 'kite-back',
    pickupAggression: 'plan-ahead',
  },

  OPPORTUNIST: {
    name: 'Opportunist',
    tag: 'Opportunist',
    aggression: 0.6,
    weaponHunger: 0.7,
    healthCaution: 0.6,
    targetPreference: 'low-health',
    meleeComfort: 0.4,
    retreatThreshold: 40,
    ammoConservation: 0.7,
    strafeBehavior: 'zigzag',
    pickupAggression: 'steal-drops',
  },

  PSYCHOPATH: {
    name: 'Psychopath',
    tag: 'Psychopath',
    aggression: 0.9,
    weaponHunger: 0.5,
    healthCaution: 0.2,
    targetPreference: 'random',
    meleeComfort: 0.8,
    retreatThreshold: 0,
    ammoConservation: 0.3,
    strafeBehavior: 'erratic',
    pickupAggression: 'ignore',
  },
};

// ─── Default dev agents (test_ keys) ───────────────────────────────────────

const DEFAULT_SHOOTER_AGENTS = [
  { key: 'test_ShooterBot1', name: 'ShooterBot1' },
  { key: 'test_ShooterBot2', name: 'ShooterBot2' },
  { key: 'test_ShooterBot3', name: 'ShooterBot3' },
  { key: 'test_ShooterBot4', name: 'ShooterBot4' },
  { key: 'test_ShooterBot5', name: 'ShooterBot5' },
];

function loadShooterAgentsFromEnv() {
  const raw = process.env.SHOOTER_HOUSE_BOT_AGENTS;
  if (!raw) return DEFAULT_SHOOTER_AGENTS;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((a) => typeof a.key === 'string' && typeof a.name === 'string')) {
      return parsed;
    }
  } catch { /* fall through */ }
  return DEFAULT_SHOOTER_AGENTS;
}

export const SHOOTER_AGENTS = loadShooterAgentsFromEnv();

// ─── Target scoring ─────────────────────────────────────────────────────────

function scoreEnemy(me, enemy, personality, allEnemies) {
  const dist = distance(me, enemy);
  if (dist < 0.01) return -Infinity;

  let score = 0;

  // Distance factor — closer = higher score (aggressive)
  const maxArena = 90;
  const distNorm = 1 - Math.min(dist / maxArena, 1);
  score += distNorm * personality.aggression * 40;

  // Health factor — lower health = easier kill
  const healthNorm = 1 - enemy.health / 100;
  score += healthNorm * 30;

  // Lives factor — fewer lives = closer to elimination
  const livesNorm = 1 - (enemy.lives ?? 3) / 3;
  score += livesNorm * 15;

  // Weapon threat — enemies with knife are less dangerous
  const enemyTier = WEAPON_TIER[enemy.weapon] ?? 1;
  if (!isGun(enemy.weapon)) {
    score += 10; // unarmed enemies are easier targets
  } else {
    score -= enemyTier * 2; // armed enemies are slightly less attractive unless personality says otherwise
  }

  // Personality-specific bonuses
  switch (personality.targetPreference) {
    case 'nearest':
      score += distNorm * 25;
      break;
    case 'weakest':
      score += healthNorm * 25 + livesNorm * 15;
      break;
    case 'low-health':
      score += healthNorm * 35;
      break;
    case 'isolated': {
      const nearbyFriends = allEnemies.filter(
        (e) => e.id !== enemy.id && e.alive && distance(enemy, e) < 15,
      ).length;
      score += (nearbyFriends === 0 ? 20 : -nearbyFriends * 8);
      break;
    }
    case 'random':
      score += Math.random() * 30;
      break;
  }

  return score;
}

function selectTarget(me, enemies, personality) {
  if (enemies.length === 0) return null;

  let best = null;
  let bestScore = -Infinity;

  for (const enemy of enemies) {
    const s = scoreEnemy(me, enemy, personality, enemies);
    if (s > bestScore) {
      bestScore = s;
      best = enemy;
    }
  }

  return best;
}

// ─── Weapon pickup scoring ──────────────────────────────────────────────────

function scorePickup(me, pickup, enemies, personality) {
  const dist = distance(me, pickup);
  const tier = WEAPON_TIER[pickup.type] ?? 1;
  const myTier = WEAPON_TIER[me.weapon] ?? 1;

  // Don't grab if current weapon is better
  if (myTier >= tier) return -100;

  let score = 0;

  // Tier improvement
  score += (tier - myTier) * 20;

  // Distance penalty
  score -= dist * 1.5;

  // Danger check — enemies near the pickup
  const nearbyEnemies = enemies.filter((e) => distance(e, pickup) < 10).length;
  score -= nearbyEnemies * 8 * (1 - personality.aggression);

  // Personality weapon hunger
  score *= (0.5 + personality.weaponHunger);

  return score;
}

function selectBestPickup(me, pickups, enemies, personality) {
  if (pickups.length === 0) return null;

  let best = null;
  let bestScore = -Infinity;

  for (const p of pickups) {
    const s = scorePickup(me, p, enemies, personality);
    if (s > bestScore) {
      bestScore = s;
      best = p;
    }
  }

  if (bestScore > 0) return best;
  // When we have knife, always return best by tier/distance even if score is negative (go get a gun)
  const hasGun = isGun(me.weapon);
  return hasGun ? null : best;
}

/** Nearest weapon pickup by distance (used when selectBestPickup returns null). */
function getNearestPickup(me, pickups) {
  if (pickups.length === 0) return null;
  return pickups.reduce((a, b) => (distance(me, a) < distance(me, b) ? a : b));
}

// ─── Anti-stuck detection ───────────────────────────────────────────────────

class StuckDetector {
  constructor(bufferSize = 12, threshold = 1.5) {
    this.buffer = [];
    this.bufferSize = bufferSize;
    this.threshold = threshold;
    this.wanderUntil = 0;
    this.wanderAngle = 0;
  }

  push(x, z) {
    this.buffer.push({ x, z });
    if (this.buffer.length > this.bufferSize) {
      this.buffer.shift();
    }
  }

  isStuck() {
    if (this.buffer.length < this.bufferSize) return false;

    let maxDist = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      for (let j = i + 1; j < this.buffer.length; j++) {
        const d = distance(this.buffer[i], this.buffer[j]);
        if (d > maxDist) maxDist = d;
      }
    }
    return maxDist < this.threshold;
  }

  startWander(currentAngle) {
    const offset = 90 + Math.random() * 180;
    this.wanderAngle = normalizeAngle(currentAngle + (Math.random() > 0.5 ? offset : -offset));
    this.wanderUntil = Date.now() + 1500 + Math.random() * 1000;
    this.buffer = [];
  }

  isWandering() {
    return Date.now() < this.wanderUntil;
  }
}

// ─── Strafe behaviours ──────────────────────────────────────────────────────

let zigzagFlip = 1;
let erraticTimer = 0;
let erraticAngle = 0;

function getStrafeAngle(angleToTarget, personality, tick) {
  switch (personality.strafeBehavior) {
    case 'charge-straight':
      return angleToTarget;

    case 'circle-strafe':
      return angleToTarget + 75;

    case 'kite-back':
      return normalizeAngle(angleToTarget + 180);

    case 'zigzag':
      if (tick % 6 === 0) zigzagFlip *= -1;
      return angleToTarget + 60 * zigzagFlip;

    case 'erratic':
      if (tick % 4 === 0 || erraticTimer <= 0) {
        erraticAngle = angleToTarget + (Math.random() - 0.5) * 160;
        erraticTimer = 3 + Math.floor(Math.random() * 4);
      }
      erraticTimer--;
      return erraticAngle;

    default:
      return angleToTarget;
  }
}

// ─── Evasion vs ranged enemies when we only have knife ──────────────────────

let evasionStartTime = 0;
const MAX_EVASION_MS = 3000;

function getEvasionAngle(me, enemy) {
  const toEnemy = angleTo(me, enemy);
  const offset = 70 + Math.random() * 20;
  return normalizeAngle(toEnemy + (Math.random() > 0.5 ? offset : -offset));
}

// ─── Decision engine ────────────────────────────────────────────────────────

function decide(me, state, personality, stuckDetector, tick, retreatUntil) {
  // Treat any player not explicitly dead as a valid target (server may omit .alive sometimes)
  const enemies = (state.players || []).filter((p) => p != null && p.alive !== false);
  const pickups = state.weaponPickups || [];
  const now = Date.now();

  // ── Anti-stuck: override everything (but not during melee combat) ──
  stuckDetector.push(me.x, me.z);

  // Don't trigger anti-stuck if an enemy is within combat range — we're fighting
  const nearestEnemyDist = enemies.length > 0
    ? enemies.reduce((min, e) => Math.min(min, distance(me, e)), Infinity)
    : Infinity;
  const inCombatRange = nearestEnemyDist < 10;

  if (stuckDetector.isWandering() && !inCombatRange) {
    return { type: 'move', angle: stuckDetector.wanderAngle };
  }

  if (stuckDetector.isStuck() && !inCombatRange) {
    const nearestPickup = pickups.length > 0
      ? pickups.reduce((a, b) => (distance(me, a) < distance(me, b) ? a : b))
      : null;

    if (nearestPickup && distance(me, nearestPickup) < 40) {
      stuckDetector.wanderAngle = angleTo(me, nearestPickup);
      stuckDetector.wanderUntil = now + 2000;
      stuckDetector.buffer = [];
      return { type: 'move', angle: stuckDetector.wanderAngle };
    }

    stuckDetector.startWander(me.angle);
    return { type: 'move', angle: stuckDetector.wanderAngle };
  }

  // ── Retreat check ──
  if (now < retreatUntil.value) {
    const retreatTarget = selectTarget(me, enemies, personality);
    if (retreatTarget) {
      const away = normalizeAngle(angleTo(me, retreatTarget) + 180);
      return { type: 'move', angle: away };
    }
    return { type: 'move', angle: normalizeAngle(me.angle + 180) };
  }

  // ── Health-based retreat trigger ──
  if (
    personality.retreatThreshold > 0 &&
    me.health <= personality.retreatThreshold &&
    me.health > 0 &&
    enemies.length > 0
  ) {
    retreatUntil.value = now + 1500;
    const nearest = enemies.reduce((a, b) => (distance(me, a) < distance(me, b) ? a : b));
    const away = normalizeAngle(angleTo(me, nearest) + 180);
    return { type: 'move', angle: away };
  }

  // ── Opportunistic pickup: if we're passing right by any weapon, grab it first ──
  const hasGun = isGun(me.weapon);
  const myTier = WEAPON_TIER[me.weapon] ?? 1;
  for (const p of pickups) {
    const d = distance(me, p);
    if (d >= PICKUP_RADIUS_EARLY) continue;
    const pTier = WEAPON_TIER[p.type] ?? 1;
    if (!hasGun || pTier > myTier) {
      return { type: 'pickup' };
    }
  }

  // ── Weapon pickup decision ──
  const shouldSeekWeapon = !hasGun && pickups.length > 0;

  if (shouldSeekWeapon) {
    const bestPickup = selectBestPickup(me, pickups, enemies, personality) || getNearestPickup(me, pickups);

    if (bestPickup) {
      const pickupDist = distance(me, bestPickup);

      // Close enough to grab (use early radius so we don't run past)
      if (pickupDist < PICKUP_RADIUS_EARLY) {
        return { type: 'pickup' };
      }

      // Decide: go for weapon or fight?
      const nearestEnemy = enemies.length > 0
        ? enemies.reduce((a, b) => (distance(me, a) < distance(me, b) ? a : b))
        : null;
      const nearestEnemyDist = nearestEnemy ? distance(me, nearestEnemy) : Infinity;

      // If enemy is very close and we're melee-comfortable, fight first
      const fightFirst = nearestEnemy &&
        nearestEnemyDist < 4 &&
        personality.meleeComfort > 0.6;

      if (!fightFirst) {
        return { type: 'move', angle: angleTo(me, bestPickup) };
      }
    }
  }

  // Mid-fight pickup grab: if we walk over a better weapon, grab it
  if (hasGun && pickups.length > 0) {
    const nearbyUpgrade = pickups.find((p) => {
      if (distance(me, p) > PICKUP_RADIUS_EARLY) return false;
      return (WEAPON_TIER[p.type] ?? 1) > (WEAPON_TIER[me.weapon] ?? 1);
    });
    if (nearbyUpgrade && personality.pickupAggression !== 'ignore') {
      return { type: 'pickup' };
    }
  }

  // ── No enemies? Wander toward pickups or roam ──
  if (enemies.length === 0) {
    if (pickups.length > 0) {
      const nearest = pickups.reduce((a, b) => (distance(me, a) < distance(me, b) ? a : b));
      if (distance(me, nearest) < PICKUP_RADIUS_EARLY) {
        return { type: 'pickup' };
      }
      return { type: 'move', angle: angleTo(me, nearest) };
    }
    return { type: 'move', angle: normalizeAngle(me.angle + 15) };
  }

  // ── Select target ──
  let target = selectTarget(me, enemies, personality);
  if (!target && enemies.length > 0) {
    target = enemies.reduce((a, b) => (distance(me, a) < distance(me, b) ? a : b));
  }
  if (!target) {
    return { type: 'move', angle: normalizeAngle(me.angle + 15) };
  }

  const dist = distance(me, target);
  const toTarget = angleTo(me, target);
  const myWeapon = me.weapon;
  const myRange = weaponRange(myWeapon);

  // ── Evasion: we have knife, enemy has gun and is close-ish ──
  // High meleeComfort agents (Berserker, Psychopath) skip evasion and just charge
  if (!isGun(myWeapon) && isGun(target.weapon) && dist < 20 && dist > 3 && personality.meleeComfort < 0.7) {
    if (evasionStartTime === 0) evasionStartTime = now;
    const evading = now - evasionStartTime < MAX_EVASION_MS;

    if (evading) {
      // Strafe toward the target at an angle to close distance while dodging
      const evasionAngle = getEvasionAngle(me, target);
      return { type: 'move', angle: evasionAngle };
    } else {
      evasionStartTime = 0;
      // Time's up — charge!
    }
  } else {
    evasionStartTime = 0;
  }

  // ── In range: attack! ──
  if (dist <= myRange || (myWeapon === 'knife' && dist <= 2.5)) {
    if (myWeapon === 'knife') {
      return { type: 'melee', moveAngle: toTarget };
    }

    // Ammo conservation: skip low-probability shots at long range
    const ammoRatio = me.ammo !== null ? me.ammo / (WEAPON_STATS[myWeapon]?.ammo ?? 10) : 1;
    const longRange = dist > myRange * 0.7;
    if (longRange && ammoRatio < 0.3 && personality.ammoConservation > 0.7) {
      return { type: 'move', angle: toTarget };
    }

    const strafeAngle = getStrafeAngle(toTarget, personality, tick);
    return { type: 'shoot', aimAngle: toTarget, moveAngle: strafeAngle };
  }

  // ── Out of range: close the gap ──
  // If we have a gun and target is within reasonable range, shoot while approaching
  if (isGun(myWeapon) && dist <= myRange * 1.2) {
    const strafeAngle = getStrafeAngle(toTarget, personality, tick);
    return { type: 'shoot', aimAngle: toTarget, moveAngle: strafeAngle };
  }

  // Check for opportunistic pickups on the way to target
  if (personality.pickupAggression === 'plan-ahead' || personality.pickupAggression === 'steal-drops') {
    const onRoutePickup = pickups.find((p) => {
      const detour = distance(me, p) + distance(p, target) - dist;
      return detour < 5 && (WEAPON_TIER[p.type] ?? 1) > (WEAPON_TIER[myWeapon] ?? 1);
    });
    if (onRoutePickup) {
      const pDist = distance(me, onRoutePickup);
      if (pDist < PICKUP_RADIUS_EARLY) return { type: 'pickup' };
      return { type: 'move', angle: angleTo(me, onRoutePickup) };
    }
  }

  return { type: 'move', angle: toTarget };
}

// ─── Main game loop ─────────────────────────────────────────────────────────

/**
 * Run a single shooter agent. Joins the match, polls state, makes decisions.
 *
 * @param {{ key: string, name: string }} agentConfig  Agent credentials
 * @param {object} personality  One of the PERSONALITIES presets (or custom)
 * @param {string} baseUrl  Server base URL
 * @param {{ quiet?: boolean }} options
 */
export async function runShooterAgent(agentConfig, personality, baseUrl, options = {}) {
  const { quiet = false } = options;
  const HEADERS = makeHeaders(agentConfig.key);
  const prefix = `[${agentConfig.name}/${personality.name}]`;
  const log = (...args) => { if (!quiet) console.log(prefix, ...args); };

  log('Starting...');

  // ── Join match ──
  log('Joining match...');
  const joinRes = await fetch(`${baseUrl}/api/shooter/join`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      displayName: agentConfig.name,
      strategyTag: personality.tag,
    }),
  });
  const join = await joinRes.json();

  if (!join.success) {
    log('Failed to join:', join.message);
    return;
  }
  log(`Joined match ${join.matchId} as ${join.playerId}`);

  // ── Wait for match to start ──
  log('Waiting for match to start...');
  while (true) {
    const stateRes = await fetch(`${baseUrl}/api/shooter/state`, { headers: HEADERS });
    const state = await stateRes.json();

    if (state.phase === 'active') {
      log('Match started!');
      break;
    }
    if (state.phase === 'finished') {
      log('Match already finished. Exiting.');
      return;
    }
    await sleep(500);
  }

  // ── Game loop ──
  const stuckDetector = new StuckDetector();
  const retreatUntil = { value: 0 };
  let tick = 0;
  let lastKills = 0;

  while (true) {
    try {
      const stateRes = await fetch(`${baseUrl}/api/shooter/state`, { headers: HEADERS });
      const state = await stateRes.json();

      if (state.phase !== 'active') {
        log(`Match ended (phase=${state.phase}).`);
        break;
      }

      const me = state.you;

      if (!me) {
        log('Not in match anymore. Exiting.');
        break;
      }

      // Eliminated
      if (me.lives <= 0 && !me.alive) {
        log(`Eliminated. Kills: ${me.kills}, Deaths: ${me.deaths}`);
        break;
      }

      // Dead but respawning
      if (!me.alive) {
        await sleep(300);
        continue;
      }

      tick++;

      // Make decision
      const action = decide(me, state, personality, stuckDetector, tick, retreatUntil);

      // Execute action(s) — can send up to 5/sec, but we do 1-2 per cycle
      switch (action.type) {
        case 'move':
          await fetch(`${baseUrl}/api/shooter/action`, {
            method: 'POST',
            headers: HEADERS,
            body: JSON.stringify({ action: 'move', angle: action.angle }),
          });
          break;

        case 'shoot':
          // Move + shoot in same cycle
          if (action.moveAngle !== undefined) {
            await fetch(`${baseUrl}/api/shooter/action`, {
              method: 'POST',
              headers: HEADERS,
              body: JSON.stringify({ action: 'move', angle: action.moveAngle }),
            });
          }
          await fetch(`${baseUrl}/api/shooter/action`, {
            method: 'POST',
            headers: HEADERS,
            body: JSON.stringify({ action: 'shoot', aimAngle: action.aimAngle }),
          });
          break;

        case 'melee':
          if (action.moveAngle !== undefined) {
            await fetch(`${baseUrl}/api/shooter/action`, {
              method: 'POST',
              headers: HEADERS,
              body: JSON.stringify({ action: 'move', angle: action.moveAngle }),
            });
          }
          await fetch(`${baseUrl}/api/shooter/action`, {
            method: 'POST',
            headers: HEADERS,
            body: JSON.stringify({ action: 'melee' }),
          });
          break;

        case 'pickup':
          await fetch(`${baseUrl}/api/shooter/action`, {
            method: 'POST',
            headers: HEADERS,
            body: JSON.stringify({ action: 'pickup' }),
          });
          break;

        case 'stop':
          await fetch(`${baseUrl}/api/shooter/action`, {
            method: 'POST',
            headers: HEADERS,
            body: JSON.stringify({ action: 'stop' }),
          });
          break;
      }

      // Logging
      if (tick % 15 === 0 || me.kills !== lastKills) {
        const enemies = (state.players || []).filter((p) => p.alive);
        const nearestDist = enemies.length > 0
          ? Math.round(enemies.reduce((min, e) => Math.min(min, distance(me, e)), Infinity))
          : '-';
        log(
          `[${Math.round(state.timeRemaining)}s]`,
          `HP=${me.health} Lives=${me.lives}`,
          `W=${me.weapon}(${me.ammo ?? '∞'})`,
          `K=${me.kills} D=${me.deaths}`,
          `Near=${nearestDist}m`,
          `Act=${action.type}`,
        );
        lastKills = me.kills;
      }

      await sleep(200);
    } catch (err) {
      if (!quiet) console.error(prefix, 'Error:', err.message || err);
      await sleep(1000);
    }
  }
}
