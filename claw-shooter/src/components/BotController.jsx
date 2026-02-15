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
} from "../constants/weapons";
import { useGameManager } from "./GameManager";

/* ── Tuning constants ──────────────────────────────────────────── */
const BASE_MOVEMENT_SPEED = 200;
const MELEE_RANGE = 1.8;
const KNIFE_RUSH_DECISION_RADIUS = 14;
const RESPAWN_DELAY = 3000;
const OCCUPIED_RADIUS = 3;

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
  downgradedPerformance,
  getSpawnPositions,
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

  /* ── Find a random spawn point, excluding the supplied position ── */
  const getEmptySpawnPosition = useCallback(
    (excludePos = null) => {
      const positions = getSpawnPositions?.() ?? [];
      if (!positions.length) return null;

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

      const isFree = (sp) => {
        const v = vec3({ x: sp.x ?? 0, y: sp.y ?? 0, z: sp.z ?? 0 });
        return !occupied.some((o) => v.distanceTo(vec3(o)) < OCCUPIED_RADIUS);
      };

      const emptySpawns = positions.filter(isFree);
      if (emptySpawns.length) {
        return emptySpawns[Math.floor(Math.random() * emptySpawns.length)];
      }

      /* Fallback: any spawn NOT at/near the excluded position */
      if (excludePos) {
        const fallback = positions.filter((sp) => {
          const v = vec3({ x: sp.x ?? 0, y: sp.y ?? 0, z: sp.z ?? 0 });
          return v.distanceTo(vec3(excludePos)) >= OCCUPIED_RADIUS;
        });
        if (fallback.length) {
          return fallback[Math.floor(Math.random() * fallback.length)];
        }
        /* Even with no fallback, never return a position at death spot */
        const away = positions.filter((sp) => {
          const v = vec3({ x: sp.x ?? 0, y: sp.y ?? 0, z: sp.z ?? 0 });
          return v.distanceTo(vec3(excludePos)) > 0.5;
        });
        if (away.length) {
          return away[Math.floor(Math.random() * away.length)];
        }
      }

      /* Last resort: random spawn, but never use excludePos if we have it */
      if (excludePos) {
        const notDeath = positions.filter((sp) => {
          const v = vec3({ x: sp.x ?? 0, y: sp.y ?? 0, z: sp.z ?? 0 });
          return v.distanceTo(vec3(excludePos)) >= OCCUPIED_RADIUS;
        });
        if (notDeath.length) {
          return notDeath[Math.floor(Math.random() * notDeath.length)];
        }
      }
      return positions[Math.floor(Math.random() * positions.length)];
    },
    [getSpawnPositions, players, state.id]
  );

  /* Keep ref in sync so setTimeout closures always use the latest version */
  useEffect(() => {
    spawnFnRef.current = getEmptySpawnPosition;
  }, [getEmptySpawnPosition]);

  const spawnAtPosition = useCallback((pos) => {
    if (!pos || !rigidbody.current) return;
    rigidbody.current.setTranslation({
      x: pos.x ?? 0,
      y: pos.y ?? 0,
      z: pos.z ?? 0,
    });
    rigidbody.current.setLinvel({ x: 0, y: 0, z: 0 });
  }, []);

  /* ── Initial spawn ── */
  useEffect(() => {
    if (!isHost()) return;
    const t = setTimeout(() => {
      const positions = getSpawnPositions?.() ?? [];
      if (positions.length && rigidbody.current) {
        spawnAtPosition(positions[spawnIndex % positions.length]);
      }
    }, 100);
    return () => clearTimeout(t);
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

    /* Capture death position BEFORE disabling physics */
    const t = rigidbody.current?.translation();
    const deathPos = t ? { x: t.x, y: t.y, z: t.z } : null;
    if (rigidbody.current) rigidbody.current.setEnabled(false);

    const timer = setTimeout(() => {
      if (state.state.eliminated) return;

      /* Use the ref to always get the latest spawn function; exclude death position so we never respawn there */
      const fn = spawnFnRef.current ?? getEmptySpawnPosition;
      const pos = fn(deathPos) ?? fn(null);

      /* Re-enable body FIRST so setTranslation is applied (Rapier ignores it when disabled) */
      if (rigidbody.current) rigidbody.current.setEnabled(true);
      if (pos) spawnAtPosition(pos);

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

    /* Auto-switch to knife when ammo is depleted */
    if (weapon !== WEAPON_TYPES.KNIFE && (ammo == null || ammo <= 0)) {
      state.setState("weapon", WEAPON_TYPES.KNIFE);
      state.setState("ammo", null);
      weapon = WEAPON_TYPES.KNIFE;
      ammo = null;
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
          state.setState("ammo", Math.max(0, ammo - 1));
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

    /* ── Clamp to map bounds ── */
    let pos = rigidbody.current.translation();
    const cx = Math.max(MAP_BOUNDS.minX, Math.min(MAP_BOUNDS.maxX, pos.x));
    const cz = Math.max(MAP_BOUNDS.minZ, Math.min(MAP_BOUNDS.maxZ, pos.z));
    if (cx !== pos.x || cz !== pos.z) {
      rigidbody.current.setTranslation({ x: cx, y: pos.y, z: cz });
      /* Randomize wander direction when hitting a boundary */
      wanderAngleRef.current = Math.random() * Math.PI * 2;
      wanderChangeTimeRef.current = now;
      pos = rigidbody.current.translation();
    }

    /* ── Broadcast own state so all bots share awareness ── */
    if (isHost()) {
      state.setState("pos", pos);
      state.setState("weapon", weapon);
      state.setState("ammo", ammo);
    } else {
      const netPos = state.getState("pos");
      if (netPos) rigidbody.current.setTranslation(netPos);
    }
  });

  /* ── Render ── */
  return (
    <group ref={group} {...props}>
      <RigidBody
        ref={rigidbody}
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
        <group ref={character}>
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
