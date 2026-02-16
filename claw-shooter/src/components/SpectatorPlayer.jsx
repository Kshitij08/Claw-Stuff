import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Vector3 } from "three";
import { CharacterPlayer } from "./CharacterPlayer";
import { MAP_BOUNDS } from "../constants/weapons";

const SPECTATOR_LERP = 12;
const SPECTATOR_FLOOR_OFFSET = 0.8;

/**
 * Interpolates position/rotation toward server state each frame.
 * Clamps to MAP_BOUNDS; uses mapFloorY + offset so characters sit on the ground.
 */
export function SpectatorPlayer({ player, mapFloorY }) {
  const groupRef = useRef(null);
  const floorY = typeof mapFloorY === "number" && !Number.isNaN(mapFloorY) ? mapFloorY : 0;
  const y = floorY + SPECTATOR_FLOOR_OFFSET;
  const posRef = useRef(new Vector3(
    Math.max(MAP_BOUNDS.minX, Math.min(MAP_BOUNDS.maxX, player.x)),
    y,
    Math.max(MAP_BOUNDS.minZ, Math.min(MAP_BOUNDS.maxZ, player.z))
  ));
  const angleRef = useRef(player.angle ?? 0);

  useFrame((_, delta) => {
    if (!groupRef.current) return;
    const targetX = Math.max(MAP_BOUNDS.minX, Math.min(MAP_BOUNDS.maxX, player.x));
    const targetZ = Math.max(MAP_BOUNDS.minZ, Math.min(MAP_BOUNDS.maxZ, player.z));
    const targetAngle = player.angle ?? 0;

    const dx = targetX - posRef.current.x;
    const dz = targetZ - posRef.current.z;
    if (dx * dx + dz * dz > 30 * 30) {
      posRef.current.set(targetX, y, targetZ);
      angleRef.current = targetAngle;
    } else {
      const t = Math.min(1, SPECTATOR_LERP * delta);
      posRef.current.x += dx * t;
      posRef.current.y = y;
      posRef.current.z += dz * t;
      posRef.current.x = Math.max(MAP_BOUNDS.minX, Math.min(MAP_BOUNDS.maxX, posRef.current.x));
      posRef.current.z = Math.max(MAP_BOUNDS.minZ, Math.min(MAP_BOUNDS.maxZ, posRef.current.z));

      let da = targetAngle - angleRef.current;
      if (da > Math.PI) da -= 2 * Math.PI;
      if (da < -Math.PI) da += 2 * Math.PI;
      angleRef.current += da * t;
    }

    groupRef.current.position.copy(posRef.current);
    groupRef.current.rotation.y = angleRef.current;
  });

  return (
    <group ref={groupRef}>
      <CharacterPlayer
        character={player.characterId && /^G_\d+$/.test(player.characterId) ? player.characterId : "G_1"}
        weapon={player.weapon || "knife"}
        animation={player.alive ? "Idle" : "Death"}
        position={[0, 0, 0]}
        rotation={[0, 0, 0]}
      />
    </group>
  );
}
