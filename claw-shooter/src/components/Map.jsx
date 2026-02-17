/**
 * Map – visual-only renderer (no client-side Rapier physics).
 *
 * Physics runs on the server; this just renders the GLB visually.
 * Applies the same scale/center transform as before so positions match the server.
 * MapLevelDebugColliders renders the same geometry as wireframe for debug.
 */

import { useGLTF } from "@react-three/drei";
import { Component, useEffect, useMemo } from "react";
import { Box3, Vector3 } from "three";
import * as THREE from "three";

/** World-space horizontal size of the map (same scale/center as MapVisual). Use for arena debug box. */
export function useMapBounds(pathOverride) {
  const path = pathOverride ?? MAP_PRIMARY;
  const mapScene = useGLTF(path);
  return useMemo(() => {
    const scene = mapScene.scene;
    scene.updateMatrixWorld(true);
    const box = new Box3().setFromObject(scene);
    const center = box.getCenter(new Vector3());
    const size = box.getSize(new Vector3());
    const span = Math.max(size.x, size.z, 0.001);
    const scale = PLAY_AREA_SIZE / span;
    const worldSizeX = scale * size.x;
    const worldSizeZ = scale * size.z;
    return { worldSizeX, worldSizeZ };
  }, [mapScene.scene, path]);
}

class MapErrorBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return <MapVisualInner path={MAP_FALLBACK} />;
    }
    return this.props.children;
  }
}

const BASE = import.meta.env.BASE_URL;
const MAP_PRIMARY = `${BASE}map4.glb`;
const MAP_FALLBACK = `${BASE}map.glb`;

const PLAY_AREA_SIZE = 90;

export const MapVisualInner = ({ path: pathOverride, onReady }) => {
  const path = pathOverride ?? MAP_PRIMARY;
  const mapScene = useGLTF(path);

  useEffect(() => {
    mapScene.scene.traverse((child) => {
      if (child.isMesh) {
        child.visible = true;
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
  });

  const { scale: mapScale, position: mapPosition, floorY } = useMemo(() => {
    mapScene.scene.updateMatrixWorld(true);
    const box = new Box3().setFromObject(mapScene.scene);
    const center = box.getCenter(new Vector3());
    const size = box.getSize(new Vector3());
    const span = Math.max(size.x, size.z, 0.001);
    const scale = PLAY_AREA_SIZE / span;
    const position = new Vector3(-center.x * scale, -center.y * scale, -center.z * scale);
    const floorY = position.y - (size.y * 0.5 * scale);
    return { scale, position: [position.x, position.y, position.z], floorY };
  }, [mapScene.scene, path]);

  useEffect(() => {
    onReady?.({ floorY });
  }, [floorY, onReady]);

  return (
    <group position={mapPosition} scale={mapScale}>
      <primitive object={mapScene.scene} />
    </group>
  );
};
useGLTF.preload(MAP_PRIMARY);
useGLTF.preload(MAP_FALLBACK);

export const MapVisual = () => (
  <MapErrorBoundary>
    <MapVisualInner />
  </MapErrorBoundary>
);

/**
 * Extract spawn point positions from the GLB scene.
 * Uses a clone of the scene so positions are in model space (not affected by the map group).
 * Then applies the same scale/offset as the server (from mesh-only bounding box).
 * Collects nodes named exactly player_spawn_1 through player_spawn_10 (case-insensitive).
 */
export function useSpawnPoints(pathOverride) {
  const path = pathOverride ?? MAP_PRIMARY;
  const mapScene = useGLTF(path);

  return useMemo(() => {
    const scene = mapScene.scene.clone();
    scene.updateMatrixWorld(true);

    // Build bounding box from mesh geometry only (match server: scale/offset from mesh verts)
    const box = new Box3();
    scene.traverse((node) => {
      if (node.isMesh && node.geometry) {
        node.geometry.computeBoundingBox();
        const childBox = node.geometry.boundingBox.clone();
        childBox.applyMatrix4(node.matrixWorld);
        box.union(childBox);
      }
    });

    const center = box.getCenter(new Vector3());
    const size = box.getSize(new Vector3());
    const span = Math.max(size.x, size.z, 0.001);
    const scale = PLAY_AREA_SIZE / span;
    const offsetX = -center.x * scale;
    const offsetY = -center.y * scale;
    const offsetZ = -center.z * scale;

    // Get spawn positions from clone (scene-local = model space, same as server's raw positions)
    const points = [];
    const worldPos = new Vector3();
    scene.traverse((node) => {
      const name = (node.name || "").toLowerCase();
      if (/^player_spawn_(1|2|3|4|5|6|7|8|9|10)$/.test(name)) {
        node.getWorldPosition(worldPos);
        points.push({
          x: worldPos.x * scale + offsetX,
          y: worldPos.y * scale + offsetY,
          z: worldPos.z * scale + offsetZ,
        });
      }
    });

    return points;
  }, [mapScene.scene, path]);
}

/** Wireframe overlay of the full level mesh (same as server trimesh collider). */
export function MapLevelDebugColliders({ path: pathOverride }) {
  const path = pathOverride ?? MAP_PRIMARY;
  const mapScene = useGLTF(path);

  const { group, position, scale } = useMemo(() => {
    const scene = mapScene.scene.clone();
    scene.traverse((child) => {
      if (child.isMesh) {
        const wire = new THREE.Mesh(child.geometry, new THREE.MeshBasicMaterial({
          wireframe: true,
          color: 0x4444ff,
        }));
        wire.matrix.copy(child.matrix);
        wire.matrixAutoUpdate = false;
        child.parent.add(wire);
        child.visible = false;
      }
    });
    scene.updateMatrixWorld(true);
    const box = new Box3().setFromObject(scene);
    const center = box.getCenter(new Vector3());
    const size = box.getSize(new Vector3());
    const span = Math.max(size.x, size.z, 0.001);
    const s = PLAY_AREA_SIZE / span;
    const pos = new Vector3(-center.x * s, -center.y * s, -center.z * s);
    return {
      group: scene,
      position: [pos.x, pos.y, pos.z],
      scale: s,
    };
  }, [mapScene.scene, path]);

  return (
    <group position={position} scale={scale}>
      <primitive object={group} />
    </group>
  );
}
