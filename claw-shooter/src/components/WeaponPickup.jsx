import { RigidBody } from "@react-three/rapier";
import { Text } from "@react-three/drei";
import { WEAPON_STATS } from "../constants/weapons";

const LABELS = {
  pistol: "Pistol",
  smg: "SMG",
  shotgun: "Shotgun",
  assault_rifle: "Assault Rifle",
};

export function WeaponPickup({ id, weaponType, position, taken }) {
  if (taken) return null;

  const stats = WEAPON_STATS[weaponType];
  if (!stats || stats.isMelee) return null;

  const color = stats.color ?? 0xffff00;
  const label = LABELS[weaponType] || weaponType;

  return (
    <group position={[position.x, position.y, position.z]}>
      <RigidBody
        type="fixed"
        sensor
        colliders="cuboid"
        userData={{
          type: "weapon_pickup",
          pickupId: id,
          weaponType,
        }}
      >
        <mesh position={[0, 0.5, 0]} castShadow>
          <boxGeometry args={[0.8, 0.8, 0.8]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={0.5}
          />
        </mesh>
        <Text
          position={[0, 1.2, 0]}
          fontSize={0.35}
          anchorX="center"
          anchorY="middle"
          color="white"
        >
          {label}
        </Text>
      </RigidBody>
    </group>
  );
}
