/**
 * Server-side Rapier3D physics world for the shooter game.
 * Loads the map GLB at startup, creates trimesh colliders for buildings,
 * and uses KinematicCharacterController for proper obstacle collision.
 */

import RAPIER from '@dimforge/rapier3d-compat';
import { NodeIO } from '@gltf-transform/core';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  ARENA_SIZE,
  ARENA_MIN_X,
  ARENA_MAX_X,
  ARENA_MIN_Z,
  ARENA_MAX_Z,
  PLAYER_CAPSULE_RADIUS,
  PLAYER_CAPSULE_HALF_HEIGHT,
  TICK_INTERVAL_MS,
} from '../../shared/shooter-constants.js';

// Map paths relative to project root (physics loads GLB for colliders)
const MAP_GLB_PRIMARY = 'public/claw-shooter/map4.glb';
const MAP_GLB_FALLBACK = 'public/claw-shooter/map.glb';
const PLAY_AREA_SIZE = ARENA_SIZE;
const MAP_BOUNDS = { minX: ARENA_MIN_X, maxX: ARENA_MAX_X, minZ: ARENA_MIN_Z, maxZ: ARENA_MAX_Z };
const PLAYER_COLLISION_RADIUS = PLAYER_CAPSULE_RADIUS;

export interface BuildingBBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

interface PlayerPhysicsData {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
}

export class ShooterPhysics {
  private world: RAPIER.World | null = null;
  private characterController: RAPIER.KinematicCharacterController | null = null;
  private playerData: Map<string, PlayerPhysicsData> = new Map();
  private buildingBBoxes: BuildingBBox[] = [];
  private initialized = false;
  private debugCounter = 0;

  async init(): Promise<void> {
    if (this.initialized) return;

    await RAPIER.init();
    console.log('[ShooterPhysics] Rapier WASM initialized');

    // No gravity (top-down game)
    this.world = new RAPIER.World({ x: 0, y: 0, z: 0 });

    // Create character controller with a small offset to prevent tunneling
    this.characterController = this.world.createCharacterController(0.1);
    // Don't snap to ground (top-down game, no gravity)
    this.characterController.enableSnapToGround(0);
    // Allow sliding along walls
    this.characterController.setSlideEnabled(true);
    // Max slope doesn't matter for top-down but set a reasonable value
    this.characterController.setMaxSlopeClimbAngle(Math.PI / 4);
    // Autostep over small ledges (e.g. curbs)
    this.characterController.enableAutostep(0.5, 0.2, true);

    // Load map and create trimesh colliders
    await this.loadMapColliders();

    // Create arena boundary walls
    this.createArenaWalls();

    this.initialized = true;
    console.log('[ShooterPhysics] Physics world ready (using KinematicCharacterController)');
  }

  isReady(): boolean {
    return this.initialized && this.world !== null && this.characterController !== null;
  }

  getBuildingBBoxes(): BuildingBBox[] {
    return this.buildingBBoxes;
  }

