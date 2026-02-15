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

const BASE_MOVEMENT_SPEED = 200;
const DETECT_RADIUS = 12;
const MELEE_RANGE = 1.8;
const KNIFE_RUSH_DECISION_RADIUS = 14;
const COVER_FLEE_SPEED_MULT = 1.2;
const RESPAWN_DELAY = 3000; // 3 seconds
const OCCUPIED_RADIUS = 3; // spawn point is "occupied" if a player is within this distance

const PERSONALITY_MODS = {
  Aggressive: {
    detectRadius: 14,
    engageRadius: 5,
    speedMult: 1.15,
    fleeHealth: 15,
    takeCover: 0.1,
  },
  Cautious: {
    detectRadius: 7,
    engageRadius: 11,
    speedMult: 0.9,
    fleeHealth: 55,
    takeCover: 0.8,
  },
  Sniper: {
    detectRadius: 13,
    engageRadius: 14,
    speedMult: 0.95,
    fleeHealth: 40,
    takeCover: 0.5,
  },
  Rusher: {
    detectRadius: 10,
    engageRadius: 4,
    speedMult: 1.35,
    fleeHealth: 25,
    takeCover: 0.2,
  },
  Tactician: {
    detectRadius: 11,
    engageRadius: 8,
    speedMult: 1.0,
    fleeHealth: 35,
    takeCover: 0.6,
  },
};

export class PlayerBot extends Bot {
  constructor(botParams) {
    super(botParams);
  }

  getNearestEnemy(players, myId, myPos) {
    if (!myPos) return { player: null, distance: Infinity, angle: 0 };
    let nearest = null;
    let minDist = Infinity;
    let angle = 0;
    for (const p of players) {
      if (p.id === myId || !p.state?.pos) continue;
      if (p.state.eliminated || p.state.dead || (p.state.lives !== undefined && p.state.lives <= 0)) continue;
      const pos = p.state.pos;
      const d = vec3(myPos).distanceTo(vec3(pos));
      if (d < minDist) {
        minDist = d;
        nearest = p;
        angle = -Math.atan2(pos.z - myPos.z, pos.x - myPos.x) + Math.PI / 2;
      }
    }
    return { player: nearest, distance: minDist, angle };
  }

  getNearestPickup(pickups, myPos) {
    if (!myPos || !pickups.length) return { pickup: null, distance: Infinity, position: null };
    let nearest = null;
    let minDist = Infinity;
    let position = null;
    for (const p of pickups) {
      if (p.taken) continue;
      const pos = p.position;
      const d = vec3(myPos).distanceTo(vec3(pos.x, pos.y, pos.z));
      if (d < minDist) {
        minDist = d;
        nearest = p;
        position = pos;
      }
    }
    return { pickup: nearest, distance: minDist, position };
  }

  getMoveAngleToward(targetPos, myPos) {
    if (!targetPos || !myPos) return 0;
    return -Math.atan2(targetPos.z - myPos.z, targetPos.x - myPos.x) + Math.PI / 2;
  }

