import { useGLTF } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { CuboidCollider, RigidBody } from "@react-three/rapier";
import { Text } from "@react-three/drei";
import { useEffect, useMemo, useRef } from "react";
import { WEAPON_STATS } from "../constants/weapons";

const BASE = import.meta.env.BASE_URL;

/** Filenames match public/claw-shooter: Pistol.glb, Smg.glb, Shotgun.glb, Rifle.glb (capital first letter) */
const WEAPON_MODEL = {
  pistol: `${BASE}Pistol.glb`,
  smg: `${BASE}Smg.glb`,
  shotgun: `${BASE}Shotgun.glb`,
  assault_rifle: `${BASE}Rifle.glb`,
};

const LABELS = {
  pistol: "Pistol",
  smg: "SMG",
  shotgun: "Shotgun",
  assault_rifle: "Assault Rifle",
};

const PICKUP_SCALE = 4;
const PICKUP_HEIGHT = 0.5;

export function WeaponPickup({ id, weaponType, position, taken }) {
  if (taken) return null;

  const stats = WEAPON_STATS[weaponType];
  if (!stats || stats.isMelee) return null;

  const modelPath = WEAPON_MODEL[weaponType];
  if (!modelPath) return null;

  const color = stats.color ?? 0xffff00;
  const label = LABELS[weaponType] || weaponType;

  const gltf = useGLTF(modelPath);
  const sceneClone = useMemo(() => gltf.scene.clone(true), [gltf.scene]);
  const coneRef = useRef(null);

  useFrame(() => {
    if (coneRef.current) {
      const t = (Date.now() / 1000) * Math.PI * 0.8;
      const s = 1 + 0.25 * Math.sin(t);
      coneRef.current.scale.setScalar(s);
    }
  });

  useEffect(() => {
    sceneClone.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
  }, [sceneClone]);

  return (
    <group position={[position.x, position.y, position.z]}>
      <RigidBody
        type="fixed"
        sensor
        colliders={false}
        userData={{
          type: "weapon_pickup",
          pickupId: id,
          weaponType,
        }}
      >
        <CuboidCollider args={[0.5, 0.5, 0.5]} position={[0, PICKUP_HEIGHT, 0]} sensor />
        <group position={[0, PICKUP_HEIGHT, 0]} scale={PICKUP_SCALE}>
          <primitive object={sceneClone} />
        </group>
        <group ref={coneRef} position={[0, 3.2, 0]}>
          <mesh rotation={[Math.PI, 0, 0]}>
            <coneGeometry args={[0.6, 1.2, 16]} />
            <meshStandardMaterial
              color={color}
              emissive={color}
              emissiveIntensity={0.9}
              transparent
              opacity={0.85}
              toneMapped={false}
            />
          </mesh>
        </group>
        <Text
          position={[0, 4, 0]}
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

Object.keys(WEAPON_MODEL).forEach((type) => {
  useGLTF.preload(WEAPON_MODEL[type]);
});
