import { useCallback, useEffect, useRef, useState } from "react";
import { CharacterPlayer } from "./CharacterPlayer";
import { CapsuleCollider, RigidBody, vec3 } from "@react-three/rapier";
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
} from "../constants/weapons";
import { useGameManager } from "./GameManager";

/* ── Tuning constants ──────────────────────────────────────────── */
const BASE_MOVEMENT_SPEED = 200;
const MELEE_RANGE = 1.8;
const KNIFE_RUSH_DECISION_RADIUS = 14;
const RESPAWN_DELAY = 3000;
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
const STRAFE_CHANGE_INTERVAL = 1200;
const WANDER_CHANGE_MIN = 1500;
const WANDER_CHANGE_MAX = 3000;
const LOW_AMMO_THRESHOLD = 5;

/* ── Personality definitions ───────────────────────────────────── *
 *  detectRadius  – how far the bot "sees" enemies
 *  preferredDist – ideal combat distance (controls positioning, not shooting)
 *  speedMult     – movement speed multiplier
 *  fleeHealth    – HP threshold below which the bot retreats
 *  accuracy      – 0-1, tighter bullet spread for higher values
 */
const PERSONALITY_MODS = {
  Aggressive: {
    detectRadius: 16,
    preferredDist: 6,
    speedMult: 1.15,
    fleeHealth: 15,
    accuracy: 0.85,
  },
  Cautious: {
    detectRadius: 14,
    preferredDist: 12,
    speedMult: 0.9,
    fleeHealth: 55,
    accuracy: 0.7,
  },
  Sniper: {
    detectRadius: 20,
    preferredDist: 15,
    speedMult: 0.95,
    fleeHealth: 40,
    accuracy: 0.92,
  },
  Rusher: {
    detectRadius: 12,
    preferredDist: 4,
    speedMult: 1.35,
    fleeHealth: 25,
    accuracy: 0.65,
  },
  Tactician: {
    detectRadius: 15,
    preferredDist: 9,
    speedMult: 1.0,
    fleeHealth: 35,
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

  /* Wander */
  const wanderAngleRef = useRef(Math.random() * Math.PI * 2);
  const wanderChangeTimeRef = useRef(0);

  /* Strafe */
  const strafeDirRef = useRef(Math.random() > 0.5 ? 1 : -1);
  const strafeChangeTimeRef = useRef(0);

  /* Stuck detection */
  const lastStuckCheckRef = useRef(0);
  const lastStuckPosRef = useRef(null);
  const stuckAccumRef = useRef(0);
  const recoveryRef = useRef({ active: false, angle: 0, until: 0 });
  const lastMoveAngleRef = useRef(0);

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
        const audio = new Audio("/sounds/death.mp3");
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

      /* Reset stuck detection on respawn */
      stuckAccumRef.current = 0;
      recoveryRef.current = { active: false, angle: 0, until: 0 };
      lastStuckPosRef.current = null;
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

    /* ── World awareness (broadcast data from all bots & pickups) ── */
    const allEnemies = bot.getAllEnemies(players, state.id, myPos);
    const nearest = allEnemies[0] || null;
    const allPickups = bot.getAllPickups(weaponPickups, myPos);
    const nearestPickup = allPickups[0] || null;

    /* ── Stuck detection ── */
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

      /* Activate recovery when stuck long enough */
      if (
        stuckAccumRef.current >= STUCK_TIME_THRESHOLD &&
        !recoveryRef.current.active
      ) {
        const base = lastMoveAngleRef.current;
        const dir = Math.random() > 0.5 ? 1 : -1;
        recoveryRef.current = {
          active: true,
          angle:
            base + (Math.PI / 2 + (Math.random() - 0.5) * 0.8) * dir,
          until: now + STUCK_RECOVERY_DURATION,
        };
        stuckAccumRef.current = 0;
      }
    }

    if (recoveryRef.current.active && now > recoveryRef.current.until) {
      recoveryRef.current.active = false;
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

    /* ═══════════════════ DECISION TREE ═══════════════════ */

    if (hasGun && enemyDetected) {
      /* ── GUN COMBAT: shoot as soon as enemy is in detection range ── */
      lookAngle = nearest.angle;

      /* Fire weapon */
      if (weaponStats && !weaponStats.isMelee && ammo > 0) {
        if (now - lastShoot.current > weaponStats.fireRate) {
          lastShoot.current = now;
          const spread = weaponStats.spread ?? 0.02;
          const pellets = weaponStats.pellets ?? 1;
          const effSpread = spread * (2 - accuracy);
          for (let i = 0; i < pellets; i++) {
            const a =
              nearest.angle + (Math.random() - 0.5) * effSpread * 2;
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

      /* Movement during gun combat */
      if (health <= fleeHealth || (recentlyHurt && health < fleeHealth * 1.5)) {
        /* FLEE – bias toward nearest pickup if roughly in flee direction */
        let fleeAngle = bot.getMoveAngleAwayFrom(nearest.pos, myPos);
        if (nearestPickup) {
          const pAngle = nearestPickup.angle;
          let diff = pAngle - fleeAngle;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          if (Math.abs(diff) < Math.PI / 3) {
            fleeAngle = fleeAngle * 0.6 + pAngle * 0.4;
          }
        }
        moveAngle = fleeAngle + (Math.random() - 0.5) * 0.5;
        stateLabel = "Run";
      } else if (nearest.distance < preferredDist * 0.5) {
        /* Too close – back off while strafing */
        const away = bot.getMoveAngleAwayFrom(nearest.pos, myPos);
        moveAngle = away + strafeDirRef.current * 0.4;
        stateLabel = "Run";
      } else if (nearest.distance > preferredDist * 1.3) {
        /* Too far – close in */
        moveAngle = nearest.angle;
        stateLabel = "Run";
      } else {
        /* Sweet spot – circle strafe */
        moveAngle =
          nearest.angle + (Math.PI / 2) * strafeDirRef.current;
        stateLabel = "Idle_Shoot";
      }
    } else if (!hasGun && enemyDetected) {
      /* ── KNIFE COMBAT / SEEK WEAPON ── */
      const pickupDist = nearestPickup ? nearestPickup.distance : Infinity;

      if (nearestPickup && pickupDist < nearest.distance * 0.8) {
        /* Pickup is closer than enemy → grab weapon first */
        moveAngle = nearestPickup.angle;
        lookAngle = nearestPickup.angle;
        stateLabel = "Run";
      } else if (nearest.distance <= MELEE_RANGE) {
        /* In melee range → slash */
        lookAngle = nearest.angle;
        if (now - lastMelee.current > KNIFE.fireRate) {
          lastMelee.current = now;
          onMeleeHit?.(nearest.player.id, state.id, KNIFE.damage);
        }
        stateLabel = "Idle_Shoot";
      } else if (nearest.distance < KNIFE_RUSH_DECISION_RADIUS) {
        /* Rush with knife */
        moveAngle = nearest.angle;
        lookAngle = nearest.angle;
        stateLabel = "Run";
      } else if (nearestPickup) {
        /* Enemy far – go get a weapon instead */
        moveAngle = nearestPickup.angle;
        lookAngle = nearestPickup.angle;
        stateLabel = "Run";
      } else {
        /* No pickup available, close in with knife */
        moveAngle = nearest.angle;
        lookAngle = nearest.angle;
        stateLabel = "Run";
      }
    } else if (!hasGun && pickupAvailable) {
      /* ── SEEK WEAPON (no enemy nearby) ── */
      moveAngle = nearestPickup.angle;
      stateLabel = "Run";
    } else if (
      hasGun &&
      ammo != null &&
      ammo <= LOW_AMMO_THRESHOLD &&
      pickupAvailable
    ) {
      /* ── LOW AMMO – seek new weapon ── */
      moveAngle = nearestPickup.angle;
      stateLabel = "Run";
    } else if (nearest && nearest.distance < detectRadius + 8) {
      /* ── Enemy just outside detection – patrol toward ── */
      moveAngle = nearest.angle;
      stateLabel = "Run";
    } else {
      /* ── WANDER / PATROL ── */
      moveAngle = wanderAngleRef.current;
      stateLabel = "Run";
    }

    /* ── Override movement if stuck-recovery is active ── */
    if (recoveryRef.current.active) {
      moveAngle = recoveryRef.current.angle;
      stateLabel = "Run";
    }

    /* Track last intended direction for stuck recovery */
    if (moveAngle !== null) lastMoveAngleRef.current = moveAngle;

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
        <group ref={character} scale={[1.5, 1.5, 1.5]}>
          <CharacterPlayer
            animation={animation}
            character={state.getState("character")}
            weapon={state.getState("weapon") ?? "knife"}
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
