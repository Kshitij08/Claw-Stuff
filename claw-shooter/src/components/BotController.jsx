import { useCallback, useEffect, useRef, useState } from "react";
import { CharacterPlayer } from "./CharacterPlayer";
import { CapsuleCollider, RigidBody, vec3, useRapier } from "@react-three/rapier";
import { useFrame, useThree } from "@react-three/fiber";
import { isHost, Bot, usePlayersList } from "playroomkit";
import { Billboard, Text } from "@react-three/drei";
import {
  WEAPON_TYPES,
  WEAPON_STATS,
  KNIFE,
  LIVES_PER_BOT,
  HEALTH_PER_LIFE,
  MAP_BOUNDS,
  PLAYER_COUNT,
  WEAPON_TIER,
  PERSONALITY_STRATEGY,
} from "../constants/weapons";
import { useGameManager } from "./GameManager";

/* ── Obstacle / raycast constants ───────────────────────────────── */
const OBSTACLE_LOOKAHEAD = 3;
const RAY_ORIGIN_Y = 1.3;
const LOS_THRESHOLD = 0.98;
const STALEMATE_CHECK_INTERVAL = 300;
const STALEMATE_DIST_DELTA = 0.35;
const STALEMATE_TIME_THRESHOLD = 1000; // 1 s stuck → change target
/** When no line of sight to target (wall/obstacle), switch target after this ms so we don't stalemate */
const NO_LOS_STANDOFF_MS = 150;
/** When only 2 bots and we give up on the other (no LOS), don't re-select them for this long so we actually wander */
const NO_LOS_EXCLUDE_DURATION_MS = 3000;
/** Persist "path around obstacle" direction this long to avoid left-right oscillation */
const NO_LOS_PATH_PERSIST_MS = 700;
const TARGET_PERSISTENCE_MS = 0;
const STUCK_RECOVERY_DURATIONS = [500, 900, 1400];
const RECOVERY_QUADRANT_AVOID_MS = 1500;

/* ── Wall-following / waypoint navigation ────────────────────────── */
/** How long to persist a wall-follow side before re-evaluating */
const WALL_FOLLOW_PERSIST_MS = 1200;
/** Max time to wall-follow before giving up and trying something else */
const WALL_FOLLOW_MAX_MS = 4000;
/** Distance at which a waypoint is considered "reached" */
const WAYPOINT_REACH_DIST = 2.0;
/** How far ahead to place intermediate waypoints */
const WAYPOINT_DISTANCE = 5.0;
/** Max waypoints to chain before resetting */
const MAX_WAYPOINT_CHAIN = 3;
/** Position history length for oscillation detection */
const POS_HISTORY_LENGTH = 6;
/** Interval to sample position history (ms) */
const POS_HISTORY_INTERVAL = 250;
/** If all history positions fit in this radius, bot is oscillating */
const OSCILLATION_RADIUS = 1.5;

/* ── Tuning constants ──────────────────────────────────────────── */
const BASE_MOVEMENT_SPEED = 260;
const MELEE_RANGE = 2.0;
const KNIFE_RUSH_DECISION_RADIUS = 15; // within this range, always pursue/melee; don't go for gun first
const RESPAWN_DELAY = 2000;
const OCCUPIED_RADIUS = 3;
/** Min distance (m) from death position when choosing respawn so we never respawn on the spot */
const MIN_RESPAWN_DISTANCE = 8;
/** Off-screen position so bots are never visible at origin before spawn */
const OFFSCREEN_POS = { x: 1e5, y: -1e4, z: 1e5 };

// Stuck detection & recovery
const STUCK_CHECK_INTERVAL = 300; // ms between checks
const STUCK_DISTANCE_THRESHOLD = 0.3; // moved less than this = barely moving
const STUCK_TIME_THRESHOLD = 800; // ms stuck before recovery kicks in
const STUCK_RECOVERY_DURATION = 600; // ms to move in recovery direction

// Timing
const STRAFE_CHANGE_INTERVAL = 800;
const WANDER_CHANGE_MIN = 800;
const WANDER_CHANGE_MAX = 1500;
const LOW_AMMO_THRESHOLD = 3;

/* ── Raycast helpers: World.castRay(ray, maxToi, solid, filterPredicate?) ── */
function castRay(world, rapier, origin, angle, maxDist, excludeRigidBodyHandle = null) {
  if (!world || !rapier) return null;
  const dir = { x: Math.sin(angle), y: 0, z: Math.cos(angle) };
  const ray = new rapier.Ray(origin, dir);
  const filter = excludeRigidBodyHandle != null
    ? (collider) => (collider.parent()?.handle ?? -1) !== excludeRigidBodyHandle
    : undefined;
  return world.castRay(ray, maxDist, true, filter);
}

function hasLineOfSight(world, rapier, fromPos, toPos, excludeRigidBodyHandle = null) {
  if (!world || !rapier) return false;
  const dx = toPos.x - fromPos.x;
  const dz = toPos.z - fromPos.z;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 0.01) return true;
  const origin = { x: fromPos.x, y: RAY_ORIGIN_Y, z: fromPos.z };
  const dir = { x: dx / len, y: 0, z: dz / len };
  const ray = new rapier.Ray(origin, dir);
  const filter = excludeRigidBodyHandle != null
    ? (collider) => (collider.parent()?.handle ?? -1) !== excludeRigidBodyHandle
    : undefined;
  const hit = world.castRay(ray, len, true, filter);
  if (!hit) return true;
  return hit.toi >= len * LOS_THRESHOLD;
}

/** Try desiredAngle first, then offsets ±22.5°, ±45°, ±67.5°, ±90°, ±120°; return angle with longest clear distance. */
function findClearDirection(world, rapier, origin, desiredAngle, lookahead, excludeRigidBodyHandle = null) {
  if (!world || !rapier) return desiredAngle;
  const offsets = [
    0,
    Math.PI / 8, -Math.PI / 8,
    Math.PI / 4, -Math.PI / 4,
    Math.PI * 3 / 8, -Math.PI * 3 / 8,
    Math.PI / 2, -Math.PI / 2,
    Math.PI * 2 / 3, -Math.PI * 2 / 3,
  ];
  let bestAngle = desiredAngle;
  let bestToi = 0;
  for (const off of offsets) {
    const angle = desiredAngle + off;
    const hit = castRay(world, rapier, origin, angle, lookahead, excludeRigidBodyHandle);
    const toi = hit ? hit.toi : lookahead;
    if (toi > bestToi) {
      bestToi = toi;
      bestAngle = angle;
    }
  }
  return bestAngle;
}

/** Normalize an angle to [-PI, PI]. */
function normalizeAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/**
 * Scored navigation: 16 directions (22.5° apart).
 * Scores by: clearDistance (weighted) + alignment with targetAngle (weighted).
 * Returns best angle that balances forward progress and open space.
 */
