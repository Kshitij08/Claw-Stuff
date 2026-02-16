/**
 * Experience – refactored spectator-only renderer.
 *
 * Reads game state from Socket.IO (via GameManager context) and renders:
 *  - 3D map (visual only, no Rapier physics in client)
 *  - Character models positioned/rotated by server state
 *  - Weapon pickups
 *  - Physical bullets + hit trail effects
 *  - Debug colliders (capsules, spheres, arena bounds)
 *  - Environment lighting
 */

import { Environment } from "@react-three/drei";
import { MapVisual, MapLevelDebugColliders, useMapBounds, useSpawnPoints } from "./Map";
import { useEffect, useRef, useMemo, useState, useCallback } from "react";
import { useFrame } from "@react-three/fiber";
import { Vector3, MeshBasicMaterial } from "three";

/**
 * Bullet color by gun type – hex values matching shooter-blitz weapon stats.
 * These are base colors; for the glowing tracer effect the color is multiplied
 * by a large scalar on a MeshBasicMaterial (toneMapped=false) so it blooms.
 */
const BULLET_COLOR_BY_WEAPON = {
  pistol: 0xffff00,
  smg: 0xff8800,
  shotgun: 0xff0000,
  assault_rifle: 0x00ffff,
  knife: 0x94a3b8,
};

/** CSS-style fallback colors for trails / non-instanced uses. */
const BULLET_TRAIL_COLOR = {
  pistol: "#ffff00",
  smg: "#ff8800",
  shotgun: "#ff0000",
  assault_rifle: "#00ffff",
  knife: "#94a3b8",
};

/** Bullet box size: short tracers, no bloom. Length is along travel direction. */
const BULLET_SIZE_BY_WEAPON = {
  smg: [0.04, 0.04, 0.15],
  default: [0.05, 0.05, 0.2],
};

/** No bloom: use normal color. */
const BULLET_COLOR_MULTIPLIER = 1;

/** Scale so bullets are visible but not larger than characters. */
const BULLET_VISIBLE_SCALE = 1.5;
import { CharacterPlayer } from "./CharacterPlayer";
import { WeaponPickup } from "./WeaponPickup";
import { BotClickCapture } from "./BotClickCapture";
import { BulletHit } from "./BulletHit";
import { useGameManager } from "./GameManager";
import { Billboard, Text } from "@react-three/drei";

// Match server capsule and arena (for debug colliders and grounding)
const CAPSULE_HALF_HEIGHT = 0.7;
const CAPSULE_RADIUS = 0.5;
const FEET_OFFSET = CAPSULE_HALF_HEIGHT + CAPSULE_RADIUS; // 1.2
const PICKUP_RADIUS = 1.5;
const BULLET_RADIUS = 0.08;
const ARENA_MIN_X = -45;
const ARENA_MAX_X = 45;
const ARENA_MIN_Z = -45;
const ARENA_MAX_Z = 45;
const DEBUG_COLLIDERS = false;
/**
 * Extra Y offset: the server now sends the feet-level Y directly
 * (capsule center - halfHeight - radius). We just need a small offset
 * to align the character model's feet to this ground level.
 */
const CHARACTER_Y_EXTRA_OFFSET = 0;
/** Debug capsule: 50% longer than server capsule. */
const DEBUG_CAPSULE_LENGTH_SCALE = 1.5;
/** Debug capsule: move center down by 32.5% of its height. */
const DEBUG_CAPSULE_Y_DOWN = (CAPSULE_HALF_HEIGHT * 2) * 0.325;
/** Extra downward offset applied to both character and debug capsule. */
const CHARACTER_AND_CAPSULE_DOWN_EXTRA = 0;
/** Scale factor for character and debug capsule (0.5 = 50%). */
const CHARACTER_AND_CAPSULE_SCALE = 1;

/** Determine animation state from server player data (aligned with G_1.glb / Character_Soldier clips). */
function getAnimation(player, isMoving, recentlyShot) {
  if (player.alive === false) return "Death";
  if (recentlyShot) return isMoving ? "Run_Shoot" : "Idle_Shoot";
  if (isMoving) return "Run";
  return "Idle";
}

/** Personality badge color for spectator HUD. */
const PERSONALITY_COLORS = {
  Aggressive: "#ef4444",
  Cautious: "#3b82f6",
  Sniper: "#a855f7",
  Rusher: "#f97316",
  Tactician: "#22c55e",
};

