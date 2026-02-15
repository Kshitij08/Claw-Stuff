import { useGLTF } from "@react-three/drei";
import { useEffect, useMemo } from "react";
import { RigidBody } from "@react-three/rapier";
import { Box3, Vector3 } from "three";

const MAP_PATH = "models/map.glb";

/** Play area width (X/Z) so we scale the arena to match. Must match weapons.js MAP_BOUNDS. */
const PLAY_AREA_SIZE = 90; // MAP_BOUNDS.maxX - MAP_BOUNDS.minX

export const Map = () => {
  const mapScene = useGLTF(MAP_PATH);

  useEffect(() => {
    mapScene.scene.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
  });

  /* Scale map so its mesh size matches the play area (MAP_BOUNDS). */
  const mapScale = useMemo(() => {
    mapScene.scene.updateMatrixWorld(true);
    const box = new Box3().setFromObject(mapScene.scene);
    const size = box.getSize(new Vector3());
    const span = Math.max(size.x, size.z, 0.001);
    const scale = PLAY_AREA_SIZE / span;
    console.log("[Map] map.glb bbox span:", span.toFixed(1), "→ scale:", scale.toFixed(3));
    return scale;
  }, [mapScene.scene]);

  return (
    <RigidBody
      colliders="trimesh"
      type="fixed"
      scale={mapScale}
      userData={{
        type: "map",
      }}
    >
      <primitive object={mapScene.scene} />
    </RigidBody>
  );
};
useGLTF.preload(MAP_PATH);