function findBestNavigationAngle(world, rapier, origin, targetAngle, maxDist, excludeRigidBodyHandle = null) {
  if (!world || !rapier) return targetAngle;
  const NUM_RAYS = 16;
  let bestAngle = targetAngle;
  let bestScore = -Infinity;
  for (let i = 0; i < NUM_RAYS; i++) {
    const angle = (i / NUM_RAYS) * Math.PI * 2;
    const hit = castRay(world, rapier, origin, angle, maxDist, excludeRigidBodyHandle);
    const toi = hit ? hit.toi : maxDist;
    const normalizedToi = toi / maxDist;
    const diff = Math.abs(normalizeAngle(angle - targetAngle));
    const alignment = 1 - diff / Math.PI;
    const score = normalizedToi * 0.55 + alignment * 0.45;
    if (score > bestScore) {
      bestScore = score;
      bestAngle = angle;
    }
  }
  return bestAngle;
}

/**
 * Cast rays to find the wall normal direction at the current position.
 * Returns the angle pointing away from the nearest wall, or null if no wall nearby.
 */
function findWallNormalAngle(world, rapier, origin, maxDist, excludeRigidBodyHandle = null) {
  if (!world || !rapier) return null;
  let closestToi = Infinity;
  let closestAngle = 0;
  for (let i = 0; i < 16; i++) {
    const angle = (i / 16) * Math.PI * 2;
    const hit = castRay(world, rapier, origin, angle, maxDist, excludeRigidBodyHandle);
    if (hit && hit.toi < closestToi) {
      closestToi = hit.toi;
      closestAngle = angle;
    }
  }
  if (closestToi >= maxDist) return null;
  return normalizeAngle(closestAngle + Math.PI);
}

/** Advantage score: positive = favorable fight. Uses health, weapon tier, lives, ammo, distance. */
function evaluateMatchup(myState, enemyEntry, myPos) {
  const myHealth = myState.health ?? 100;
  const myLives = myState.lives ?? LIVES_PER_BOT;
  const myWeapon = myState.weapon ?? WEAPON_TYPES.KNIFE;
  const myAmmo = myState.ammo ?? 0;
  const enemyHealth = enemyEntry.health ?? 100;
  const enemyLives = enemyEntry.player?.state?.lives ?? LIVES_PER_BOT;
  const enemyWeapon = enemyEntry.weapon ?? WEAPON_TYPES.KNIFE;
  const dist = enemyEntry.distance ?? 0;

  let score = 0;
  score += (myHealth - enemyHealth) / 150;
  score += (myLives - enemyLives) * 0.1;
  const myTier = WEAPON_TIER[myWeapon] ?? 0;
  const enemyTier = WEAPON_TIER[enemyWeapon] ?? 0;
  score += (myTier - enemyTier) * 0.15;
  if (myWeapon !== WEAPON_TYPES.KNIFE && (myAmmo == null || myAmmo < 3)) score -= 0.15;
  if (myWeapon === WEAPON_TYPES.KNIFE && enemyWeapon === WEAPON_TYPES.KNIFE) score += 0.4;
  if (myWeapon === WEAPON_TYPES.KNIFE && enemyWeapon === WEAPON_TYPES.KNIFE && dist < 8) score += 0.3;
  if (dist < 4 && myWeapon === WEAPON_TYPES.KNIFE) score += 0.2;
  return score;
}

/**
 * Pick target: nearest first; among similar distance prefer lower health and inferior weapon.
 * excludeId: when in stalemate or stuck with current target, switch to another bot.
 * excludeUntil: { [enemyId]: timestamp } — don't select these until after timestamp (e.g. no-LOS give-up).
 */
function selectTarget(allEnemies, myHealth, excludeId = null, excludeUntil = null, now = 0) {
  let list = allEnemies;
  if (excludeUntil != null && now > 0) {
    list = list.filter((e) => (excludeUntil[e.id] ?? 0) <= now);
  }
  if (excludeId && list.length > 1) {
    list = list.filter((e) => e.id !== excludeId);
  }
  if (!list.length) return null;
  const myTier = (e) => (WEAPON_TIER[e.weapon] ?? 0);
  const sorted = [...list].sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance;
    const healthA = a.health ?? 100;
    const healthB = b.health ?? 100;
    if (healthA !== healthB) return healthA - healthB;
    return (myTier(a) - myTier(b)); // lower weapon tier = weaker = prefer
  });
  return sorted[0];
}

/* ── Personality definitions ───────────────────────────────────── *
 *  detectRadius  – how far the bot "sees" enemies
 *  preferredDist – ideal combat distance (controls positioning, not shooting)
 *  speedMult     – movement speed multiplier
 *  fleeHealth    – HP threshold below which the bot retreats
 *  accuracy      – 0-1, tighter bullet spread for higher values
 */
const PERSONALITY_MODS = {
  Aggressive: {
    detectRadius: 75,
    preferredDist: 5,
    speedMult: 1.25,
    fleeHealth: 0,
    accuracy: 0.82,
  },
  Cautious: {
    detectRadius: 75,
    preferredDist: 6,
    speedMult: 1.2,
    fleeHealth: 0,
    accuracy: 0.75,
  },
  Sniper: {
    detectRadius: 80,
    preferredDist: 10,
    speedMult: 1.15,
    fleeHealth: 0,
    accuracy: 0.92,
  },
  Rusher: {
    detectRadius: 70,
    preferredDist: 3,
    speedMult: 1.4,
    fleeHealth: 0,
    accuracy: 0.68,
  },
  Tactician: {
    detectRadius: 75,
    preferredDist: 6,
    speedMult: 1.2,
    fleeHealth: 0,
    accuracy: 0.8,
  },
};

/* ── Bot helper class ──────────────────────────────────────────── */
export class PlayerBot extends Bot {
  constructor(params) {
    super(params);
  }

  /** All alive enemies sorted closest-first */
  getAllEnemies(players, myId, myPos) {
    if (!myPos) return [];
    const result = [];
    for (const p of players) {
      if (p.id === myId || !p.state?.pos) continue;
      if (
        p.state.eliminated ||
        p.state.dead ||
        (p.state.lives !== undefined && p.state.lives <= 0)
      )
        continue;
      const pos = p.state.pos;
      const d = vec3(myPos).distanceTo(vec3(pos));
      result.push({
        player: p,
        distance: d,
        angle: -Math.atan2(pos.z - myPos.z, pos.x - myPos.x) + Math.PI / 2,
        pos,
        health: p.state.health ?? 100,
        weapon: p.state.weapon ?? WEAPON_TYPES.KNIFE,
      });
    }
    result.sort((a, b) => a.distance - b.distance);
    return result;
  }