  /**
   * Load map4.glb (or fallback map.glb), extract mesh geometry,
   * apply the same scaling the client uses, and create Rapier trimesh colliders.
   */
  private async loadMapColliders(): Promise<void> {
    if (!this.world) return;

    // Use process.cwd() (project root) for reliable path resolution on all platforms
    const projectRoot = process.cwd();
    const primaryPath = join(projectRoot, MAP_GLB_PRIMARY);
    const fallbackPath = join(projectRoot, MAP_GLB_FALLBACK);

    console.log(`[ShooterPhysics] Looking for map at: ${primaryPath}`);

    let glbPath: string;
    if (existsSync(primaryPath)) {
      glbPath = primaryPath;
    } else if (existsSync(fallbackPath)) {
      glbPath = fallbackPath;
      console.warn(`[ShooterPhysics] Primary map not found, using fallback: ${fallbackPath}`);
    } else {
      console.error('[ShooterPhysics] No map GLB found! Physics will have no building collision.');
      return;
    }

    console.log(`[ShooterPhysics] Loading map: ${glbPath}`);

    try {
      const io = new NodeIO();
      const document = await io.read(glbPath);
      const root = document.getRoot();
      const scenes = root.listScenes();
      if (scenes.length === 0) {
        console.warn('[ShooterPhysics] GLB has no scenes');
        return;
      }

      // Collect all mesh primitives with node world transforms applied
      let globalMinX = Infinity, globalMaxX = -Infinity;
      let globalMinY = Infinity, globalMaxY = -Infinity;
      let globalMinZ = Infinity, globalMaxZ = -Infinity;

      // Helper: apply 4x4 matrix (column-major) to a vec3
      function transformPoint(m: number[], x: number, y: number, z: number): [number, number, number] {
        return [
          m[0] * x + m[4] * y + m[8] * z + m[12],
          m[1] * x + m[5] * y + m[9] * z + m[13],
          m[2] * x + m[6] * y + m[10] * z + m[14],
        ];
      }

      // First pass: read all mesh primitives, apply node world transform to vertices, compute global bbox
      const meshDataList: Array<{ vertices: Float32Array; indices: Uint32Array | Uint16Array | null }> = [];

      for (const scene of scenes) {
        scene.traverse((node) => {
          const mesh = node.getMesh();
          if (!mesh) return;

          // Get the 4x4 world matrix for this node (includes all parent transforms)
          const worldMat = node.getWorldMatrix();

          for (const prim of mesh.listPrimitives()) {
            const posAccessor = prim.getAttribute('POSITION');
            if (!posAccessor) continue;

            const rawPositions = posAccessor.getArray();
            const indexAccessor = prim.getIndices();
            const indices = indexAccessor ? indexAccessor.getArray() : null;

            if (!rawPositions || rawPositions.length < 3) continue;

            // Apply node world transform to all vertices
            const worldPositions = new Float32Array(rawPositions.length);
            for (let i = 0; i < rawPositions.length; i += 3) {
              const [wx, wy, wz] = transformPoint(
                worldMat as unknown as number[],
                rawPositions[i], rawPositions[i + 1], rawPositions[i + 2]
              );
              worldPositions[i] = wx;
              worldPositions[i + 1] = wy;
              worldPositions[i + 2] = wz;

              if (wx < globalMinX) globalMinX = wx;
              if (wx > globalMaxX) globalMaxX = wx;
              if (wy < globalMinY) globalMinY = wy;
              if (wy > globalMaxY) globalMaxY = wy;
              if (wz < globalMinZ) globalMinZ = wz;
              if (wz > globalMaxZ) globalMaxZ = wz;
            }

            meshDataList.push({
              vertices: worldPositions,
              indices: indices as Uint32Array | Uint16Array | null,
            });
          }
        });
      }

      if (meshDataList.length === 0) {
        console.warn('[ShooterPhysics] No mesh primitives found in GLB');
        return;
      }

      // Compute scale and offset (mirrors client Map.jsx logic)
      const sizeX = globalMaxX - globalMinX;
      const sizeY = globalMaxY - globalMinY;
      const sizeZ = globalMaxZ - globalMinZ;
      const span = Math.max(sizeX, sizeZ, 0.001);
      const scale = PLAY_AREA_SIZE / span;

      const centerX = (globalMinX + globalMaxX) / 2;
      const centerY = (globalMinY + globalMaxY) / 2;
      const centerZ = (globalMinZ + globalMaxZ) / 2;

      // Offset: -center * scale (so map center is at world origin)
      const offsetX = -centerX * scale;
      const offsetY = -centerY * scale;
      const offsetZ = -centerZ * scale;

      console.log(`[ShooterPhysics] Map bounds: X[${globalMinX.toFixed(1)}..${globalMaxX.toFixed(1)}] Y[${globalMinY.toFixed(1)}..${globalMaxY.toFixed(1)}] Z[${globalMinZ.toFixed(1)}..${globalMaxZ.toFixed(1)}]`);
      console.log(`[ShooterPhysics] Scale: ${scale.toFixed(3)}, offset: (${offsetX.toFixed(1)}, ${offsetY.toFixed(1)}, ${offsetZ.toFixed(1)})`);

      // Second pass: transform vertices and create trimesh colliders (buildings only)
      let totalTriangles = 0;
      let skippedFloor = 0;
      let skippedSmall = 0;
      const buildingBBoxes: BuildingBBox[] = [];

      for (const { vertices: rawVerts, indices: rawIndices } of meshDataList) {
        // Transform vertices to world space
        const transformed = new Float32Array(rawVerts.length);
        let meshMinX = Infinity, meshMaxX = -Infinity;
        let meshMinY = Infinity, meshMaxY = -Infinity;
        let meshMinZ = Infinity, meshMaxZ = -Infinity;

        for (let i = 0; i < rawVerts.length; i += 3) {
          const wx = rawVerts[i] * scale + offsetX;
          const wy = rawVerts[i + 1] * scale + offsetY;
          const wz = rawVerts[i + 2] * scale + offsetZ;
          transformed[i] = wx;
          transformed[i + 1] = wy;
          transformed[i + 2] = wz;

          if (wx < meshMinX) meshMinX = wx;
          if (wx > meshMaxX) meshMaxX = wx;
          if (wy < meshMinY) meshMinY = wy;
          if (wy > meshMaxY) meshMaxY = wy;
          if (wz < meshMinZ) meshMinZ = wz;
          if (wz > meshMaxZ) meshMaxZ = wz;
        }

        // Build indices (generate sequential if not provided)
        let indices32: Uint32Array;
        if (rawIndices) {
          indices32 = new Uint32Array(rawIndices);
        } else {
          const count = Math.floor(rawVerts.length / 3);
          indices32 = new Uint32Array(count);
          for (let i = 0; i < count; i++) indices32[i] = i;
        }

        if (indices32.length < 3) continue;

        // Classify meshes by height to separate floor from buildings
        const meshHeight = meshMaxY - meshMinY;
        const meshWidthX = meshMaxX - meshMinX;
        const meshWidthZ = meshMaxZ - meshMinZ;

        // Floor: very thin, spans most of the arena -- SKIP for collision
        const isFloor = meshHeight < 0.5 && meshWidthX > PLAY_AREA_SIZE * 0.6 && meshWidthZ > PLAY_AREA_SIZE * 0.6;
        if (isFloor) {
          skippedFloor++;
          continue;
        }

        // Skip meshes that are too short (decorations, curbs, etc.)
        if (meshHeight < 2.0) {
          skippedSmall++;
          continue;
        }

        // Skip meshes that are too thin in one XZ dimension (fences, road markings, etc.)
        // A real building should be at least 2 units wide in both X and Z
        if (meshWidthX < 2.0 || meshWidthZ < 2.0) {
          skippedSmall++;
          continue;
        }

        // Skip meshes that span almost the full arena (roads, ground sections)
        if (meshWidthX > PLAY_AREA_SIZE * 0.5 || meshWidthZ > PLAY_AREA_SIZE * 0.5) {
          skippedSmall++;
          continue;
        }

        buildingBBoxes.push({
          minX: meshMinX,
          maxX: meshMaxX,
          minZ: meshMinZ,
          maxZ: meshMaxZ,
        });
        totalTriangles += indices32.length / 3;
      }

      this.buildingBBoxes = buildingBBoxes;

      // Create simple cuboid colliders from bounding boxes
      // Cuboids give clean flat surfaces for character controller sliding
      const playerY = PLAYER_CAPSULE_HALF_HEIGHT + PLAYER_COLLISION_RADIUS;
      const wallHeight = 10;
      for (const bb of buildingBBoxes) {
        const cx = (bb.minX + bb.maxX) / 2;
        const cz = (bb.minZ + bb.maxZ) / 2;
        const hx = (bb.maxX - bb.minX) / 2;
        const hz = (bb.maxZ - bb.minZ) / 2;
        const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(cx, playerY, cz);
        const body = this.world.createRigidBody(bodyDesc);
        const colliderDesc = RAPIER.ColliderDesc.cuboid(hx, wallHeight / 2, hz);
        this.world.createCollider(colliderDesc, body);
      }

      console.log(`[ShooterPhysics] Created ${buildingBBoxes.length} cuboid building colliders (${totalTriangles} source triangles). Skipped: ${skippedFloor} floor, ${skippedSmall} small. Total meshes: ${meshDataList.length}`);
    } catch (err) {
      console.error('[ShooterPhysics] Failed to load map GLB:', err);
    }
  }

