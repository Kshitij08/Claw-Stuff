/**
 * GLB-to-Rapier loader.
 *
 * Parses map4.glb at startup, extracts mesh geometry, and creates Rapier
 * trimesh colliders with the same scale/offset that the client Map.jsx uses
 * (scale so the largest XZ span equals ARENA_SIZE, then centre at origin).
 */

import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Document, NodeIO } from '@gltf-transform/core';
import type RAPIER from '@dimforge/rapier3d-compat';
import { ARENA_SIZE } from '../../shared/shooter-constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Resolve path to the GLB file inside public/claw-shooter/ */
function resolveMapPath(filename: string): string {
  return join(__dirname, '../../../public/claw-shooter', filename);
}

export interface SpawnPoint {
  x: number;
  y: number;
  z: number;
}

export interface MapGeometry {
  /** All triangle vertices (flattened x,y,z) already in world coords */
  vertices: Float32Array;
  /** Triangle index triples */
  indices: Uint32Array;
  /** Spawn points found in the GLB (player_spawn_* or spawn_* nodes) */
  spawnPoints: SpawnPoint[];
  /** Uniform scale applied to the model */
  scale: number;
  /** Translation offset applied after scaling (to centre at origin) */
  offset: { x: number; y: number; z: number };
}

/**
 * Parse a GLB file and extract all mesh geometry + spawn markers.
 * Applies the same transform as Map.jsx: uniform scale so the largest
 * XZ span == ARENA_SIZE, then translate so centre is at world origin.
 */
export async function loadMapGeometry(filename = 'map4.glb'): Promise<MapGeometry> {
  const path = resolveMapPath(filename);
  const buffer = await readFile(path);
  const io = new NodeIO();
  const doc: Document = await io.readBinary(new Uint8Array(buffer));

  const root = doc.getRoot();

  // ── Collect all mesh primitives ──────────────────────────────────
  const allVertices: number[] = [];
  const allIndices: number[] = [];
  let vertexOffset = 0;

  // We need to walk the scene graph to get world transforms
  const scenes = root.listScenes();
  const scene = scenes[0];
  if (!scene) throw new Error('GLB has no scene');

  // Compute bounding box first to determine scale + offset
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  // Recursive function to collect mesh geometry with accumulated transform
  function collectGeometry(
    node: ReturnType<typeof root.listNodes>[number],
    parentTransform: number[],
  ) {
    // Get this node's local transform
    const localMatrix = node.getMatrix();
    const worldMatrix = multiplyMat4(parentTransform, localMatrix);

    const mesh = node.getMesh();
    if (mesh) {
      for (const prim of mesh.listPrimitives()) {
        const posAccessor = prim.getAttribute('POSITION');
        if (!posAccessor) continue;

        const posArray = posAccessor.getArray();
        if (!posArray) continue;

        const idxAccessor = prim.getIndices();

        // Transform vertices to world space
        const baseOffset = vertexOffset;
        for (let i = 0; i < posArray.length; i += 3) {
          const [wx, wy, wz] = transformPoint(
            worldMatrix,
            posArray[i],
            posArray[i + 1],
            posArray[i + 2],
          );
          allVertices.push(wx, wy, wz);

          if (wx < minX) minX = wx;
          if (wx > maxX) maxX = wx;
          if (wy < minY) minY = wy;
          if (wy > maxY) maxY = wy;
          if (wz < minZ) minZ = wz;
          if (wz > maxZ) maxZ = wz;

          vertexOffset++;
        }

        if (idxAccessor) {
          const idxArray = idxAccessor.getArray();
          if (idxArray) {
            for (let i = 0; i < idxArray.length; i++) {
              allIndices.push(idxArray[i] + baseOffset);
            }
          }
        } else {
          // Non-indexed: generate sequential indices
          const count = posArray.length / 3;
          for (let i = 0; i < count; i++) {
            allIndices.push(baseOffset + i);
          }
        }
      }
    }

    for (const child of node.listChildren()) {
      collectGeometry(child, worldMatrix);
    }
  }

  // Collect spawn points
  const spawnPointsRaw: SpawnPoint[] = [];

  function collectSpawnPoints(
    node: ReturnType<typeof root.listNodes>[number],
    parentTransform: number[],
  ) {
    const localMatrix = node.getMatrix();
    const worldMatrix = multiplyMat4(parentTransform, localMatrix);

    const name = node.getName() || '';
    if (/^(player_spawn_|spawn_)\d+$/i.test(name)) {
      const [wx, wy, wz] = transformPoint(worldMatrix, 0, 0, 0);
      spawnPointsRaw.push({ x: wx, y: wy, z: wz });
    }

    for (const child of node.listChildren()) {
      collectSpawnPoints(child, worldMatrix);
    }
  }

  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  for (const node of scene.listChildren()) {
    collectGeometry(node, identity);
    collectSpawnPoints(node, identity);
  }

  if (allVertices.length === 0) {
    throw new Error('GLB contains no mesh geometry');
  }

  // ── Compute scale + offset (same logic as Map.jsx) ───────────────
  const sizeX = maxX - minX;
  const sizeY = maxY - minY;
  const sizeZ = maxZ - minZ;
  const span = Math.max(sizeX, sizeZ, 0.001);
  const scale = ARENA_SIZE / span;

  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const offset = {
    x: -centerX * scale,
    y: -centerY * scale,
    z: -centerZ * scale,
  };

  // ── Apply scale + offset to all vertices ─────────────────────────
  const vertices = new Float32Array(allVertices.length);
  for (let i = 0; i < allVertices.length; i += 3) {
    vertices[i] = allVertices[i] * scale + offset.x;
    vertices[i + 1] = allVertices[i + 1] * scale + offset.y;
    vertices[i + 2] = allVertices[i + 2] * scale + offset.z;
  }

  // Apply to spawn points too
  const spawnPoints: SpawnPoint[] = spawnPointsRaw.map((p) => ({
    x: p.x * scale + offset.x,
    y: p.y * scale + offset.y,
    z: p.z * scale + offset.z,
  }));

  const indices = new Uint32Array(allIndices);

  console.log(
    `[GLB Loader] ${filename}: ${vertices.length / 3} verts, ${indices.length / 3} tris, ${spawnPoints.length} spawns, scale=${scale.toFixed(3)}`,
  );

  return { vertices, indices, spawnPoints, scale, offset };
}

/**
 * Create Rapier trimesh collider from loaded map geometry.
 */
export function createMapCollider(
  rapier: typeof RAPIER,
  world: RAPIER.World,
  geo: MapGeometry,
): RAPIER.Collider {
  const bodyDesc = rapier.RigidBodyDesc.fixed();
  const body = world.createRigidBody(bodyDesc);

  const colliderDesc = rapier.ColliderDesc.trimesh(geo.vertices, geo.indices);
  return world.createCollider(colliderDesc, body);
}

// ── Matrix utilities (column-major 4x4) ────────────────────────────

function multiplyMat4(a: number[], b: number[]): number[] {
  const out = new Array(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[0 * 4 + row] * b[col * 4 + 0] +
        a[1 * 4 + row] * b[col * 4 + 1] +
        a[2 * 4 + row] * b[col * 4 + 2] +
        a[3 * 4 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

function transformPoint(
  m: number[],
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
  ];
}