  getNearestEnemy(players, myId, myPos) {
    const all = this.getAllEnemies(players, myId, myPos);
    return all.length
      ? all[0]
      : { player: null, distance: Infinity, angle: 0 };
  }

  /**
   * Broadcast view of all enemies: location, weapon, health, lives.
   * Uses shared Playroom state so every bot has full visibility of others.
   * Returns array of { id, pos, weapon, health, lives, distance, angle, player } sorted by distance.
   */
  getBroadcastEnemyStates(players, myId, myPos) {
    if (!myPos || !players?.length) return [];
    const out = [];
    for (const p of players) {
      if (p.id === myId || !p.state?.pos) continue;
      if (p.state.eliminated || p.state.dead || (p.state.lives != null && p.state.lives <= 0)) continue;
      const pos = p.state.pos;
      const distance = vec3(myPos).distanceTo(vec3(pos));
      out.push({
        id: p.id,
        pos,
        weapon: p.state.weapon ?? WEAPON_TYPES.KNIFE,
        health: p.state.health ?? 100,
        lives: p.state.lives ?? LIVES_PER_BOT,
        distance,
        angle: -Math.atan2(pos.z - myPos.z, pos.x - myPos.x) + Math.PI / 2,
        player: p,
      });
    }
    out.sort((a, b) => a.distance - b.distance);
    return out;
  }

  /** All available (not-taken) pickups sorted closest-first */
  getAllPickups(pickups, myPos) {
    if (!myPos || !pickups?.length) return [];
    return pickups
      .filter((p) => !p.taken)
      .map((p) => {
        const pos = p.position;
        return {
          ...p,
          distance: vec3(myPos).distanceTo(vec3(pos.x, pos.y, pos.z)),
          angle:
            -Math.atan2(pos.z - myPos.z, pos.x - myPos.x) + Math.PI / 2,
        };
      })
      .sort((a, b) => a.distance - b.distance);
  }

  getNearestPickup(pickups, myPos) {
    const all = this.getAllPickups(pickups, myPos);
    return all.length
      ? { pickup: all[0], distance: all[0].distance, position: all[0].position }
      : { pickup: null, distance: Infinity, position: null };
  }

  getMoveAngleToward(target, myPos) {
    if (!target || !myPos) return 0;
    return (
      -Math.atan2(target.z - myPos.z, target.x - myPos.x) + Math.PI / 2
    );
  }

  getMoveAngleAwayFrom(threat, myPos) {
    if (!threat || !myPos) return 0;
    return (
      -Math.atan2(myPos.z - threat.z, myPos.x - threat.x) + Math.PI / 2
    );
  }
}

