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
import { useEffect, useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { Vector3 } from "three";
import { CharacterPlayer } from "./CharacterPlayer";
import { WeaponPickup } from "./WeaponPickup";
import { BotClickCapture } from "./BotClickCapture";
import { useGameManager } from "./GameManager";
import { Billboard, Text } from "@react-three/drei";

const BG_MUSIC_URL = "/claw-shooter/sounds/bg music.mp3";

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
const DEBUG_COLLIDERS = true;
/** Extra Y offset: character is drawn this many units below server capsule center. */
const CHARACTER_Y_EXTRA_OFFSET = 1.75;
/** Debug capsule: 50% longer than server capsule. */
const DEBUG_CAPSULE_LENGTH_SCALE = 1.5;
/** Debug capsule: move center down by 32.5% of its height. */
const DEBUG_CAPSULE_Y_DOWN = (CAPSULE_HALF_HEIGHT * 2) * 0.325;
/** Extra downward offset applied to both character and debug capsule. */
const CHARACTER_AND_CAPSULE_DOWN_EXTRA = 0.15;
/** Scale factor for character and debug capsule (0.5 = 50%). */
const CHARACTER_AND_CAPSULE_SCALE = 1;

/** Determine animation state from server player data. */
function getAnimation(player, isMoving) {
  if (!player.alive) return "Death";
  if (isMoving) return "Run";
  return "Idle";
}

/** Single server-driven player character. */
function ServerPlayer({ player, prevPosRef }) {
  const groupRef = useRef();

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

  const centerY = player.y ?? 0;
  const feetY = centerY - FEET_OFFSET - CHARACTER_Y_EXTRA_OFFSET - CHARACTER_AND_CAPSULE_DOWN_EXTRA;
  const targetPos = useRef(new Vector3(player.x, feetY, player.z));
  targetPos.current.set(player.x, feetY, player.z);

  useFrame((_, delta) => {
    if (!groupRef.current) return;
    const pos = groupRef.current.position;
    pos.lerp(targetPos.current, Math.min(1, 15 * delta));

    // Rotate to face movement direction
    const rad = ((player.angle ?? 0) * Math.PI) / 180;
    // Model faces +Z by default, angle 0 = +X, so rotate Y = -(angle) + 90deg
    const targetRotY = -rad + Math.PI / 2;
    groupRef.current.rotation.y += (targetRotY - groupRef.current.rotation.y) * Math.min(1, 10 * delta);
  });

  const animation = getAnimation(player, isMoving);
  const character = player.character || "G_1";

  // Hide eliminated players completely
  if (player.eliminated) return null;

  return (
    <group ref={groupRef} position={[player.x, feetY, player.z]}>
      {/* Character model; offset up so capsule center is at (x, centerY, z) */}
      <group position={[0, FEET_OFFSET, 0]} scale={2 * CHARACTER_AND_CAPSULE_SCALE}>
        <CharacterPlayer
          character={character}
          animation={animation}
          weapon={player.weapon || "knife"}
        />
      </group>
      {/* Name + health billboard (above character) */}
      {player.alive && (
        <Billboard position={[0, FEET_OFFSET + 3.8, 0]}>
          <Text
            fontSize={0.45}
            color="white"
            outlineWidth={0.05}
            outlineColor="black"
            anchorY="bottom"
          >
            {player.name}
          </Text>
          {/* Health bar */}
          <mesh position={[0, -0.2, 0]}>
            <planeGeometry args={[1.6, 0.16]} />
            <meshBasicMaterial color="#333" transparent opacity={0.7} />
          </mesh>
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
    </group>
  );
}

export const Experience = ({ downgradedPerformance = false }) => {
  const { gameState, shots, gamePhase } = useGameManager();
  const bgMusicRef = useRef(null);
  const prevPosRefs = useRef(new Map());

  // Background music
  useEffect(() => {
    const audio = new Audio(BG_MUSIC_URL);
    audio.loop = true;
    audio.volume = 0.5;
    bgMusicRef.current = audio;
    audio.play().catch(() => {});
    return () => {
      audio.pause();
      bgMusicRef.current = null;
    };
  }, []);

  const players = gameState?.players ?? [];
  const pickups = gameState?.pickups ?? [];
  const bullets = gameState?.bullets ?? [];
  const mapBounds = useMapBounds();
  const spawnPoints = useSpawnPoints();

  for (const p of players) {
    if (!prevPosRefs.current.has(p.id)) {
      prevPosRefs.current.set(p.id, { current: { x: p.x, z: p.z } });
    }
  }

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

      {/* Physical bullet objects (small spheres) */}
      {bullets.map((b) => (
        <mesh key={b.id} position={[b.x, b.y, b.z]}>
          <sphereGeometry args={[BULLET_RADIUS * 2, 8, 6]} />
          <meshBasicMaterial color="#ffff00" />
        </mesh>
      ))}

      {/* Player characters */}
      {players.map((player) => (
        <ServerPlayer
          key={player.id}
          player={player}
          prevPosRef={prevPosRefs.current.get(player.id)}
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

      {/* Hit trail effects (when a shot hits) */}
      {shots.map((shot) => {
        const bulletY = (players.length > 0 ? (players[0].y ?? 0) : 0) + 1.5;
        return (
          <BulletTrail
            key={shot._id}
            fromX={shot.fromX}
            fromZ={shot.fromZ}
            toX={shot.toX}
            toZ={shot.toZ}
            hit={shot.hit}
            trailY={bulletY}
          />
        );
      })}

      <Environment preset="sunset" />
    </>
  );
};

/** Simple bullet trail as a thin line that fades. */
function BulletTrail({ fromX, fromZ, toX, toZ, hit, trailY = 1.2 }) {
  const ref = useRef();
  const opacityRef = useRef(1);

  useFrame((_, delta) => {
    if (!ref.current) return;
    opacityRef.current = Math.max(0, opacityRef.current - delta * 4);
    ref.current.material.opacity = opacityRef.current;
    if (opacityRef.current <= 0) {
      ref.current.visible = false;
    }
  });

  return (
    <line ref={ref}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          count={2}
          array={new Float32Array([fromX, trailY, fromZ, toX, trailY, toZ])}
          itemSize={3}
        />
      </bufferGeometry>
      <lineBasicMaterial
        color={hit ? "#ff4444" : "#ffff00"}
        transparent
        opacity={1}
        linewidth={2}
      />
    </line>
  );
}
