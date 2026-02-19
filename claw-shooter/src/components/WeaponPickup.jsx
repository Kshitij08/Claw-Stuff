/**
 * WeaponPickup – visual-only renderer (no client-side Rapier).
 * Pickup logic is handled server-side.
 */

import { useGLTF } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { Text } from "@react-three/drei";
import { useEffect, useMemo, useRef } from "react";

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

const WEAPON_COLORS = {
  pistol: 0xffff00,
  smg: 0xff8800,
  shotgun: 0xff0000,
  assault_rifle: 0x00ffff,
};

/** Base scale for pickup visuals; collider size is defined by PICKUP_RADIUS in Experience. */
const PICKUP_SCALE = 3;
/** Visual scale multiplier (1.5 = 50% larger than PICKUP_SCALE); collider unchanged. */
const PICKUP_VISUAL_SCALE = PICKUP_SCALE * 1.5;
const PICKUP_HEIGHT = 0.3;

export function WeaponPickup({ id, weaponType, position, taken }) {
  const modelPath = WEAPON_MODEL[weaponType];
  const fallbackPath = WEAPON_MODEL.pistol;

  const color = WEAPON_COLORS[weaponType] ?? 0xffff00;
  const label = LABELS[weaponType] || weaponType;

  const gltf = useGLTF(modelPath || fallbackPath);
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

  if (taken || !modelPath) return null;

  const px = position?.x ?? 0;
  const py = position?.y ?? 0;
  const pz = position?.z ?? 0;

  return (
    <group position={[px, py, pz]}>
      <group position={[0, PICKUP_HEIGHT, 0]} scale={PICKUP_VISUAL_SCALE}>
        <primitive object={sceneClone} />
      </group>
      {/* Glowing cone indicator */}
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
    </group>
  );
}

Object.keys(WEAPON_MODEL).forEach((type) => {
  useGLTF.preload(WEAPON_MODEL[type]);
});
