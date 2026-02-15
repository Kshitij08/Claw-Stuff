import { RigidBody, vec3 } from "@react-three/rapier";
import { useEffect, useRef } from "react";
import { MeshBasicMaterial } from "three";
import { isHost } from "playroomkit";
import { WEAPON_OFFSET } from "./CharacterController";
import { WEAPON_STATS, WEAPON_TYPES } from "../constants/weapons";
import { useGameManager } from "./GameManager";

const DEFAULT_STATS = WEAPON_STATS[WEAPON_TYPES.PISTOL];

export const Bullet = ({
  player,
  angle,
  position,
  onHit,
  weaponType = WEAPON_TYPES.PISTOL,
}) => {
  const rigidbody = useRef();
  const stats = WEAPON_STATS[weaponType] || DEFAULT_STATS;
  const { gamePhase } = useGameManager();
  if (stats.isMelee) return null;

  const speed = stats.speed ?? 20;
  const damage = stats.damage ?? 10;
  const color = stats.color ?? 0xffff00;
  const size = weaponType === "smg" ? [0.03, 0.03, 0.35] : [0.05, 0.05, 0.5];

  const material = useRef(
    new MeshBasicMaterial({
      color,
      toneMapped: false,
    })
  );
  material.current.color.setHex(color);
  material.current.color.multiplyScalar(42);

  useEffect(() => {
    if (gamePhase === "playing") {
      try {
        const audio = new Audio("/sounds/pistol.mp3");
        audio.volume = 0.2;
        audio.play();
      } catch (_) {}
    }

    const velocity = {
      x: Math.sin(angle) * speed,
      y: 0,
      z: Math.cos(angle) * speed,
    };
    if (rigidbody.current) rigidbody.current.setLinvel(velocity, true);
  }, []);

  return (
    <group position={[position.x, position.y, position.z]} rotation-y={angle}>
      <group position={[WEAPON_OFFSET.x, WEAPON_OFFSET.y, WEAPON_OFFSET.z]}>
        <RigidBody
          ref={rigidbody}
          gravityScale={0}
          sensor
          onIntersectionEnter={(e) => {
            if (isHost() && e.other.rigidBody.userData?.type !== "bullet") {
              if (rigidbody.current) rigidbody.current.setEnabled(false);
              onHit(
                vec3(rigidbody.current.translation()),
                e.other.rigidBody.userData.type
              );
            }
          }}
          userData={{
            type: "bullet",
            player,
            damage,
          }}
        >
          <mesh position-z={0.25} material={material.current} castShadow>
            <boxGeometry args={size} />
          </mesh>
        </RigidBody>
      </group>
    </group>
  );
};
