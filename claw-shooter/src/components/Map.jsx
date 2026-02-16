import { useGLTF } from "@react-three/drei";
import { Component, useEffect, useMemo } from "react";
import { RigidBody } from "@react-three/rapier";
import { Box3, Vector3 } from "three";

/** Error boundary: if Map fails to load (e.g. map4.glb 404), render Map with fallback path. */
class MapErrorBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return <Map path={MAP_FALLBACK} />;
    }
    return this.props.children;
  }
}

const BASE = import.meta.env.BASE_URL;
const MAP_PRIMARY = `${BASE}map4.glb`;
const MAP_FALLBACK = `${BASE}map.glb`;

/** Play area width (X/Z) so we scale the arena to match. Must match weapons.js MAP_BOUNDS. */
const PLAY_AREA_SIZE = 90; // MAP_BOUNDS.maxX - MAP_BOUNDS.minX

/** @param {{ path?: string }} props - path: optional override (e.g. fallback when map4.glb 404s) */
export const Map = ({ path: pathOverride }) => {
  const path = pathOverride ?? MAP_PRIMARY;
  const mapScene = useGLTF(path);

  useEffect(() => {
    mapScene.scene.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
  });

  /* Scale map to play area and compute position so map center is at world (0,0,0). */
  const { scale: mapScale, position: mapPosition } = useMemo(() => {
    mapScene.scene.updateMatrixWorld(true);
    const box = new Box3().setFromObject(mapScene.scene);
    const center = box.getCenter(new Vector3());
    const size = box.getSize(new Vector3());
    const span = Math.max(size.x, size.z, 0.001);
    const scale = PLAY_AREA_SIZE / span;
    const position = new Vector3(-center.x * scale, -center.y * scale, -center.z * scale);
    console.log("[Map]", path.split("/").pop(), "bbox span:", span.toFixed(1), "→ scale:", scale.toFixed(3), "center offset:", position.toArray().map((n) => n.toFixed(1)));
    return { scale, position: [position.x, position.y, position.z] };
  }, [mapScene.scene, path]);

  return (
    <RigidBody
      colliders="trimesh"
      type="fixed"
      position={mapPosition}
      scale={mapScale}
      userData={{
        type: "map",
      }}
    >
      <primitive object={mapScene.scene} />
    </RigidBody>
  );
};
useGLTF.preload(MAP_PRIMARY);
useGLTF.preload(MAP_FALLBACK);

/** Map that tries map4.glb first and falls back to map.glb if the primary fails to load. */
export const MapWithFallback = () => (
  <MapErrorBoundary>
    <Map />
  </MapErrorBoundary>
);