  /** Create invisible wall colliders at the arena boundary */
  private createArenaWalls(): void {
    if (!this.world) return;

    const halfWidth = (MAP_BOUNDS.maxX - MAP_BOUNDS.minX) / 2; // 45
    const halfDepth = (MAP_BOUNDS.maxZ - MAP_BOUNDS.minZ) / 2; // 45
    const wallHeight = 10;
    const wallThickness = 2;

    const walls = [
      // North wall (+Z)
      { x: 0, z: MAP_BOUNDS.maxZ + wallThickness / 2, hx: halfWidth + wallThickness, hz: wallThickness / 2 },
      // South wall (-Z)
      { x: 0, z: MAP_BOUNDS.minZ - wallThickness / 2, hx: halfWidth + wallThickness, hz: wallThickness / 2 },
      // East wall (+X)
      { x: MAP_BOUNDS.maxX + wallThickness / 2, z: 0, hx: wallThickness / 2, hz: halfDepth + wallThickness },
      // West wall (-X)
      { x: MAP_BOUNDS.minX - wallThickness / 2, z: 0, hx: wallThickness / 2, hz: halfDepth + wallThickness },
    ];

    for (const wall of walls) {
      const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(wall.x, wallHeight / 2, wall.z);
      const body = this.world.createRigidBody(bodyDesc);
      const colliderDesc = RAPIER.ColliderDesc.cuboid(wall.hx, wallHeight / 2, wall.hz);
      this.world.createCollider(colliderDesc, body);
    }

    console.log('[ShooterPhysics] Arena boundary walls created');
  }