/** Single server-driven player character with damage flash and personality display. */
function ServerPlayer({ player, prevPosRef, shots = [], hits = [] }) {
  const groupRef = useRef();
  const damageFlashRef = useRef(0);
  const muzzleFlashTimeRef = useRef(0);
  const damageLightRef = useRef();
  const muzzleLightRef = useRef();
  const prevWasHitRef = useRef(false);

  // Track whether this player is moving (for animation)
  const isMoving = useMemo(() => {
    if (!prevPosRef.current) return false;
    const dx = player.x - (prevPosRef.current.x ?? player.x);
    const dz = player.z - (prevPosRef.current.z ?? player.z);
    return Math.sqrt(dx * dx + dz * dz) > 0.01;
  }, [player.x, player.z, prevPosRef]);

  // Update prevPos after render
  useEffect(() => {
    prevPosRef.current = { x: player.x, z: player.z };
  });

  // Trigger damage flash when this player is hit (effect runs once per hit)
  const wasHit = hits.some((h) => h && h.victimId === player.id);
  if (wasHit && !prevWasHitRef.current) damageFlashRef.current = 0.3;
  prevWasHitRef.current = !!wasHit;

  // Server sends feet-level Y; character model has internal +FEET_OFFSET so it stands on this point
  const feetY = (player.y ?? 0);
  const targetPos = useRef(new Vector3(player.x, feetY, player.z));
  targetPos.current.set(player.x, feetY, player.z);

  useFrame((_, delta) => {
    if (!groupRef.current) return;
    const pos = groupRef.current.position;
    pos.lerp(targetPos.current, Math.min(1, 6 * delta));

    // Rotate to face movement direction
    const rad = ((player.angle ?? 0) * Math.PI) / 180;
    const targetRotY = -rad + Math.PI / 2;
    groupRef.current.rotation.y += (targetRotY - groupRef.current.rotation.y) * Math.min(1, 10 * delta);

    // Fade damage flash
    if (damageFlashRef.current > 0) {
      damageFlashRef.current = Math.max(0, damageFlashRef.current - delta);
    }
    if (damageLightRef.current) {
      damageLightRef.current.intensity = damageFlashRef.current * 15;
    }

    // Muzzle flash: when any shot from this player exists, show brief flash then decay (avoids flicker)
    const hasShot = shots.some((s) => s && s.shooterId === player.id);
    if (hasShot) muzzleFlashTimeRef.current = Math.max(muzzleFlashTimeRef.current, 0.12);
    if (muzzleFlashTimeRef.current > 0) muzzleFlashTimeRef.current = Math.max(0, muzzleFlashTimeRef.current - delta);
    if (muzzleLightRef.current) {
      muzzleLightRef.current.intensity = muzzleFlashTimeRef.current > 0 && player.alive ? 8 : 0;
    }
  });

  const recentlyShot = shots.some((s) => s && s.shooterId === player.id);
  const animation = getAnimation(player, isMoving, recentlyShot);
  const character = player.character || "G_1";
  const personality = player.personality;
  const personalityColor = PERSONALITY_COLORS[personality] || "#888";

  // Weapon info for HUD
  const weaponLabel = player.weapon !== "knife"
    ? ` [${(player.weapon || "").replace("_", " ").toUpperCase()}${player.ammo != null ? `: ${player.ammo}` : ""}]`
    : "";

  return (
    <group
      ref={groupRef}
      position={[player.x, feetY, player.z]}
      userData={{ botId: player.id }}
    >
      {/* Character model */}
      <group position={[0, FEET_OFFSET, 0]} scale={2 * CHARACTER_AND_CAPSULE_SCALE}>
        <CharacterPlayer
          character={character}
          animation={animation}
          weapon={player.weapon || "knife"}
        />
      </group>

      {/* Damage flash: always mounted, intensity updated in useFrame to avoid flicker */}
      <pointLight
        ref={damageLightRef}
        position={[0, FEET_OFFSET + 1, 0]}
        color="#ff0000"
        intensity={0}
        distance={4}
      />

      {/* Muzzle flash: always mounted, intensity updated in useFrame to avoid flicker */}
      <pointLight
        ref={muzzleLightRef}
        position={[0, FEET_OFFSET + 1.5, 0.5]}
        color={BULLET_TRAIL_COLOR[player.weapon] || "#ffff00"}
        intensity={0}
        distance={5}
      />

      {/* Name + weapon + health billboard HUD */}
      {player.alive && (
        <Billboard position={[0, FEET_OFFSET + 3.8, 0]}>
          {/* Name */}
          <Text
            fontSize={0.45}
            color="white"
            outlineWidth={0.05}
            outlineColor="black"
            anchorY="bottom"
          >
            {player.name}
          </Text>
          {/* Personality badge + weapon info */}
          {personality && (
            <Text
              position={[0, 0.55, 0]}
              fontSize={0.25}
              color={personalityColor}
              outlineWidth={0.03}
              outlineColor="black"
              anchorY="bottom"
            >
              {personality}{weaponLabel}
            </Text>
          )}
          {!personality && weaponLabel && (
            <Text
              position={[0, 0.55, 0]}
              fontSize={0.25}
              color="#94a3b8"
              outlineWidth={0.03}
              outlineColor="black"
              anchorY="bottom"
            >
              {weaponLabel}
            </Text>
          )}
          {/* Lives indicator */}
          <Text
            position={[0, -0.42, 0]}
            fontSize={0.2}
            color="#94a3b8"
            outlineWidth={0.02}
            outlineColor="black"
          >
            {"♥".repeat(Math.max(0, player.lives ?? 0))}
          </Text>
          {/* Health bar background */}
          <mesh position={[0, -0.2, 0]}>
            <planeGeometry args={[1.6, 0.16]} />
            <meshBasicMaterial color="#333" transparent opacity={0.7} />
          </mesh>
          {/* Health bar fill */}
          <mesh position={[-(1.6 - (1.6 * (player.health ?? 100)) / 100) / 2, -0.2, 0.001]}>
            <planeGeometry args={[(1.6 * (player.health ?? 100)) / 100, 0.16]} />
            <meshBasicMaterial
              color={
                (player.health ?? 100) > 60 ? "#22c55e" :
                (player.health ?? 100) > 30 ? "#eab308" : "#ef4444"
              }
            />
          </mesh>
        </Billboard>
      )}

      {/* Death indicator: faded name when eliminated */}
      {!player.alive && player.eliminated && (
        <Billboard position={[0, FEET_OFFSET + 2, 0]}>
          <Text
            fontSize={0.35}
            color="#666"
            outlineWidth={0.03}
            outlineColor="black"
          >
            {player.name} (eliminated)
          </Text>
        </Billboard>
      )}
    </group>
  );
}

