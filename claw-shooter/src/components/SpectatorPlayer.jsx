import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Vector3 } from "three";
import { CharacterPlayer } from "./CharacterPlayer";
import { MAP_BOUNDS } from "../constants/weapons";

/** Units per second (matches server MOVEMENT_SPEED * 1000). Used for dead reckoning. */
const CLIENT_MOVEMENT_SPEED = 12;
/** Lerp factor per second when correcting toward server position. */
const CORRECTION_LERP = 5;
const SPECTATOR_FLOOR_OFFSET = 0.8;

/**
 * Dead reckoning + smooth correction: between server updates we advance position at
 * movementSpeed in the known angle direction; when new server data arrives we smoothly
 * correct toward it. Matches the fluid feel of Playroom physics.
 */
export function SpectatorPlayer({ player, mapFloorY, matchTick = 0, movementSpeed = CLIENT_MOVEMENT_SPEED }) {
  const groupRef = useRef(null);
  const floorY = typeof mapFloorY === "number" && !Number.isNaN(mapFloorY) ? mapFloorY : 0;
  const y = floorY + SPECTATOR_FLOOR_OFFSET;

  const posRef = useRef(new Vector3(
    Math.max(MAP_BOUNDS.minX, Math.min(MAP_BOUNDS.maxX, player.x)),
    y,
    Math.max(MAP_BOUNDS.minZ, Math.min(MAP_BOUNDS.maxZ, player.z))
  ));
  const angleRef = useRef(player.angle ?? 0);
  const lastTickRef = useRef(matchTick);
  const serverAngleRef = useRef(player.angle ?? 0);

  useFrame((_, delta) => {
    if (!groupRef.current) return;

    const serverX = Math.max(MAP_BOUNDS.minX, Math.min(MAP_BOUNDS.maxX, player.x));
    const serverZ = Math.max(MAP_BOUNDS.minZ, Math.min(MAP_BOUNDS.maxZ, player.z));
    const serverAngle = player.angle ?? 0;
    const moving = !!player.moving && !!player.alive;

    const isNewServerState = matchTick !== lastTickRef.current;
    if (isNewServerState) {
      lastTickRef.current = matchTick;
      serverAngleRef.current = serverAngle;
      const dx = serverX - posRef.current.x;
      const dz = serverZ - posRef.current.z;
      const distSq = dx * dx + dz * dz;
      if (distSq > 15 * 15) {
        posRef.current.x = serverX;
        posRef.current.z = serverZ;
      } else {
        const correctionT = Math.min(1, CORRECTION_LERP * delta);
        posRef.current.x += dx * correctionT;
        posRef.current.z += dz * correctionT;
      }
    }

    if (moving && player.alive) {
      const advance = (movementSpeed / 1000) * (delta * 1000);
      posRef.current.x += Math.sin(angleRef.current) * advance;
      posRef.current.z += Math.cos(angleRef.current) * advance;
    }

    posRef.current.x = Math.max(MAP_BOUNDS.minX, Math.min(MAP_BOUNDS.maxX, posRef.current.x));
    posRef.current.z = Math.max(MAP_BOUNDS.minZ, Math.min(MAP_BOUNDS.maxZ, posRef.current.z));
    posRef.current.y = y;

    let da = serverAngleRef.current - angleRef.current;
    if (da > Math.PI) da -= 2 * Math.PI;
    if (da < -Math.PI) da += 2 * Math.PI;
    angleRef.current += da * Math.min(1, 10 * delta);

    groupRef.current.position.copy(posRef.current);
    groupRef.current.rotation.y = angleRef.current;
  });

  const animation = !player.alive ? "Death" : player.moving ? "Run" : "Idle";

  return (
    <group ref={groupRef}>
      <CharacterPlayer
        character={player.characterId && /^G_\d+$/.test(player.characterId) ? player.characterId : "G_1"}
        weapon={player.weapon || "knife"}
        animation={animation}
        position={[0, 0, 0]}
        rotation={[0, 0, 0]}
      />
    </group>
  );
}