  /**
   * Create a kinematicPositionBased rigid body + capsule collider for a player.
   * Position-based kinematic is required for KinematicCharacterController.
   */
  createPlayerBody(playerId: string, x: number, z: number): void {
    if (!this.world) return;

    // Remove existing body if any
    this.removePlayerBody(playerId);

    const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(x, PLAYER_CAPSULE_HALF_HEIGHT + PLAYER_COLLISION_RADIUS, z);

    const body = this.world.createRigidBody(bodyDesc);

    const colliderDesc = RAPIER.ColliderDesc.capsule(PLAYER_CAPSULE_HALF_HEIGHT, PLAYER_COLLISION_RADIUS);
    const collider = this.world.createCollider(colliderDesc, body);

    this.playerData.set(playerId, { body, collider });
  }

  /**
   * Move a player by a desired translation vector.
   * Uses the KinematicCharacterController to compute a corrected movement
   * that slides along walls and stops at obstacles.
   * Returns the actual new position after collision resolution.
   */
  movePlayer(playerId: string, dx: number, dz: number): { x: number; z: number } | null {
    const data = this.playerData.get(playerId);
    if (!data || !this.world || !this.characterController) return null;

    const { body, collider } = data;
    const desiredTranslation = { x: dx, y: 0, z: dz };

    // Compute collision-corrected movement
    this.characterController.computeColliderMovement(
      collider,
      desiredTranslation,
      undefined, // filterFlags
      undefined, // filterGroups
    );

    // Get the corrected movement (slides along walls, stops at obstacles)
    const corrected = this.characterController.computedMovement();

    // Log collisions for debugging (first 500 ticks only)
    const numCollisions = this.characterController.numComputedCollisions();
    if (numCollisions > 0 && this.debugCounter < 20) {
      this.debugCounter++;
      const currentPos = body.translation();
      console.log(`[ShooterPhysics] ${playerId.slice(-5)} at (${currentPos.x.toFixed(2)}, ${currentPos.y.toFixed(2)}, ${currentPos.z.toFixed(2)}) desired=(${dx.toFixed(3)}, ${dz.toFixed(3)}) corrected=(${corrected.x.toFixed(3)}, ${corrected.z.toFixed(3)}) collisions=${numCollisions}`);
    }

    // Apply the corrected translation to the kinematic body
    const currentPos = body.translation();
    const newX = currentPos.x + corrected.x;
    const newZ = currentPos.z + corrected.z;
    const newY = currentPos.y; // Keep Y constant (top-down game)

    body.setNextKinematicTranslation({ x: newX, y: newY, z: newZ });

    return { x: newX, z: newZ };
  }