/** Cache of MeshBasicMaterial per weapon type so we don't recreate on every frame. */
const bulletMaterialCache = {};
function getBulletMaterial(weapon) {
  if (bulletMaterialCache[weapon]) return bulletMaterialCache[weapon];
  const hex = BULLET_COLOR_BY_WEAPON[weapon] ?? BULLET_COLOR_BY_WEAPON.pistol;
  const mat = new MeshBasicMaterial({ color: hex, toneMapped: true });
  if (BULLET_COLOR_MULTIPLIER !== 1) mat.color.multiplyScalar(BULLET_COLOR_MULTIPLIER);
  bulletMaterialCache[weapon] = mat;
  return mat;
}

/**
 * Single server-driven bullet: only the bullet mesh, no trail.
 */
function ServerBullet({ bullet }) {
  const groupRef = useRef();
  const targetPos = useRef(new Vector3(bullet.x ?? 0, bullet.y ?? 0, bullet.z ?? 0));

  const x = bullet.x ?? 0;
  const y = bullet.y ?? 0;
  const z = bullet.z ?? 0;
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return null;

  const weapon = bullet.weapon || "pistol";
  const material = getBulletMaterial(weapon);
  const size = BULLET_SIZE_BY_WEAPON[weapon] ?? BULLET_SIZE_BY_WEAPON.default;

  targetPos.current.set(x, y, z);

  const dx = x - (bullet.fromX ?? x);
  const dz = z - (bullet.fromZ ?? z);
  const len = Math.sqrt(dx * dx + dz * dz) || 1;
  const angle = Math.atan2(dx / len, dz / len);

  useFrame((_, delta) => {
    if (!groupRef.current) return;
    groupRef.current.position.lerp(targetPos.current, Math.min(1, 25 * delta));
  });

  return (
    <group
      ref={groupRef}
      position={[x, y, z]}
      rotation-y={angle}
      scale={BULLET_VISIBLE_SCALE}
    >
      <mesh position-z={size[2] * 0.5} material={material}>
        <boxGeometry args={size} />
      </mesh>
    </group>
  );
}

const MAX_IMPACT_EFFECTS = 12;
const MAX_SEEN_HIT_IDS = 50;