  getMoveAngleAwayFrom(threatPos, myPos) {
    if (!threatPos || !myPos) return 0;
    return -Math.atan2(myPos.z - threatPos.z, myPos.x - threatPos.x) + Math.PI / 2;
  }
}

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
  const wanderAngleRef = useRef(Math.random() * Math.PI * 2);
  const wanderChangeTimeRef = useRef(0);
  const players = usePlayersList(true);
  const { weaponPickups, gamePhase } = useGameManager();
  const [animation, setAnimation] = useState("Idle");

  const scene = useThree((s) => s.scene);
  const bot = state.bot;

  /**
   * Find a random spawn point that is not occupied by any other alive bot.
   * Falls back to any random spawn if all are occupied.
   */
  const getEmptySpawnPosition = useCallback(() => {
    const positions = getSpawnPositions?.() ?? [];
    if (!positions.length) return null;

    // Only consider other bots (not the human spectator) when checking occupancy
    const aliveBotPositions = [];
    for (const p of players) {
      if (!p.state?.isBot?.()) continue;
      if (!p.state?.pos) continue;
      if (p.state.eliminated || (p.state.lives !== undefined && p.state.lives <= 0)) continue;
      if (p.state.dead) continue;
      if (p.id === state.id) continue; // skip self
      aliveBotPositions.push(p.state.pos);
    }

    const emptySpawns = positions.filter((sp) => {
      const spVec = vec3({ x: sp.x ?? 0, y: sp.y ?? 0, z: sp.z ?? 0 });
      return !aliveBotPositions.some((ap) => spVec.distanceTo(vec3(ap)) < OCCUPIED_RADIUS);
    });

    const pool = emptySpawns.length > 0 ? emptySpawns : positions;
    return pool[Math.floor(Math.random() * pool.length)];
  }, [getSpawnPositions, players, state.id]);

  const spawnAtPosition = useCallback((pos) => {
    if (!pos || !rigidbody.current) return;
    rigidbody.current.setTranslation({ x: pos.x ?? 0, y: pos.y ?? 0, z: pos.z ?? 0 });
  }, []);

  const spawnRandomly = useCallback((useRandom = true) => {
    const positions = getSpawnPositions?.() ?? [];
    if (positions.length && rigidbody.current) {
      if (useRandom) {
        const pos = getEmptySpawnPosition();
        if (pos) spawnAtPosition(pos);
      } else {
        const pos = positions[spawnIndex % positions.length];
        spawnAtPosition(pos);
      }
    }
  }, [getSpawnPositions, spawnIndex, getEmptySpawnPosition, spawnAtPosition]);

  /* Initial spawn */
  useEffect(() => {
    if (!isHost()) return;
    const t = setTimeout(() => spawnRandomly(false), 100);
    return () => clearTimeout(t);
  }, []);

  /* Death -> respawn after 3 seconds at empty spawn */
  useEffect(() => {
    if (state.state.dead) {
      if (gamePhase === "playing") {
        try {
          const audio = new Audio("/sounds/death.mp3");
          audio.volume = 0.5;
          audio.play();
        } catch (_) {}
      }
      if (rigidbody.current) rigidbody.current.setEnabled(false);
      const timer = setTimeout(() => {
        if (state.state.eliminated) return;
        spawnRandomly(true); // random empty spawn
        state.setState("dead", false);
        state.setState("health", HEALTH_PER_LIFE);
        state.setState("weapon", WEAPON_TYPES.KNIFE);
        state.setState("ammo", null);
        if (rigidbody.current) rigidbody.current.setEnabled(true);
      }, RESPAWN_DELAY);
      return () => clearTimeout(timer);
    }
  }, [state.state.dead]);

  useFrame((_, delta) => {
    if (!rigidbody.current || !bot) return;

    /* Bots idle in lobby / countdown phases */
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

    if (weapon !== WEAPON_TYPES.KNIFE && (ammo === undefined || ammo === 0)) {
      state.setState("weapon", WEAPON_TYPES.KNIFE);
      state.setState("ammo", null);
      weapon = WEAPON_TYPES.KNIFE;
    }

    const enemy = bot.getNearestEnemy(players, state.id, myPos);
    const pickup = bot.getNearestPickup(weaponPickups, myPos);
    const detectRadius = mods.detectRadius;
    const engageRadius = mods.engageRadius;
    const speedMult = mods.speedMult;
    const health = state.state.health ?? 100;
    const fleeHealth = mods.fleeHealth;
    const lastDamageTime = state.getState("lastDamageTime") || 0;
    const recentlyHurt = Date.now() - lastDamageTime < 1200;

    const moveSpeed = BASE_MOVEMENT_SPEED * speedMult * delta;
    let moveAngle = null;
    let lookAngle = null;
    let shouldShoot = false;
    let stateLabel = "Idle";

    /* Wander: pick a new random direction every 1.5–3 seconds instead of every frame */
    const now = Date.now();
    if (now - wanderChangeTimeRef.current > 1500 + Math.random() * 1500) {
      wanderAngleRef.current = Math.random() * Math.PI * 2;
      wanderChangeTimeRef.current = now;
    }
    const wanderAngle = wanderAngleRef.current;

    if (enemy.player && enemy.distance < detectRadius) {
      lookAngle = enemy.angle;
      if (weapon === WEAPON_TYPES.KNIFE) {
        const distToPickup = pickup.pickup ? pickup.distance : Infinity;
        const preferKnifeRush =
          enemy.distance < KNIFE_RUSH_DECISION_RADIUS &&
          (enemy.distance < distToPickup || !pickup.pickup);
        if (preferKnifeRush && enemy.distance <= MELEE_RANGE) {
          if (Date.now() - lastMelee.current > KNIFE.fireRate) {
            lastMelee.current = Date.now();
            onMeleeHit?.(enemy.player.id, state.id, KNIFE.damage);
          }
          stateLabel = "Idle_Shoot";
        } else if (preferKnifeRush) {
          moveAngle = enemy.angle;
          stateLabel = "Run";
        } else {
          if (pickup.pickup && pickup.position) {
            moveAngle = bot.getMoveAngleToward(
              { x: pickup.position.x, z: pickup.position.z },
              myPos
            );
            stateLabel = "Run";
          }
        }
      } else {
        if (health <= fleeHealth || recentlyHurt) {
          moveAngle = bot.getMoveAngleAwayFrom(enemy.player.state.pos, myPos);
          moveAngle += (Math.random() - 0.5) * 0.5;
          stateLabel = "Run";
        } else if (enemy.distance <= engageRadius) {
          lookAngle = enemy.angle;
          shouldShoot = true;
          const stats = WEAPON_STATS[weapon];
          if (stats && !stats.isMelee && (state.getState("ammo") ?? 0) > 0) {
            if (Date.now() - lastShoot.current > stats.fireRate) {
              lastShoot.current = Date.now();
              const spread = stats.spread ?? 0.02;
              const pellets = stats.pellets ?? 1;
              for (let i = 0; i < pellets; i++) {
                const a = enemy.angle + (Math.random() - 0.5) * spread * 2;
                onFire({
                  id: `${state.id}-${Date.now()}-${i}-${Math.random()}`,
                  position: vec3(myPos),
                  angle: a,
                  player: state.id,
                  weaponType: weapon,
                });
              }
              const newAmmo = Math.max(0, (state.getState("ammo") ?? 0) - 1);
              state.setState("ammo", newAmmo);
            }
          }
          stateLabel = stats?.isMelee ? "Idle" : "Idle_Shoot";
        } else {
          moveAngle = enemy.angle;
          stateLabel = "Run";
        }
      }
    } else {
      if (weapon === WEAPON_TYPES.KNIFE && pickup.pickup && pickup.position) {
        moveAngle = bot.getMoveAngleToward(
          { x: pickup.position.x, z: pickup.position.z },
          myPos
        );
        stateLabel = "Run";
      } else if (weapon !== WEAPON_TYPES.KNIFE) {
        if (enemy.player && enemy.distance < detectRadius + 5) {
          moveAngle = enemy.angle;
          stateLabel = "Run";
        } else {
          moveAngle = wanderAngle;
          stateLabel = "Run";
        }
      } else {
        moveAngle = wanderAngle;
        stateLabel = "Run";
      }
    }

    /* Smoothly interpolate rotation so bots don't snap/spin */
    const targetAngle = lookAngle ?? moveAngle;
    if (targetAngle !== null && character.current) {
      let current = character.current.rotation.y;
      let diff = targetAngle - current;
      diff = ((diff + Math.PI) % (Math.PI * 2)) - Math.PI;
      if (diff < -Math.PI) diff += Math.PI * 2;
      character.current.rotation.y = current + diff * Math.min(1, 10 * delta);
    }

    setAnimation(stateLabel === "Run" ? "Run" : stateLabel === "Idle_Shoot" ? "Idle_Shoot" : "Idle");

    if (moveAngle !== null) {
      const impulse = {
        x: Math.sin(moveAngle) * moveSpeed,
        y: 0,
        z: Math.cos(moveAngle) * moveSpeed,
      };
      rigidbody.current.wakeUp();
      rigidbody.current.applyImpulse(impulse);
    }

    /* Keep bot inside map bounds */
    let pos = rigidbody.current.translation();
    const x = Math.max(MAP_BOUNDS.minX, Math.min(MAP_BOUNDS.maxX, pos.x));
    const z = Math.max(MAP_BOUNDS.minZ, Math.min(MAP_BOUNDS.maxZ, pos.z));
    if (x !== pos.x || z !== pos.z) {
      rigidbody.current.setTranslation({ x, y: pos.y, z });
      pos = rigidbody.current.translation();
    }

    if (isHost()) {
      state.setState("pos", pos);
    } else {
      const netPos = state.getState("pos");
      if (netPos) rigidbody.current.setTranslation(netPos);
    }
  });

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
          if (ud?.type === "weapon_pickup" && state.state.health > 0 && !state.state.dead) {
            const { pickupId, weaponType } = ud;
            const stats = WEAPON_STATS[weaponType];
            if (stats && !stats.isMelee) {
              state.setState("weapon", weaponType);
              state.setState("ammo", stats.ammo);
              onWeaponPickup?.(pickupId);
            }
            return;
          }

          if (ud?.type === "bullet" && state.state.health > 0 && !state.state.dead) {
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
          />
        </group>
        <CapsuleCollider args={[0.7, 0.66]} position={[0, 1.28, 0]} />
      </RigidBody>
    </group>
  );
};

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