  /** Step the physics simulation by one tick */
  stepWorld(): void {
    if (!this.world) return;
    this.world.timestep = TICK_INTERVAL_MS / 1000;
    this.world.step();
  }

  /** Get a player's current position from their Rapier body */
  getPlayerPosition(playerId: string): { x: number; z: number } | null {
    const data = this.playerData.get(playerId);
    if (!data) return null;
    const pos = data.body.translation();
    return { x: pos.x, z: pos.z };
  }

  /** Teleport a player body (for respawns) */
  teleportPlayer(playerId: string, x: number, z: number): void {
    const data = this.playerData.get(playerId);
    if (!data) return;
    data.body.setTranslation({ x, y: PLAYER_CAPSULE_HALF_HEIGHT + PLAYER_COLLISION_RADIUS, z }, true);
  }

  /** Remove a player's rigid body from the world */
  removePlayerBody(playerId: string): void {
    if (!this.world) return;
    const data = this.playerData.get(playerId);
    if (data) {
      this.world.removeRigidBody(data.body);
      this.playerData.delete(playerId);
    }
  }

  /** Remove all player bodies (between matches). Map geometry stays. */
  resetPlayers(): void {
    if (!this.world) return;
    for (const [, data] of this.playerData) {
      this.world.removeRigidBody(data.body);
    }
    this.playerData.clear();
  }

  /**
   * Merge overlapping/touching bounding boxes into larger combined boxes.
   * Iteratively merges any pair that overlaps until no more merges are possible.
   */
  private mergeBBoxes(boxes: BuildingBBox[]): BuildingBBox[] {
    const PAD = 0.5; // merge boxes within 0.5 units of each other
    let result = boxes.map((b) => ({ ...b }));
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < result.length; i++) {
        for (let j = i + 1; j < result.length; j++) {
          const a = result[i];
          const b = result[j];
          if (
            a.minX - PAD <= b.maxX && a.maxX + PAD >= b.minX &&
            a.minZ - PAD <= b.maxZ && a.maxZ + PAD >= b.minZ
          ) {
            result[i] = {
              minX: Math.min(a.minX, b.minX),
              maxX: Math.max(a.maxX, b.maxX),
              minZ: Math.min(a.minZ, b.minZ),
              maxZ: Math.max(a.maxZ, b.maxZ),
            };
            result.splice(j, 1);
            changed = true;
            break;
          }
        }
        if (changed) break;
      }
    }
    return result;
  }

  /**
   * Test if a point overlaps with any building (for spawn validation).
   * Returns true if the point is inside or very close to a building.
   */
  isInsideBuilding(x: number, z: number, radius: number = PLAYER_COLLISION_RADIUS): boolean {
    for (const bb of this.buildingBBoxes) {
      if (
        x + radius > bb.minX &&
        x - radius < bb.maxX &&
        z + radius > bb.minZ &&
        z - radius < bb.maxZ
      ) {
        return true;
      }
    }
    return false;
  }
}