/* ── BotController component ──────────────────────────────────── */
export const BotController = ({
  state,
  onFire,
  onKilled,
  onMeleeHit,
  onWeaponPickup,
  onWeaponDrop,
  onWeaponEmpty,
  downgradedPerformance,
  getSpawnPositions,
  getModelSpawnPositions,
  getInitialSpawnPosition,
  spawnIndex = 0,
  ...props
}) => {
  const group = useRef();
  const character = useRef();
  const rigidbody = useRef();
  const lastShoot = useRef(0);
  const lastMelee = useRef(0);
  const players = usePlayersList(true);
  const { weaponPickups, gamePhase } = useGameManager();
  const [animation, setAnimation] = useState("Idle");
  const [spawnPos, setSpawnPos] = useState([OFFSCREEN_POS.x, OFFSCREEN_POS.y, OFFSCREEN_POS.z]);
  const [bodyKey, setBodyKey] = useState(0);
  const scene = useThree((s) => s.scene);
  const bot = state.bot;
  const { world, rapier } = useRapier();

  /* Wander */
  const wanderAngleRef = useRef(Math.random() * Math.PI * 2);
  const wanderChangeTimeRef = useRef(0);

  /* Strafe */
  const strafeDirRef = useRef(Math.random() > 0.5 ? 1 : -1);
  const strafeChangeTimeRef = useRef(0);

  /* Stuck detection & recovery */
  const lastStuckCheckRef = useRef(0);
  const lastStuckPosRef = useRef(null);
  const stuckAccumRef = useRef(0);
  const stuckConsecutiveCountRef = useRef(0);
  const recoveryRef = useRef({ active: false, angle: 0, until: 0 });
  const lastMoveAngleRef = useRef(0);
  const lastRecoveryTimeRef = useRef(0);
  const recoveryQuadrantRef = useRef(0);

  /* Stalemate / engagement */
  const engagementRef = useRef({ targetId: null, startTime: 0, lastDist: Infinity, lastCheckTime: 0, noLOSExcludeUntil: {} });
  const targetPersistRef = useRef({ id: null, until: 0 });
  const flankWaypointRef = useRef(null);
  /* Persist "path around obstacle" angle to avoid left-right oscillation when no LOS */
  const noLOSPathRef = useRef({ angle: 0, until: 0 });

  /* Wall-following state: side = 1 (right) or -1 (left), startTime, until */
  const wallFollowRef = useRef({ active: false, side: 1, startTime: 0, until: 0, targetId: null });

  /* Intermediate waypoint navigation */
  const waypointRef = useRef({ pos: null, chainCount: 0, setTime: 0 });

  /* Position history for oscillation detection */
  const posHistoryRef = useRef([]);
  const posHistoryTimeRef = useRef(0);

  /* Ref so setTimeout always uses the latest spawn function */
  const spawnFnRef = useRef(null);
  /* Track if we've placed initial spawn so we only enable body after placement (avoid 0,0,0) */
  const hasPlacedInitialSpawnRef = useRef(false);

  /* ── Find a random spawn point, excluding the supplied position. useModelOnly = true for respawn (arena spawns only). ── */
  const getEmptySpawnPosition = useCallback(
    (excludePos = null, useModelOnly = false) => {
      const randomInBounds = (minDistFrom = null) => {
        for (let i = 0; i < 20; i++) {
          const pt = {
            x: MAP_BOUNDS.minX + Math.random() * (MAP_BOUNDS.maxX - MAP_BOUNDS.minX),
            y: 0,
            z: MAP_BOUNDS.minZ + Math.random() * (MAP_BOUNDS.maxZ - MAP_BOUNDS.minZ),
          };
          if (!minDistFrom || vec3(pt).distanceTo(vec3(minDistFrom)) >= MIN_RESPAWN_DISTANCE)
            return pt;
        }
        return {
          x: MAP_BOUNDS.minX + Math.random() * (MAP_BOUNDS.maxX - MAP_BOUNDS.minX),
          y: 0,
          z: MAP_BOUNDS.minZ + Math.random() * (MAP_BOUNDS.maxZ - MAP_BOUNDS.minZ),
        };
      };
      const positions = useModelOnly
        ? (getModelSpawnPositions?.() ?? [])
        : (getSpawnPositions?.() ?? []);
      if (!positions.length) return randomInBounds(excludePos);

      /* Collect positions occupied by other alive bots */
      const occupied = [];
      for (const p of players) {
        if (!p.state?.isBot?.()) continue;
        if (!p.state?.pos) continue;
        if (
          p.state.eliminated ||
          (p.state.lives !== undefined && p.state.lives <= 0)
        )
          continue;
        if (p.state.dead) continue;
        if (p.id === state.id) continue;
        occupied.push(p.state.pos);
      }

      /* Also mark the death / current position as occupied */
      if (excludePos) {
        occupied.push({ x: excludePos.x, y: excludePos.y, z: excludePos.z });
      }

      const minDistFromExclude = excludePos ? MIN_RESPAWN_DISTANCE : OCCUPIED_RADIUS;
      const isFree = (sp) => {
        const v = vec3({ x: sp.x ?? 0, y: sp.y ?? 0, z: sp.z ?? 0 });
        if (occupied.some((o) => v.distanceTo(vec3(o)) < OCCUPIED_RADIUS)) return false;
        if (excludePos && v.distanceTo(vec3(excludePos)) < minDistFromExclude) return false;
        return true;
      };

      const emptySpawns = positions.filter(isFree);
      if (emptySpawns.length) {
        return emptySpawns[Math.floor(Math.random() * emptySpawns.length)];
      }

      /* Fallback: any spawn at least MIN_RESPAWN_DISTANCE from death */
      if (excludePos) {
        const fallback = positions.filter((sp) => {
          const v = vec3({ x: sp.x ?? 0, y: sp.y ?? 0, z: sp.z ?? 0 });
          return v.distanceTo(vec3(excludePos)) >= minDistFromExclude;
        });
        if (fallback.length) {
          return fallback[Math.floor(Math.random() * fallback.length)];
        }
        return randomInBounds(excludePos);
      }
      return positions[Math.floor(Math.random() * positions.length)];
    },
    [getSpawnPositions, getModelSpawnPositions, players, state.id]
  );

  /* Keep ref in sync so setTimeout closures always use the latest version */
  useEffect(() => {
    spawnFnRef.current = getEmptySpawnPosition;
  }, [getEmptySpawnPosition]);

  const spawnAtPosition = useCallback((pos) => {
    if (!pos || !rigidbody.current) {
      if (!pos && rigidbody.current) console.warn("[Bot spawn] spawnAtPosition called with null/undefined pos");
      return;
    }
    rigidbody.current.setTranslation({
      x: pos.x ?? 0,
      y: pos.y ?? 0,
      z: pos.z ?? 0,
    });
    rigidbody.current.setLinvel({ x: 0, y: 0, z: 0 });
  }, []);

  /* ── Initial spawn: only when spawn positions are available; retry until then ── */
  useEffect(() => {
    if (!isHost()) return;

    let retryId = null;

    let retryAttempt = 0;
    const trySpawn = () => {
      if (!rigidbody.current) {
        retryAttempt += 1;
        if (retryAttempt % 5 === 1) console.log("[Bot spawn] no rigidbody yet:", state.state.profile?.name);
        return false;
      }
      const positions = getSpawnPositions?.() ?? [];
      if (positions.length < PLAYER_COUNT && !getInitialSpawnPosition) {
        retryAttempt += 1;
        if (retryAttempt % 5 === 1) {
          console.log("[Bot spawn] waiting for spawns:", { name: state.state.profile?.name, positions: positions.length, need: PLAYER_COUNT });
        }
        return false;
      }
      const pos = getInitialSpawnPosition
        ? getInitialSpawnPosition(spawnIndex)
        : (spawnFnRef.current ?? getEmptySpawnPosition)(null) ?? positions[spawnIndex % positions.length];
      if (pos) {
        setSpawnPos([pos.x ?? 0, pos.y ?? 0, pos.z ?? 0]);
        setBodyKey((k) => k + 1);
        hasPlacedInitialSpawnRef.current = true;
        console.log("[Bot spawn] ok:", state.state.profile?.name, "at", pos.x?.toFixed(1), pos.y?.toFixed(1), pos.z?.toFixed(1));
      }
      return true;
    };

    const schedule = (delay) => {
      return setTimeout(() => {
        if (!trySpawn()) {
          retryId = schedule(400);
        }
      }, delay);
    };

    const t1 = schedule(100);

    return () => {
      clearTimeout(t1);
      if (retryId) clearTimeout(retryId);
    };
  }, []);

  /* ── Death → respawn after delay at a random empty spawn ── */
  useEffect(() => {
    if (!state.state.dead) return;

    if (gamePhase === "playing") {
      try {
        const audio = new Audio("/claw-shooter/sounds/death.mp3");
        audio.volume = 0.5;
        audio.play();
      } catch (_) {}
    }

    /* Capture death position and weapon as plain values (Rapier may reuse translation object) */
    const t = rigidbody.current?.translation();
    const deathPos = t
      ? { x: Number(t.x), y: Number(t.y), z: Number(t.z) }
      : null;
    const weaponOnDeath = state.getState("weapon");
    if (rigidbody.current) rigidbody.current.setEnabled(false);

    const timer = setTimeout(() => {
      if (state.state.eliminated) return;

      /* Respawn: prefer arena model spawn points; fall back to any spawn, then random in MAP_BOUNDS */
      const fn = spawnFnRef.current ?? getEmptySpawnPosition;
      let pos = deathPos != null ? fn(deathPos, true) : fn(null, true);
      if (!pos) pos = deathPos != null ? fn(deathPos, false) : fn(null, false);
      if (!pos) {
        pos = {
          x: MAP_BOUNDS.minX + Math.random() * (MAP_BOUNDS.maxX - MAP_BOUNDS.minX),
          y: 0,
          z: MAP_BOUNDS.minZ + Math.random() * (MAP_BOUNDS.maxZ - MAP_BOUNDS.minZ),
        };
      }
      let p = { x: pos.x ?? 0, y: pos.y ?? 0, z: pos.z ?? 0 };

      /* Final safety: never respawn at or near death position (handles shared refs or engine quirks) */
      if (deathPos != null) {
        const dist = vec3(p).distanceTo(vec3(deathPos));
        if (dist < MIN_RESPAWN_DISTANCE) {
          for (let i = 0; i < 15; i++) {
            const q = {
              x: MAP_BOUNDS.minX + Math.random() * (MAP_BOUNDS.maxX - MAP_BOUNDS.minX),
              y: 0,
              z: MAP_BOUNDS.minZ + Math.random() * (MAP_BOUNDS.maxZ - MAP_BOUNDS.minZ),
            };
            if (vec3(q).distanceTo(vec3(deathPos)) >= MIN_RESPAWN_DISTANCE) {
              p = q;
              break;
            }
          }
        }
      }

      /* Remount RigidBody at new position via key change so Rapier creates a fresh body at p */
      setSpawnPos([p.x, p.y, p.z]);
      setBodyKey((k) => k + 1);

      /* Drop the weapon the bot had as a pickup elsewhere (if it was a gun) */
      if (
        weaponOnDeath &&
        weaponOnDeath !== WEAPON_TYPES.KNIFE &&
        onWeaponDrop
      ) {
        onWeaponDrop(weaponOnDeath);
      }

      state.setState("dead", false);
      state.setState("health", HEALTH_PER_LIFE);
      state.setState("weapon", WEAPON_TYPES.KNIFE);
      state.setState("ammo", null);
      state.setState("aliveSince", Date.now());

      /* Reset stuck detection, navigation state, and engagement on respawn */
      stuckAccumRef.current = 0;
      stuckConsecutiveCountRef.current = 0;
      recoveryRef.current = { active: false, angle: 0, until: 0 };
      lastStuckPosRef.current = null;
      engagementRef.current = { targetId: null, startTime: 0, lastDist: Infinity, lastCheckTime: 0 };
      targetPersistRef.current = { id: null, until: 0 };
      flankWaypointRef.current = null;
      wallFollowRef.current = { active: false, side: 1, startTime: 0, until: 0, targetId: null };
      waypointRef.current = { pos: null, chainCount: 0, setTime: 0 };
      posHistoryRef.current = [];
    }, RESPAWN_DELAY);

    return () => clearTimeout(timer);
  }, [state.state.dead]);

  /* ══════════════════════ MAIN AI LOOP ══════════════════════ */
  useFrame((_, delta) => {
    if (!rigidbody.current || !bot) return;

    if (gamePhase !== "playing") {
      setAnimation("Idle");
      return;
    }

    if (state.state.dead) {
      setAnimation("Death");
      return;
    }

    if (state.state.eliminated) {
      rigidbody.current.setEnabled(false);
      return;
    }

    const myPos = rigidbody.current.translation();
    const personality = state.getState("personality") || "Tactician";
    const mods = PERSONALITY_MODS[personality] || PERSONALITY_MODS.Tactician;

    let weapon = state.getState("weapon") || WEAPON_TYPES.KNIFE;
    let ammo = state.getState("ammo");

    /* Auto-switch to knife when ammo is depleted; host spawns a new pickup of that weapon */
    if (weapon !== WEAPON_TYPES.KNIFE && (ammo == null || ammo <= 0)) {
      const emptiedWeapon = weapon;
      state.setState("weapon", WEAPON_TYPES.KNIFE);
      state.setState("ammo", null);
      weapon = WEAPON_TYPES.KNIFE;
      ammo = null;
      if (isHost()) onWeaponEmpty?.(emptiedWeapon);
    }

    const hasGun = weapon !== WEAPON_TYPES.KNIFE;
    const weaponStats = WEAPON_STATS[weapon];
    const health = state.state.health ?? 100;
    const { detectRadius, preferredDist, speedMult, fleeHealth, accuracy } =
      mods;
    const lastDamageTime = state.getState("lastDamageTime") || 0;
    const recentlyHurt = Date.now() - lastDamageTime < 1200;
    const now = Date.now();

    /* ── World awareness: broadcast enemy states ── */
    const allEnemies = bot.getBroadcastEnemyStates(players, state.id, myPos);
    const allPickups = bot.getAllPickups(weaponPickups, myPos);
    const nearestPickup = allPickups[0] || null;
    const myHealth = state.state.health ?? 100;
    const excludeHandle = rigidbody.current?.raw?.() ?? rigidbody.current;
    const myRigidBodyHandle = excludeHandle?.handle ?? null;
    const rayOrigin = { x: myPos.x, y: RAY_ORIGIN_Y, z: myPos.z };

    /* First pick: current target; respect no-LOS exclude so 2 bots don't re-target each other across a wall */
    const excludeUntil = engagementRef.current.noLOSExcludeUntil || {};
    let nearest = selectTarget(allEnemies, myHealth, null, excludeUntil, now);
    const hasLOSToTarget = nearest && world && rapier && hasLineOfSight(world, rapier, myPos, nearest.pos, myRigidBodyHandle);

    /* Stalemate: distance not changing or obstacle between us → switch to another bot for better odds */
    let switchTargetId = null;
    if (nearest?.id) {
      const eng = engagementRef.current;
      if (eng.targetId !== nearest.id) {
        engagementRef.current = { ...eng, targetId: nearest.id, startTime: now, lastDist: nearest.distance, lastCheckTime: now };
        noLOSPathRef.current = { angle: 0, until: 0 }; /* fresh target → recompute path-around direction */
      } else if (now - eng.lastCheckTime > STALEMATE_CHECK_INTERVAL) {
        engagementRef.current.lastCheckTime = now;
        const distDelta = Math.abs(nearest.distance - eng.lastDist);
        engagementRef.current.lastDist = nearest.distance;
        const timeEngaged = now - eng.startTime;
        const stuckStandoff = distDelta < STALEMATE_DIST_DELTA && timeEngaged > STALEMATE_TIME_THRESHOLD;
        const noLOSStandoff = !hasLOSToTarget && timeEngaged > NO_LOS_STANDOFF_MS;
        if (stuckStandoff || noLOSStandoff) {
          switchTargetId = nearest.id;
          engagementRef.current.startTime = now;
        }
      }
    } else {
      engagementRef.current.targetId = null;
    }

    if (switchTargetId && allEnemies.length > 1) {
      nearest = selectTarget(allEnemies, myHealth, switchTargetId);
    }
    /* When only 2 bots and we gave up on the other (no LOS), don't re-select them for a while so we wander and break the loop */
    if (switchTargetId && allEnemies.length === 2 && nearest == null) {
      engagementRef.current.noLOSExcludeUntil = { ...(engagementRef.current.noLOSExcludeUntil || {}), [switchTargetId]: now + NO_LOS_EXCLUDE_DURATION_MS };
      noLOSPathRef.current = { angle: 0, until: 0 };
    }

    /* ── Position history for oscillation detection ── */
    if (now - posHistoryTimeRef.current > POS_HISTORY_INTERVAL) {
      posHistoryTimeRef.current = now;
      posHistoryRef.current.push({ x: myPos.x, z: myPos.z, t: now });
      if (posHistoryRef.current.length > POS_HISTORY_LENGTH) {
        posHistoryRef.current.shift();
      }
    }

    /* ── Stuck detection & raycast-based recovery (improved with oscillation check) ── */
    if (now - lastStuckCheckRef.current > STUCK_CHECK_INTERVAL) {
      lastStuckCheckRef.current = now;
      if (lastStuckPosRef.current) {
        const d = vec3(myPos).distanceTo(vec3(lastStuckPosRef.current));
        if (d < STUCK_DISTANCE_THRESHOLD) {
          stuckAccumRef.current += STUCK_CHECK_INTERVAL;
        } else {
          stuckAccumRef.current = 0;
          recoveryRef.current.active = false;
        }
      }
      lastStuckPosRef.current = { x: myPos.x, y: myPos.y, z: myPos.z };

      /* Oscillation detection: if all recent positions cluster in a small radius */
      let isOscillating = false;
      const hist = posHistoryRef.current;
      if (hist.length >= POS_HISTORY_LENGTH) {
        let cx = 0, cz = 0;
        for (const h of hist) { cx += h.x; cz += h.z; }
        cx /= hist.length; cz /= hist.length;
        let maxDistFromCenter = 0;
        for (const h of hist) {
          const dd = Math.sqrt((h.x - cx) ** 2 + (h.z - cz) ** 2);
          if (dd > maxDistFromCenter) maxDistFromCenter = dd;
        }
        if (maxDistFromCenter < OSCILLATION_RADIUS) isOscillating = true;
      }

      const shouldRecover = (stuckAccumRef.current >= STUCK_TIME_THRESHOLD || isOscillating) && !recoveryRef.current.active;

      if (shouldRecover) {
        if (nearest?.id && allEnemies.length > 1) {
          nearest = selectTarget(allEnemies, myHealth, nearest.id);
          engagementRef.current = { ...engagementRef.current, targetId: nearest?.id ?? null, startTime: now, lastDist: nearest?.distance ?? Infinity, lastCheckTime: now };
        }
        stuckConsecutiveCountRef.current = Math.min(2, stuckConsecutiveCountRef.current + 1);
        const durationIndex = Math.min(stuckConsecutiveCountRef.current, STUCK_RECOVERY_DURATIONS.length - 1);
        const duration = STUCK_RECOVERY_DURATIONS[durationIndex];

        /* Use wall normal to pick a perpendicular escape direction */
        let recoveryAngle;
        const wallNormal = findWallNormalAngle(world, rapier, rayOrigin, OBSTACLE_LOOKAHEAD * 2, myRigidBodyHandle);
        if (wallNormal !== null) {
          const side = (recoveryQuadrantRef.current % 2 === 0) ? 1 : -1;
          const perpAngle = wallNormal + (Math.PI / 2) * side;
          recoveryQuadrantRef.current += 1;
          recoveryAngle = findBestNavigationAngle(world, rapier, rayOrigin, perpAngle, OBSTACLE_LOOKAHEAD * 2.5, myRigidBodyHandle);
        } else {
          const side = (recoveryQuadrantRef.current % 2 === 0) ? 1 : -1;
          const preferredAngle = nearest ? nearest.angle + (Math.PI / 2) * side : lastMoveAngleRef.current + Math.PI;
          recoveryQuadrantRef.current += 1;
          recoveryAngle = findBestNavigationAngle(world, rapier, rayOrigin, preferredAngle, OBSTACLE_LOOKAHEAD * 2.5, myRigidBodyHandle);
        }

        lastRecoveryTimeRef.current = now;
        recoveryRef.current = { active: true, angle: recoveryAngle, until: now + duration };
        stuckAccumRef.current = 0;
        posHistoryRef.current = [];
        waypointRef.current = { pos: null, chainCount: 0, setTime: 0 };
        wallFollowRef.current.active = false;
      }
    }
    if (recoveryRef.current.active && now > recoveryRef.current.until) {
      recoveryRef.current.active = false;
    }
    if (lastStuckPosRef.current && vec3(myPos).distanceTo(vec3(lastStuckPosRef.current)) >= STUCK_DISTANCE_THRESHOLD) {
      stuckConsecutiveCountRef.current = 0;
    }

    /* ── Wander angle (changes every 1.5–3 s) ── */
    if (
      now - wanderChangeTimeRef.current >
      WANDER_CHANGE_MIN + Math.random() * (WANDER_CHANGE_MAX - WANDER_CHANGE_MIN)
    ) {
      wanderAngleRef.current = Math.random() * Math.PI * 2;
      wanderChangeTimeRef.current = now;
    }

    /* ── Strafe direction toggle ── */
    if (now - strafeChangeTimeRef.current > STRAFE_CHANGE_INTERVAL) {
      strafeDirRef.current = Math.random() > 0.5 ? 1 : -1;
      strafeChangeTimeRef.current = now;
    }

    const moveSpeed = BASE_MOVEMENT_SPEED * speedMult * delta;
    let moveAngle = null;
    let lookAngle = null;
    let stateLabel = "Idle";

    const enemyDetected = nearest && nearest.distance < detectRadius;
    const pickupAvailable = !!nearestPickup;

    /* ═══════════════════ RELENTLESS ATTACK: zero hesitation, no caution ═══════════════════ */

    /* No gun + pickup nearby and (no enemy or pickup closer than enemy or enemy far): get armed first */
    const gunCloserThanEnemy = !hasGun && nearestPickup && (
      !nearest ||
      nearestPickup.distance < nearest.distance ||
      nearestPickup.distance < 12
    ) && (!nearest || nearest.distance > KNIFE_RUSH_DECISION_RADIUS);

    if (gunCloserThanEnemy) {
      moveAngle = nearestPickup.angle;
      lookAngle = nearestPickup.angle;
      stateLabel = "Run";
    } else if (hasGun && enemyDetected) {
      lookAngle = nearest.angle;
      if (weaponStats && !weaponStats.isMelee && ammo > 0 && hasLOSToTarget) {
        if (now - lastShoot.current > weaponStats.fireRate) {
          lastShoot.current = now;
          const spread = weaponStats.spread ?? 0.02;
          const pellets = weaponStats.pellets ?? 1;
          const effSpread = spread * (2 - accuracy);
          for (let i = 0; i < pellets; i++) {
            const a = nearest.angle + (Math.random() - 0.5) * effSpread * 2;
            onFire({
              id: `${state.id}-${now}-${i}-${Math.random()}`,
              position: vec3(myPos),
              angle: a,
              player: state.id,
              weaponType: weapon,
            });
          }
          ammo = Math.max(0, ammo - 1);
          state.setState("ammo", ammo);
        }
      }
      moveAngle = nearest.distance > preferredDist * 0.9
        ? nearest.angle
        : nearest.angle + (Math.PI / 2.5) * strafeDirRef.current;
      stateLabel = hasLOSToTarget ? "Idle_Shoot" : "Run";

    } else if (!hasGun && nearest && nearest.distance < KNIFE_RUSH_DECISION_RADIUS) {
      /* Enemy within knife rush radius: always pursue and melee; don't go for gun first */
      if (nearest.distance <= MELEE_RANGE) {
        lookAngle = nearest.angle;
        if (now - lastMelee.current > KNIFE.fireRate) {
          lastMelee.current = now;
          onMeleeHit?.(nearest.player.id, state.id, KNIFE.damage);
        }
        stateLabel = "Idle_Shoot";
      } else {
        moveAngle = nearest.angle;
        lookAngle = nearest.angle;
        stateLabel = "Run";
      }
    } else if (!hasGun && enemyDetected) {
      /* Enemy detected but beyond knife rush radius: still close in (or grab very close pickup only) */
      if (nearest.distance <= MELEE_RANGE) {
        lookAngle = nearest.angle;
        if (now - lastMelee.current > KNIFE.fireRate) {
          lastMelee.current = now;
          onMeleeHit?.(nearest.player.id, state.id, KNIFE.damage);
        }
        stateLabel = "Idle_Shoot";
      } else if (nearestPickup && nearestPickup.distance < 3 && nearest.distance > KNIFE_RUSH_DECISION_RADIUS) {
        moveAngle = nearestPickup.angle;
        lookAngle = nearestPickup.angle;
        stateLabel = "Run";
      } else {
        moveAngle = nearest.angle;
        lookAngle = nearest.angle;
        stateLabel = "Run";
      }

    } else if (pickupAvailable && !hasGun) {
      /* No enemy nearby, no gun: sprint to nearest weapon */
      moveAngle = nearestPickup.angle;
      stateLabel = "Run";

    } else if (hasGun && ammo != null && ammo <= LOW_AMMO_THRESHOLD && pickupAvailable) {
      /* Low ammo: grab another weapon while hunting */
      moveAngle = nearestPickup.angle;
      stateLabel = "Run";

    } else if (nearest) {
      /* Enemy exists but outside detection: hunt them down */
      moveAngle = nearest.angle;
      stateLabel = "Run";

    } else {
      /* Nobody alive / nobody found: patrol aggressively */
      moveAngle = wanderAngleRef.current;
      stateLabel = "Run";
    }

    if (recoveryRef.current.active) {
      moveAngle = recoveryRef.current.angle;
      stateLabel = "Run";
    }

    /* ── Wall-following + waypoint navigation when no LOS to target ── */
    if (
      moveAngle !== null &&
      nearest &&
      !hasLOSToTarget &&
      world &&
      rapier &&
      !recoveryRef.current.active
    ) {
      const wf = wallFollowRef.current;

      /* Reset wall-follow if we switched targets */
      if (wf.active && wf.targetId !== nearest.id) {
        wf.active = false;
      }

      /* Check if we have an active waypoint to navigate to */
      const wp = waypointRef.current;
      let navigatingToWaypoint = false;
      if (wp.pos) {
        const wpDist = Math.sqrt((myPos.x - wp.pos.x) ** 2 + (myPos.z - wp.pos.z) ** 2);
        if (wpDist < WAYPOINT_REACH_DIST || now - wp.setTime > 3000) {
          waypointRef.current = { pos: null, chainCount: wp.chainCount, setTime: 0 };
        } else {
          const wpAngle = -Math.atan2(wp.pos.z - myPos.z, wp.pos.x - myPos.x) + Math.PI / 2;
          const wpHasLOS = hasLineOfSight(world, rapier, myPos, wp.pos, myRigidBodyHandle);
          if (wpHasLOS) {
            moveAngle = wpAngle;
            navigatingToWaypoint = true;
          } else {
            waypointRef.current = { pos: null, chainCount: wp.chainCount, setTime: 0 };
          }
        }
      }

      if (!navigatingToWaypoint) {
        /* Activate wall-following if not already active */
        if (!wf.active) {
          const leftAngle = nearest.angle + Math.PI / 2;
          const rightAngle = nearest.angle - Math.PI / 2;
          const leftHit = castRay(world, rapier, rayOrigin, leftAngle, OBSTACLE_LOOKAHEAD * 3, myRigidBodyHandle);
          const rightHit = castRay(world, rapier, rayOrigin, rightAngle, OBSTACLE_LOOKAHEAD * 3, myRigidBodyHandle);
          const leftClear = leftHit ? leftHit.toi : OBSTACLE_LOOKAHEAD * 3;
          const rightClear = rightHit ? rightHit.toi : OBSTACLE_LOOKAHEAD * 3;
          const chosenSide = leftClear >= rightClear ? 1 : -1;
          wallFollowRef.current = {
            active: true,
            side: chosenSide,
            startTime: now,
            until: now + WALL_FOLLOW_MAX_MS,
            targetId: nearest.id,
          };
        }

        /* Wall-follow expired */
        if (wf.active && now > wf.until) {
          wallFollowRef.current.active = false;
        }

        if (wallFollowRef.current.active) {
          /* Wall-following: move perpendicular to the target direction on the chosen side */
          const followAngle = nearest.angle + (Math.PI / 3) * wallFollowRef.current.side;
          moveAngle = findBestNavigationAngle(
            world, rapier, rayOrigin, followAngle,
            OBSTACLE_LOOKAHEAD * 4, myRigidBodyHandle
          );

          /* Try to place a waypoint that makes progress toward the target */
          if (waypointRef.current.chainCount < MAX_WAYPOINT_CHAIN) {
            const wpX = myPos.x + Math.sin(moveAngle) * WAYPOINT_DISTANCE;
            const wpZ = myPos.z + Math.cos(moveAngle) * WAYPOINT_DISTANCE;
            const candidateWP = { x: wpX, y: myPos.y, z: wpZ };
            const wpClear = hasLineOfSight(world, rapier, myPos, candidateWP, myRigidBodyHandle);
            if (wpClear) {
              waypointRef.current = { pos: candidateWP, chainCount: waypointRef.current.chainCount + 1, setTime: now };
            }
          }
        } else {
          /* Fallback: use scored navigation toward target */
          const pathRef = noLOSPathRef.current;
          if (now < pathRef.until) {
            moveAngle = pathRef.angle;
          } else {
            moveAngle = findBestNavigationAngle(
              world, rapier, rayOrigin, nearest.angle,
              OBSTACLE_LOOKAHEAD * 4, myRigidBodyHandle
            );
            noLOSPathRef.current = { angle: moveAngle, until: now + NO_LOS_PATH_PERSIST_MS };
          }
        }
      }
    } else if (hasLOSToTarget && nearest) {
      /* We have LOS again: reset wall-follow and waypoint state */
      wallFollowRef.current.active = false;
      waypointRef.current = { pos: null, chainCount: 0, setTime: 0 };
    }

    if (moveAngle !== null) lastMoveAngleRef.current = moveAngle;

    /* ── Obstacle-aware movement: raycast and steer around nearby obstacles ── */
    if (moveAngle !== null && world && rapier) {
      moveAngle = findClearDirection(world, rapier, rayOrigin, moveAngle, OBSTACLE_LOOKAHEAD, myRigidBodyHandle);
    }

    /* ── Smooth rotation ── */
    const targetAngle = lookAngle ?? moveAngle;
    if (targetAngle !== null && character.current) {
      let cur = character.current.rotation.y;
      let diff = targetAngle - cur;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      character.current.rotation.y = cur + diff * Math.min(1, 10 * delta);
    }

    /* ── Animation ── */
    setAnimation(
      stateLabel === "Run"
        ? "Run"
        : stateLabel === "Idle_Shoot"
          ? "Idle_Shoot"
          : "Idle"
    );

    /* ── Apply movement impulse ── */
    if (moveAngle !== null) {
      rigidbody.current.wakeUp();
      rigidbody.current.applyImpulse({
        x: Math.sin(moveAngle) * moveSpeed,
        y: 0,
        z: Math.cos(moveAngle) * moveSpeed,
      });
    }

    /* ── Keep inside map: if out of bounds, respawn at a valid spawn; else clamp to edge ── */
    let pos = rigidbody.current.translation();
    const outOfBounds =
      pos.x < MAP_BOUNDS.minX ||
      pos.x > MAP_BOUNDS.maxX ||
      pos.z < MAP_BOUNDS.minZ ||
      pos.z > MAP_BOUNDS.maxZ;

    if (outOfBounds && isHost()) {
      const fn = spawnFnRef.current ?? getEmptySpawnPosition;
      const newPos = fn(null);
      if (newPos) {
        rigidbody.current.setTranslation({
          x: newPos.x ?? 0,
          y: newPos.y ?? 0,
          z: newPos.z ?? 0,
        });
        rigidbody.current.setLinvel({ x: 0, y: 0, z: 0 });
      } else {
        rigidbody.current.setTranslation({
          x: MAP_BOUNDS.minX + Math.random() * (MAP_BOUNDS.maxX - MAP_BOUNDS.minX),
          y: pos.y,
          z: MAP_BOUNDS.minZ + Math.random() * (MAP_BOUNDS.maxZ - MAP_BOUNDS.minZ),
        });
        rigidbody.current.setLinvel({ x: 0, y: 0, z: 0 });
      }
      wanderAngleRef.current = Math.random() * Math.PI * 2;
      wanderChangeTimeRef.current = now;
      pos = rigidbody.current.translation();
    } else {
      const cx = Math.max(MAP_BOUNDS.minX, Math.min(MAP_BOUNDS.maxX, pos.x));
      const cz = Math.max(MAP_BOUNDS.minZ, Math.min(MAP_BOUNDS.maxZ, pos.z));
      if (cx !== pos.x || cz !== pos.z) {
        rigidbody.current.setTranslation({ x: cx, y: pos.y, z: cz });
        wanderAngleRef.current = Math.random() * Math.PI * 2;
        wanderChangeTimeRef.current = now;
        pos = rigidbody.current.translation();
      }
    }

    /* ── Broadcast own state so all bots share awareness ── */
    if (isHost()) {
      state.setState("pos", { x: Number(pos.x), y: Number(pos.y), z: Number(pos.z) });
      state.setState("weapon", weapon);
      state.setState("ammo", ammo);
    } else {
      const netPos = state.getState("pos");
      if (netPos) rigidbody.current.setTranslation(netPos);
    }
  });

  /* ── Render ── */
  return (
    <group ref={group} userData={{ botId: state.id }} {...props}>
      <RigidBody
        key={bodyKey}
        ref={rigidbody}
        position={spawnPos}
        colliders={false}
        linearDamping={12}
        lockRotations
        type={isHost() ? "dynamic" : "kinematicPosition"}
        onIntersectionEnter={({ other }) => {
          if (!isHost()) return;
          const ud = other.rigidBody.userData;

          if (
            ud?.type === "weapon_pickup" &&
            state.state.health > 0 &&
            !state.state.dead
          ) {
            const { pickupId, weaponType } = ud;
            const stats = WEAPON_STATS[weaponType];
            if (stats && !stats.isMelee) {
              state.setState("weapon", weaponType);
              state.setState("ammo", stats.ammo);
              onWeaponPickup?.(pickupId);
            }
            return;
          }

          if (
            ud?.type === "bullet" &&
            state.state.health > 0 &&
            !state.state.dead
          ) {
            const damage = ud.damage ?? 10;
            state.setState("lastDamageTime", Date.now());
            const newHealth = state.state.health - damage;
            if (newHealth <= 0) {
              const aliveSince = state.getState("aliveSince") ?? Date.now();
              state.setState(
                "survivalTime",
                (state.getState("survivalTime") ?? 0) + (Date.now() - aliveSince) / 1000
              );
              state.setState("dead", true);
              state.setState("deaths", (state.state.deaths || 0) + 1);
              state.setState("health", 0);
              const lives = (state.state.lives ?? LIVES_PER_BOT) - 1;
              state.setState("lives", lives);
              if (lives <= 0) state.setState("eliminated", true);
              onKilled(state.id, ud.player);
            } else {
              state.setState("health", newHealth);
            }
          }
        }}
        userData={{ type: "player" }}
      >
        <BotInfo state={state.state} />
        <group ref={character} scale={[1.984, 1.984, 1.984]}>
          <CharacterPlayer
            animation={animation}
            character={state.getState("character")}
            weapon={state.getState("weapon") ?? "knife"}
            bloom
          />
        </group>
        <CapsuleCollider args={[0.7, 0.66]} position={[0, 1.28, 0]} />
      </RigidBody>
    </group>
  );
};

/* ── Bot info billboard (above-head HUD) ── */
const BotInfo = ({ state }) => {
  const health = state.health ?? 100;
  const name = state.profile?.name ?? state.name ?? "Bot";
  const weapon = state.weapon ?? "knife";
  const ammo = state.ammo;
  const lives = state.lives ?? 3;
  return (
    <Billboard position-y={2.5}>
      <Text position-y={0.36} fontSize={0.4}>
        {name} {weapon !== "knife" ? `(${ammo})` : ""} [Lives: {lives}]
        <meshBasicMaterial color={state.profile?.color ?? "#888"} />
      </Text>
      <mesh position-z={-0.1}>
        <planeGeometry args={[1, 0.2]} />
        <meshBasicMaterial color="black" transparent opacity={0.5} />
      </mesh>
      <mesh scale-x={health / 100} position-x={-0.5 * (1 - health / 100)}>
        <planeGeometry args={[1, 0.2]} />
        <meshBasicMaterial color="red" />
      </mesh>
    </Billboard>
  );
};