export const Experience = ({ downgradedPerformance = false }) => {
  const { gameState, shots, hits, gamePhase } = useGameManager();
  const prevPosRefs = useRef(new Map());
  const [impactEffects, setImpactEffects] = useState([]);
  const seenHitIdsRef = useRef(new Set());

  const players = gameState?.players ?? [];
  const pickups = gameState?.pickups ?? [];
  const bullets = gameState?.bullets ?? [];
  const mapBounds = useMapBounds();
  const spawnPoints = useSpawnPoints();

  const bulletY = players.length > 0 ? (players[0].y ?? 0) + 1.5 : 1.5;

  useEffect(() => {
    const hitShots = (shots || []).filter((s) => s && s.hit === true);
    const seen = seenHitIdsRef.current;
    const toAdd = [];
    for (const shot of hitShots) {
      if (!shot._id || seen.has(shot._id)) continue;
      seen.add(shot._id);
      toAdd.push({ id: shot._id, x: shot.toX, y: bulletY, z: shot.toZ, type: "player" });
    }
    while (seen.size > MAX_SEEN_HIT_IDS) {
      const first = seen.values().next().value;
      if (first !== undefined) seen.delete(first);
      else break;
    }
    if (toAdd.length > 0) {
      setImpactEffects((prev) => [...prev, ...toAdd].slice(-MAX_IMPACT_EFFECTS));
    }
  }, [shots, bulletY]);

  const removeImpact = useCallback((id) => {
    setImpactEffects((prev) => prev.filter((e) => e.id !== id));
  }, []);

  for (const p of players) {
    if (!prevPosRefs.current.has(p.id)) {
      prevPosRefs.current.set(p.id, { current: { x: p.x, z: p.z } });
    }
  }

  const isSpectatorMode = spectatorMatchState?.phase === "active" && Array.isArray(spectatorMatchState?.players);

  return (
    <>
      <BotClickCapture />
      <MapVisual />

      {/* Weapon pickups */}
      {pickups.map((p) => (
        <WeaponPickup
          key={p.id}
          id={p.id}
          weaponType={p.type}
          position={new Vector3(p.x, p.y ?? 0.5, p.z)}
          taken={false}
        />
      ))}

      {/* Physical bullets: elongated box tracers + live trail lines from origin */}
      {bullets.map((b) => (
        <ServerBullet key={b.id} bullet={b} />
      ))}

      {/* Player characters */}
      {players.map((player) => (
        <ServerPlayer
          key={player.id}
          player={player}
          prevPosRef={prevPosRefs.current.get(player.id)}
          shots={shots}
          hits={hits}
        />
      ))}

      {/* Debug colliders */}
      {DEBUG_COLLIDERS && (
        <>
          <MapLevelDebugColliders />
          {players.map((p) => (
            <group key={`debug-${p.id}`} position={[p.x, (p.y ?? 0) - DEBUG_CAPSULE_Y_DOWN - CHARACTER_AND_CAPSULE_DOWN_EXTRA, p.z]} scale={CHARACTER_AND_CAPSULE_SCALE}>
              <mesh>
                <cylinderGeometry args={[CAPSULE_RADIUS, CAPSULE_RADIUS, CAPSULE_HALF_HEIGHT * 2 * DEBUG_CAPSULE_LENGTH_SCALE, 12]} />
                <meshBasicMaterial wireframe color="#00ff00" />
              </mesh>
            </group>
          ))}
          {pickups.map((p) => (
            <mesh key={`debug-pickup-${p.id}`} position={[p.x, p.y ?? 0, p.z]}>
              <sphereGeometry args={[PICKUP_RADIUS, 12, 10]} />
              <meshBasicMaterial wireframe color="#00aaff" />
            </mesh>
          ))}
          {bullets.map((b) => (
            <mesh key={`debug-bullet-${b.id}`} position={[b.x, b.y, b.z]}>
              <sphereGeometry args={[BULLET_RADIUS, 6, 4]} />
              <meshBasicMaterial wireframe color="#ffaa00" />
            </mesh>
          ))}
          {/* Spawn point debug cones */}
          {spawnPoints.map((sp, i) => (
            <mesh key={`debug-spawn-${i}`} position={[sp.x, sp.y + 1, sp.z]}>
              <coneGeometry args={[1, 2, 8]} />
              <meshBasicMaterial wireframe color="#ff00ff" />
            </mesh>
          ))}
          <group position={[0, -2.5, 0]}>
            <mesh>
              <boxGeometry args={[mapBounds.worldSizeX || ARENA_MAX_X - ARENA_MIN_X, 15, mapBounds.worldSizeZ || ARENA_MAX_Z - ARENA_MIN_Z]} />
              <meshBasicMaterial wireframe color="#666666" />
            </mesh>
          </group>
        </>
      )}

      {/* Impact effects (shooter-blitz style BulletHit at impact position) */}
      {impactEffects.map((impact) => (
        <BulletHit
          key={impact.id}
          nb={60}
          position={{ x: impact.x, y: impact.y, z: impact.z }}
          type={impact.type}
          onEnded={() => removeImpact(impact.id)}
        />
      ))}

      <Environment preset="sunset" />
    </>
  );
};

