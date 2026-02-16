/**
 * Shooter game engine -- server-authoritative with Rapier 3D WASM physics.
 *
 * Runs a tick-based loop at 20 Hz. Each tick:
 *  1. Process queued agent actions (move, shoot, melee, pickup)
 *  2. Step Rapier physics (kinematic player bodies against map trimesh)
 *  3. Handle respawns
 *  4. Broadcast state via callback
 */

import RAPIER from '@dimforge/rapier3d-compat';
import type {
  ShooterPlayer,
  ShooterMatch,
  ShooterMatchPhase,
  WeaponPickup,
  ShooterActionRequest,
  ShooterSpectatorState,
  ShooterSpectatorHitEvent,
  ShooterSpectatorShotEvent,
} from '../../shared/shooter-types.js';
import {
  TICK_INTERVAL_MS,
  PLAYER_MOVE_SPEED,
  PLAYER_CAPSULE_RADIUS,
  PLAYER_CAPSULE_HALF_HEIGHT,
  WEAPON_STATS,
  WEAPON_TYPES,
  GUN_TYPES,
  INITIAL_WEAPON_PICKUPS,
  PICKUP_RADIUS,
  RESPAWN_DELAY_MS,
  HEALTH_PER_LIFE,
  ARENA_MIN_X,
  ARENA_MAX_X,
  ARENA_MIN_Z,
  ARENA_MAX_Z,
  ARENA_MIN_Y,
  MIN_DISTANCE_GUN_FROM_GUN,
  BULLET_RADIUS,
  BULLET_SPEED,
  BULLET_MAX_AGE_MS,
  BULLET_MASS,
  SPAWN_FLOOR_Y_OFFSET,
  type WeaponType,
} from '../../shared/shooter-constants.js';
import { loadMapGeometry, createMapCollider, type SpawnPoint, type MapGeometry } from './glb-loader.js';
import {
  createPlayer,
  damagePlayer,
  respawnPlayer,
  pickupWeapon,
  dropWeapon,
  pickSpawnPoint,
  pickUnoccupiedSpawnPoint,
  pickRandomUnoccupiedSpawnPoint,
  getOccupiedSpawnIndices,
  randomArenaPoint,
  randomArenaPointInEmptySpace,
  getTotalSurvivalSeconds,
  resetCharacterIndex,
  setDefaultFloorY,
  setPlayableBounds,
} from './player.js';
import { canFire, consumeAmmo, randomGunType } from './weapons.js';

// Queued action from an agent
interface QueuedAction {
  playerId: string;
  action: ShooterActionRequest;
}

// Per-player Rapier body handle
interface PlayerBody {
  rigidBody: RAPIER.RigidBody;
  collider: RAPIER.Collider;
}

// Active physical bullet in the world
interface ActiveBullet {
  id: string;
  rigidBody: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  ownerId: string;
  damage: number;
  weaponType: WeaponType;
  spawnTime: number;
  fromX: number;
  fromY: number;
  fromZ: number;
  /** Previous frame position for swept raycast collision detection. */
  prevX: number;
  prevY: number;
  prevZ: number;
}

export class ShooterEngine {
  private rapier!: typeof RAPIER;
  private world!: RAPIER.World;
  private mapGeometry!: MapGeometry;
  private initialized = false;

  private match: ShooterMatch | null = null;
  private playerBodies: Map<string, PlayerBody> = new Map();
  private actionQueue: QueuedAction[] = [];
  private tickTimer: NodeJS.Timeout | null = null;
  private bulletIdCounter = 0;
  private activeBullets: ActiveBullet[] = [];
  /** Constant floor Y (feet) for all players so height never varies. */
  private arenaFloorY = 0;

  /** Per-player desired movement direction. Persists until 'stop' action. */
  private moveIntents: Map<string, { angle: number }> = new Map();

  /** Stuck-in-geometry detection: if position unchanged for this long and inside map, teleport out. */
  private static readonly STUCK_IN_GEOMETRY_MS = 3000;
  private static readonly STUCK_POS_THRESHOLD = 0.3;
  private lastStuckCheckPos: Map<string, { x: number; z: number; time: number }> = new Map();

  private onTickCallback: ((state: ShooterSpectatorState) => void) | null = null;
  private onShotCallback: ((shot: ShooterSpectatorShotEvent) => void) | null = null;
  private onHitCallback: ((hit: ShooterSpectatorHitEvent) => void) | null = null;
  private onMatchEndCallback: (() => void) | null = null;
  private onPreTickCallback: (() => void) | null = null;

  // ── Initialization ────────────────────────────────────────────────

  async init(): Promise<void> {
    if (this.initialized) return;

    await RAPIER.init();
    this.rapier = RAPIER;

    // Load map geometry
    try {
      this.mapGeometry = await loadMapGeometry('map4.glb');
    } catch (err) {
      console.warn('[ShooterEngine] map4.glb not found, trying map.glb:', err);
      this.mapGeometry = await loadMapGeometry('map.glb');
    }

    this.initialized = true;
    console.log('[ShooterEngine] Initialized with Rapier 3D');
  }

  // ── Event callbacks ───────────────────────────────────────────────

  onTick(cb: (state: ShooterSpectatorState) => void): void {
    this.onTickCallback = cb;
  }
  onShot(cb: (shot: ShooterSpectatorShotEvent) => void): void {
    this.onShotCallback = cb;
  }
  onHit(cb: (hit: ShooterSpectatorHitEvent) => void): void {
    this.onHitCallback = cb;
  }
  onMatchEnd(cb: () => void): void {
    this.onMatchEndCallback = cb;
  }
  /** Called before each tick so bot AI can queue actions. */
  onPreTick(cb: () => void): void {
    this.onPreTickCallback = cb;
  }

  // ── Match lifecycle ───────────────────────────────────────────────

  createMatch(matchId: string): ShooterMatch {
    // Create fresh physics world
    this.world = new this.rapier.World({ x: 0, y: -9.81, z: 0 });

    // Add map trimesh collider
    createMapCollider(this.rapier, this.world, this.mapGeometry);

    // Add a large invisible floor plane as safety net so players never fall into the void
    const floorBody = this.world.createRigidBody(this.rapier.RigidBodyDesc.fixed());
    const floorCollider = this.rapier.ColliderDesc.cuboid(200, 0.1, 200)
      .setTranslation(0, -10.0, 0);
    this.world.createCollider(floorCollider, floorBody);

    // Clean up old player bodies and bullets (new world so no need to remove bodies)
    this.playerBodies.clear();
    this.moveIntents.clear();
    this.lastStuckCheckPos.clear();
    this.actionQueue = [];
    this.activeBullets = [];
    this.bulletIdCounter = 0;
    resetCharacterIndex();

    // Set floor Y below min spawn so bots spawn on the ground (spawn markers may be placed above floor)
    this.arenaFloorY = this.getFloorY() - SPAWN_FLOOR_Y_OFFSET;
    setDefaultFloorY(this.arenaFloorY);
    setPlayableBounds(this.mapGeometry.spawnPoints);

    this.match = {
      id: matchId,
      phase: 'lobby',
      tick: 0,
      startTime: 0,
      endTime: 0,
      players: new Map(),
      pickups: [],
    };

    return this.match;
  }

  getMatch(): ShooterMatch | null {
    return this.match;
  }

  addPlayer(
    playerId: string,
    name: string,
    strategyTag?: string,
    options?: { personality?: import('../../shared/shooter-constants.js').PersonalityType; isAI?: boolean },
  ): ShooterPlayer | null {
    if (!this.match) return null;
    if (this.match.players.has(playerId)) return null;

    const spawn = this.getValidSpawnPoint();

    const player = createPlayer(playerId, name, spawn, strategyTag, options);
    player.y = this.arenaFloorY; // Constant floor Y for all bots
    this.match.players.set(playerId, player);

    this.createPlayerBody(player);
    return player;
  }

  removePlayer(playerId: string): void {
    if (!this.match) return;
    this.match.players.delete(playerId);
    this.moveIntents.delete(playerId);
    this.removePlayerBody(playerId);
  }

  startMatch(durationMs: number): void {
    if (!this.match || (this.match.phase !== 'lobby' && this.match.phase !== 'countdown')) return;

    this.match.phase = 'active';
    this.match.startTime = Date.now();
    this.match.endTime = Date.now() + durationMs;

    // Reset all players for match start
    const now = Date.now();
    for (const player of this.match.players.values()) {
      player.aliveSince = now;
      player.survivalTime = 0;
      player.kills = 0;
      player.deaths = 0;
    }

    // Spawn initial weapon pickups
    this.spawnInitialPickups();

    // Start tick loop
    this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    console.log(`[ShooterEngine] Match ${this.match.id} started (${durationMs / 1000}s)`);
  }

  stopMatch(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.match) {
      this.match.phase = 'finished';
    }
  }

  // ── Action queue ──────────────────────────────────────────────────

  queueAction(playerId: string, action: ShooterActionRequest): void {
    this.actionQueue.push({ playerId, action });
  }

  // ── Tick ──────────────────────────────────────────────────────────

  private tick(): void {
    if (!this.match || this.match.phase !== 'active') return;

    this.match.tick++;
    const now = Date.now();

    // Check time limit
    if (now >= this.match.endTime) {
      this.stopMatch();
      this.onMatchEndCallback?.();
      return;
    }

    // 0. Let bot AI queue actions before processing
    this.onPreTickCallback?.();

    // 1. Process queued actions
    this.processActions(now);

    // 2. Apply movement intents
    this.applyMovement();

    // 3. Step Rapier physics (bullets move here)
    this.world.step();

    // 4. Process bullet collisions and remove hit/expired bullets
    this.processBulletHits(now);

    // 5. Sync Rapier body positions back to player state
    this.syncPositions();

    // 6. Handle respawns
    this.handleRespawns(now);

    // 7. Check win condition (≤1 player with lives remaining)
    this.checkWinCondition();

    // 8. Broadcast state
    this.broadcastState();
  }

  private processActions(now: number): void {
    const actions = this.actionQueue.splice(0);

    for (const { playerId, action } of actions) {
      const player = this.match!.players.get(playerId);
      if (!player || !player.alive || player.eliminated) continue;

      switch (action.action) {
        case 'move':
          if (action.angle !== undefined) {
            this.moveIntents.set(playerId, { angle: action.angle });
            // Update facing angle immediately so melee/shoot in the same tick can use it
            player.angle = action.angle;
          }
          break;

        case 'stop':
          this.moveIntents.delete(playerId);
          break;

        case 'shoot':
          this.handleShoot(player, action.aimAngle ?? player.angle, now);
          break;

        case 'melee':
          this.handleMelee(player, now);
          break;

        case 'pickup':
          this.handlePickup(player);
          break;
      }
    }
  }

  /**
   * Apply movement using shape-casts (sphere sweeps) against the map trimesh.
   *
   * For each moving player we sweep a small sphere in the desired direction.
   * If it collides with the map within (stepDist + skin), we shorten the
   * movement. We also try per-axis sliding to let players glide along walls,
   * and additionally try diagonal alternatives so bots don't get permanently
   * stuck against corners or angled walls.
   *
   * The sphere is cast at the capsule's centre height — safely above the
   * floor, so it only detects vertical surfaces (walls, obstacles).
   */
  private applyMovement(): void {
    if (!this.match) return;

    const dt = TICK_INTERVAL_MS / 1000;
    const SKIN = 0.15; // stop this far before a wall

    for (const [playerId, intent] of this.moveIntents) {
      const player = this.match.players.get(playerId);
      if (!player || !player.alive) continue;

      const body = this.playerBodies.get(playerId);
      if (!body) continue;

      const rad = (intent.angle * Math.PI) / 180;
      const desiredDx = Math.cos(rad) * PLAYER_MOVE_SPEED * dt;
      const desiredDz = Math.sin(rad) * PLAYER_MOVE_SPEED * dt;

      // Update facing angle
      player.angle = intent.angle;

      const pos = body.rigidBody.translation();

      let moveX = desiredDx;
      let moveZ = desiredDz;

      const fullDist = Math.sqrt(moveX * moveX + moveZ * moveZ);
      if (fullDist > 0.001) {
        const dirX = moveX / fullDist;
        const dirZ = moveZ / fullDist;

        const hitToi = this.shapeCastHorizontal(
          pos.x, pos.y, pos.z, dirX, dirZ, fullDist + SKIN, body.rigidBody,
        );

        if (hitToi < fullDist + SKIN) {
          const allowedFull = Math.max(0, hitToi - SKIN);
          if (allowedFull < fullDist * 0.5) {
            // Try sliding per-axis
            moveX = this.tryAxisShapeCast(pos.x, pos.y, pos.z, desiredDx, 0, SKIN, body.rigidBody);
            moveZ = this.tryAxisShapeCast(pos.x + moveX, pos.y, pos.z, 0, desiredDz, SKIN, body.rigidBody);

            // If per-axis sliding yielded almost zero movement, try angled alternatives
            const slideDist = Math.sqrt(moveX * moveX + moveZ * moveZ);
            if (slideDist < fullDist * 0.15) {
              const altAngles = [45, -45, 90, -90, 30, -30, 60, -60];
              for (const offset of altAngles) {
                const altRad = ((intent.angle + offset) * Math.PI) / 180;
                const altDx = Math.cos(altRad) * PLAYER_MOVE_SPEED * dt;
                const altDz = Math.sin(altRad) * PLAYER_MOVE_SPEED * dt;
                const altDist = Math.sqrt(altDx * altDx + altDz * altDz);
                if (altDist < 0.001) continue;

                const altDirX = altDx / altDist;
                const altDirZ = altDz / altDist;
                const altToi = this.shapeCastHorizontal(
                  pos.x, pos.y, pos.z, altDirX, altDirZ, altDist + SKIN, body.rigidBody,
                );

                if (altToi >= altDist + SKIN) {
                  moveX = altDx;
                  moveZ = altDz;
                  break;
                } else {
                  const altAllowed = Math.max(0, altToi - SKIN);
                  if (altAllowed > fullDist * 0.3) {
                    const altRatio = altAllowed / altDist;
                    moveX = altDx * altRatio;
                    moveZ = altDz * altRatio;
                    break;
                  }
                }
              }
            }
          } else {
            const ratio = allowedFull / fullDist;
            moveX = desiredDx * ratio;
            moveZ = desiredDz * ratio;
          }
        }
      }

      // Clamp to arena bounds
      const skinBound = PLAYER_CAPSULE_RADIUS + SKIN;
      const nextX = Math.max(ARENA_MIN_X + skinBound, Math.min(ARENA_MAX_X - skinBound, pos.x + moveX));
      const nextZ = Math.max(ARENA_MIN_Z + skinBound, Math.min(ARENA_MAX_Z - skinBound, pos.z + moveZ));

      body.rigidBody.setNextKinematicTranslation({
        x: nextX,
        y: pos.y,
        z: nextZ,
      });
    }
  }

  /**
   * Sweep a sphere horizontally at the player's centre height.
   * The sphere has the player radius but sits at pos.y (well above floor),
   * so it only detects walls and obstacles, never the floor plane.
   * Returns time-of-impact (distance along direction). Infinity = no hit.
   */
  private shapeCastHorizontal(
    px: number, py: number, pz: number,
    dirX: number, dirZ: number,
    maxDist: number,
    excludeBody: RAPIER.RigidBody,
  ): number {
    // Use a sphere at the capsule centre (waist height). This ensures
    // we detect walls but the sphere bottom (py - radius = -4.58) stays
    // above the floor surface (~y=-5.38), avoiding false floor hits.
    const shape = new this.rapier.Ball(PLAYER_CAPSULE_RADIUS);
    const shapePos = { x: px, y: py, z: pz };
    const shapeRot = { w: 1, x: 0, y: 0, z: 0 };
    const shapeDir = { x: dirX, y: 0, z: dirZ };

    const hit = this.world.castShape(
      shapePos,       // initial position of the shape
      shapeRot,       // rotation
      shapeDir,       // velocity / direction
      shape,          // the shape
      0,              // targetDistance: report when shapes are this close
      maxDist,        // maxToi: max distance to travel
      false,          // stopAtPenetration: false = ignore initial overlaps
      undefined,      // filter flags
      undefined,      // filter groups
      undefined,      // exclude collider
      excludeBody,    // exclude rigid body
    );

    return hit ? hit.time_of_impact : Infinity;
  }

  /** Try moving along a single axis using shape cast; returns allowed displacement. */
  private tryAxisShapeCast(
    px: number, py: number, pz: number,
    dx: number, dz: number,
    skin: number,
    excludeBody: RAPIER.RigidBody,
  ): number {
    const dist = Math.abs(dx) + Math.abs(dz);
    if (dist < 0.001) return 0;

    const dirX = dx !== 0 ? Math.sign(dx) : 0;
    const dirZ = dz !== 0 ? Math.sign(dz) : 0;

    const toi = this.shapeCastHorizontal(px, py, pz, dirX, dirZ, dist + skin, excludeBody);

    if (toi < dist + skin) {
      const allowed = Math.max(0, toi - skin);
      return dx !== 0 ? Math.sign(dx) * allowed : Math.sign(dz) * allowed;
    }

    return dx !== 0 ? dx : dz;
  }

  /**
   * Returns true if a sphere of the given radius at (x, y, z) does not intersect the map (fixed bodies).
   * Used to spawn only in empty space when no spawn points are free.
   */
  isPointInEmptySpace(x: number, y: number, z: number, radius: number): boolean {
    const shape = new this.rapier.Ball(radius);
    const shapePos = { x, y, z };
    const shapeRot = { w: 1, x: 0, y: 0, z: 0 };
    let hitsMap = false;
    this.world.intersectionsWithShape(
      shapePos,
      shapeRot,
      shape,
      (collider: RAPIER.Collider) => {
        const body = collider.parent();
        if (body && body.isFixed()) {
          hitsMap = true;
          return false;
        }
        return true;
      },
    );
    if (hitsMap) return false;

    // Also verify there's ground below (ray downward must hit map within 5 units).
    // This prevents spawning outside the map where there's no floor geometry.
    const downRay = new this.rapier.Ray({ x, y: y + 2, z }, { x: 0, y: -1, z: 0 });
    const groundHit = this.world.castRay(downRay, 10, true);
    if (!groundHit) return false; // No ground below = outside the map
    const hitBody = groundHit.collider.parent();
    if (!hitBody || !hitBody.isFixed()) return false; // Ground must be map geometry

    return true;
  }

  /**
   * Get a valid spawn point. GLB spawn points are always trusted (placed by the
   * level designer). We just try to pick one that isn't already occupied by
   * another player or pickup. If all are occupied, pick a random one.
   */
  private getValidSpawnPoint(): SpawnPoint {
    const spawnPoints = this.mapGeometry.spawnPoints;
    if (spawnPoints.length === 0) return randomArenaPoint();

    const alivePlayers = [...this.match!.players.values()].filter((p) => p.alive);
    const pickups = this.match!.pickups.filter((p) => !p.taken).map((p) => ({ x: p.x, y: p.y, z: p.z }));
    const occupied = getOccupiedSpawnIndices(spawnPoints, alivePlayers, pickups);

    // First: pick an unoccupied spawn point
    const unoccupied: number[] = [];
    for (let i = 0; i < spawnPoints.length; i++) {
      if (!occupied.has(i)) unoccupied.push(i);
    }

    if (unoccupied.length > 0) {
      // Pick a random unoccupied one (so bots don't always get the same spawns)
      const idx = unoccupied[Math.floor(Math.random() * unoccupied.length)];
      return spawnPoints[idx];
    }

    // All occupied: pick the spawn point farthest from all alive players
    let bestIdx = 0;
    let bestMinDist = -1;
    for (let i = 0; i < spawnPoints.length; i++) {
      const sp = spawnPoints[i];
      let minDist = Infinity;
      for (const p of alivePlayers) {
        const dx = sp.x - p.x, dz = sp.z - p.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < minDist) minDist = dist;
      }
      if (minDist > bestMinDist) {
        bestMinDist = minDist;
        bestIdx = i;
      }
    }
    return spawnPoints[bestIdx];
  }

  /**
   * Get a deterministic spawn point for respawn so the same player always
   * respawns at the same spawn (when available), avoiding teleporting between
   * different spawn locations.
   */
  private getRespawnSpawnPoint(playerId: string): SpawnPoint {
    const spawnPoints = this.mapGeometry.spawnPoints;
    if (spawnPoints.length === 0) return randomArenaPoint();

    const alivePlayers = [...this.match!.players.values()].filter((p) => p.alive);
    const pickups = this.match!.pickups.filter((p) => !p.taken).map((p) => ({ x: p.x, y: p.y, z: p.z }));
    const occupied = getOccupiedSpawnIndices(spawnPoints, alivePlayers, pickups);

    // Deterministic index from player id so same player gets same spawn when possible
    let hash = 0;
    for (let i = 0; i < playerId.length; i++) hash = (hash * 31 + playerId.charCodeAt(i)) >>> 0;
    const preferredIdx = hash % spawnPoints.length;

    if (!occupied.has(preferredIdx)) return spawnPoints[preferredIdx];

    // Preferred spawn is occupied: use next unoccupied in order
    const unoccupied: number[] = [];
    for (let i = 0; i < spawnPoints.length; i++) {
      if (!occupied.has(i)) unoccupied.push(i);
    }
    if (unoccupied.length > 0) {
      const idx = unoccupied[Math.floor(Math.random() * unoccupied.length)];
      return spawnPoints[idx];
    }

    return spawnPoints[preferredIdx];
  }

  private syncPositions(): void {
    if (!this.match) return;

    const now = Date.now();

    for (const [playerId, body] of this.playerBodies) {
      const player = this.match.players.get(playerId);
      if (!player) continue;

      if (!player.alive) continue;

      const pos = body.rigidBody.translation();
      player.x = pos.x;
      player.y = this.arenaFloorY;
      player.z = pos.z;

      const skinBound = PLAYER_CAPSULE_RADIUS + 0.15;
      const outOfHorizontal =
        pos.x < ARENA_MIN_X + skinBound ||
        pos.x > ARENA_MAX_X - skinBound ||
        pos.z < ARENA_MIN_Z + skinBound ||
        pos.z > ARENA_MAX_Z - skinBound;
      const outOfVertical = pos.y < ARENA_MIN_Y;
      const outOfBounds = outOfHorizontal || outOfVertical;

      if (outOfBounds) {
        const spawn = this.getValidSpawnPoint();
        const bodyY = this.arenaFloorY + PLAYER_CAPSULE_HALF_HEIGHT + PLAYER_CAPSULE_RADIUS;
        const pos = { x: spawn.x, y: bodyY, z: spawn.z };
        player.x = spawn.x;
        player.y = this.arenaFloorY;
        player.z = spawn.z;
        body.rigidBody.setNextKinematicTranslation(pos);
        body.rigidBody.setTranslation(pos, true);
        this.lastStuckCheckPos.set(playerId, { x: spawn.x, z: spawn.z, time: now });
      } else {
        player.x = Math.max(ARENA_MIN_X, Math.min(ARENA_MAX_X, player.x));
        player.z = Math.max(ARENA_MIN_Z, Math.min(ARENA_MAX_Z, player.z));

        const prev = this.lastStuckCheckPos.get(playerId);
        const dx = player.x - (prev?.x ?? player.x - 1);
        const dz = player.z - (prev?.z ?? player.z - 1);
        const dist = Math.sqrt(dx * dx + dz * dz);

        if (!prev || dist > ShooterEngine.STUCK_POS_THRESHOLD) {
          this.lastStuckCheckPos.set(playerId, { x: player.x, z: player.z, time: now });
        } else if (now - prev.time >= ShooterEngine.STUCK_IN_GEOMETRY_MS) {
          const centerY = this.arenaFloorY + PLAYER_CAPSULE_HALF_HEIGHT + PLAYER_CAPSULE_RADIUS;
          if (!this.isPointInEmptySpace(player.x, centerY, player.z, PLAYER_CAPSULE_RADIUS)) {
            const spawn = this.getValidSpawnPoint();
            const bodyY = this.arenaFloorY + PLAYER_CAPSULE_HALF_HEIGHT + PLAYER_CAPSULE_RADIUS;
            const pos = { x: spawn.x, y: bodyY, z: spawn.z };
            player.x = spawn.x;
            player.y = this.arenaFloorY;
            player.z = spawn.z;
            body.rigidBody.setNextKinematicTranslation(pos);
            body.rigidBody.setTranslation(pos, true);
            this.lastStuckCheckPos.set(playerId, { x: spawn.x, z: spawn.z, time: now });
          }
        }
      }
    }
  }

  // ── Line-of-sight & raycasting (used by bot AI) ──────────────────

  /**
   * Check line-of-sight between two XZ positions at chest height.
   * Returns true if the ray reaches the target without hitting map geometry.
   * Player bodies are kinematic and won't block the ray by default.
   */
  hasLineOfSight(
    fromX: number, fromZ: number,
    toX: number, toZ: number,
    excludePlayerId?: string,
  ): boolean {
    if (!this.world) return false;

    const dx = toX - fromX;
    const dz = toZ - fromZ;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.01) return true;

    // Use the actual player body Y so rays match the player's height in the world
    const rayHeight = this.getPlayerRayHeight(excludePlayerId);
    const origin = { x: fromX, y: rayHeight, z: fromZ };
    const direction = { x: dx / len, y: 0, z: dz / len };
    const ray = new this.rapier.Ray(origin, direction);

    const excludeBody = excludePlayerId
      ? this.playerBodies.get(excludePlayerId)?.rigidBody ?? undefined
      : undefined;

    const hit = this.world.castRay(
      ray,
      len,
      true,           // solid
      undefined,       // filter flags
      undefined,       // filter groups
      undefined,       // exclude collider
      excludeBody,     // exclude rigid body
    );

    if (!hit) return true;

    // Check if the hit was against a fixed body (map). If not, treat as clear.
    const hitBody = hit.collider.parent();
    if (hitBody && hitBody.isFixed()) {
      // LOS threshold: allow 98% of the distance (small tolerance)
      return hit.timeOfImpact >= len * 0.98;
    }

    return true;
  }

  /**
   * Cast a ray in a given direction (angle in degrees) from a position.
   * Returns the distance to the first hit (map/fixed body), or Infinity if clear.
   * Used by bot AI for obstacle avoidance.
   */
  castRayInDirection(
    fromX: number, fromZ: number,
    angleDeg: number,
    maxDist: number,
    excludePlayerId?: string,
  ): number {
    if (!this.world) return Infinity;

    const rad = (angleDeg * Math.PI) / 180;
    const dirX = Math.cos(rad);
    const dirZ = Math.sin(rad);

    // Use the actual player body Y so rays match the player's height in the world
    const rayHeight = this.getPlayerRayHeight(excludePlayerId);
    const origin = { x: fromX, y: rayHeight, z: fromZ };
    const direction = { x: dirX, y: 0, z: dirZ };
    const ray = new this.rapier.Ray(origin, direction);

    const excludeBody = excludePlayerId
      ? this.playerBodies.get(excludePlayerId)?.rigidBody ?? undefined
      : undefined;

    const hit = this.world.castRay(
      ray,
      maxDist,
      true,
      undefined,
      undefined,
      undefined,
      excludeBody,
    );

    if (!hit) return Infinity;

    const hitBody = hit.collider.parent();
    if (hitBody && hitBody.isFixed()) {
      return hit.timeOfImpact;
    }

    return Infinity;
  }

  /**
   * Try the desired direction first, then offsets (+/-30, +/-60, +/-90 degrees).
   * Returns the angle (degrees) with the longest clear distance.
   */
  findClearDirection(
    fromX: number, fromZ: number,
    desiredAngleDeg: number,
    lookahead: number,
    excludePlayerId?: string,
  ): number {
    const offsets = [0, 30, -30, 60, -60, 90, -90];
    let bestAngle = desiredAngleDeg;
    let bestDist = 0;

    for (const off of offsets) {
      const angle = desiredAngleDeg + off;
      const dist = this.castRayInDirection(fromX, fromZ, angle, lookahead, excludePlayerId);
      if (dist > bestDist) {
        bestDist = dist;
        bestAngle = angle;
      }
    }
    return bestAngle;
  }

  /**
   * Eight directions every 45 degrees; returns the angle with the longest clear
   * distance, preferring directions closer to targetAngleDeg.
   */
  findLongestClearDirection(
    fromX: number, fromZ: number,
    targetAngleDeg: number,
    maxDist: number,
    excludePlayerId?: string,
  ): number {
    const candidates: { angle: number; dist: number; diffAbs: number }[] = [];

    for (let i = 0; i < 8; i++) {
      const angle = i * 45;
      const dist = this.castRayInDirection(fromX, fromZ, angle, maxDist, excludePlayerId);
      let diff = angle - targetAngleDeg;
      while (diff > 180) diff -= 360;
      while (diff < -180) diff += 360;
      candidates.push({ angle, dist, diffAbs: Math.abs(diff) });
    }

    candidates.sort((a, b) => {
      if (Math.abs(b.dist - a.dist) < 0.1) return a.diffAbs - b.diffAbs;
      return b.dist - a.dist;
    });

    return candidates[0].angle;
  }

  /**
   * Get the Y height for raycasting from a player's actual body position.
   * Falls back to a reasonable default if player not found.
   */
  private getPlayerRayHeight(playerId?: string): number {
    if (playerId) {
      const body = this.playerBodies.get(playerId);
      if (body) {
        return body.rigidBody.translation().y;
      }
      // Also try from player state
      const player = this.match?.players.get(playerId);
      if (player) {
        return player.y + PLAYER_CAPSULE_HALF_HEIGHT + PLAYER_CAPSULE_RADIUS;
      }
    }
    // Fallback: use the average Y of alive players, or the first spawn point Y + capsule offset
    if (this.match) {
      for (const p of this.match.players.values()) {
        if (p.alive) {
          const body = this.playerBodies.get(p.id);
          if (body) return body.rigidBody.translation().y;
        }
      }
    }
    // Last resort: use first spawn point
    if (this.mapGeometry.spawnPoints.length > 0) {
      return this.mapGeometry.spawnPoints[0].y + PLAYER_CAPSULE_HALF_HEIGHT + PLAYER_CAPSULE_RADIUS;
    }
    return PLAYER_CAPSULE_HALF_HEIGHT + PLAYER_CAPSULE_RADIUS;
  }

  /** Get the floor Y (minimum spawn Y) so everyone spawns on the ground. */
  getFloorY(): number {
    const spawns = this.mapGeometry.spawnPoints;
    if (spawns.length === 0) return 0;
    let minY = spawns[0].y;
    for (const sp of spawns) if (sp.y < minY) minY = sp.y;
    return minY;
  }

  // ── Combat ────────────────────────────────────────────────────────

  /** Spawn physical bullet rigid bodies instead of raycasts. */
  private handleShoot(player: ShooterPlayer, aimAngle: number, now: number): void {
    const stats = WEAPON_STATS[player.weapon];
    if (!stats || stats.isMelee) return;
    if (!canFire(player.weapon, player.ammo, player.lastShotTime, now)) return;

    player.lastShotTime = now;
    player.ammo = consumeAmmo(player.ammo);

    const ownBody = this.playerBodies.get(player.id);
    // player.y is now feet-level; gun is at roughly chest height (feet + capsule height + a bit)
    const gunHeight = player.y + PLAYER_CAPSULE_HALF_HEIGHT * 2 + PLAYER_CAPSULE_RADIUS + 0.3;

    // Use the character's facing direction for the muzzle offset so bullets
    // always appear to come from the gun barrel, not from the side
    const facingRad = (player.angle * Math.PI) / 180;
    const muzzleX = player.x + Math.cos(facingRad) * 0.8;
    const muzzleZ = player.z + Math.sin(facingRad) * 0.8;

    for (let i = 0; i < stats.pellets; i++) {
      const spreadAngle = aimAngle + (Math.random() - 0.5) * stats.spread * (180 / Math.PI);
      const rad = (spreadAngle * Math.PI) / 180;
      const dirX = Math.cos(rad);
      const dirZ = Math.sin(rad);

      const bulletId = `bullet_${++this.bulletIdCounter}_${Date.now()}`;
      const bodyDesc = this.rapier.RigidBodyDesc.dynamic()
        .setTranslation(muzzleX, gunHeight, muzzleZ)
        .setLinearDamping(0)
        .setCcdEnabled(true)
        .setGravityScale(0); // Bullets travel in straight lines, no gravity
      const rigidBody = this.world.createRigidBody(bodyDesc);
      rigidBody.setLinvel({ x: dirX * BULLET_SPEED, y: 0, z: dirZ * BULLET_SPEED }, true);
      rigidBody.setAdditionalMass(BULLET_MASS, true);

      const colliderDesc = this.rapier.ColliderDesc.ball(BULLET_RADIUS)
        .setDensity(1)
        .setFriction(0)
        .setRestitution(0);
      const collider = this.world.createCollider(colliderDesc, rigidBody);

      this.activeBullets.push({
        id: bulletId,
        rigidBody,
        collider,
        ownerId: player.id,
        damage: stats.damage,
        weaponType: player.weapon,
        spawnTime: now,
        fromX: muzzleX,
        fromY: gunHeight,
        fromZ: muzzleZ,
        prevX: muzzleX,
        prevY: gunHeight,
        prevZ: muzzleZ,
      });
    }

    // Emit a short muzzle-flash trail (2 units). Full trails are only
    // emitted on hit:true events (when bullets actually collide).
    const aimRad = (aimAngle * Math.PI) / 180;
    const muzzleLen = 2;
    this.onShotCallback?.({
      shooterId: player.id,
      fromX: muzzleX,
      fromZ: muzzleZ,
      toX: muzzleX + Math.cos(aimRad) * muzzleLen,
      toZ: muzzleZ + Math.sin(aimRad) * muzzleLen,
      weapon: player.weapon,
      hit: false,
    });

    if (player.ammo !== null && player.ammo <= 0) {
      const depletedGun = player.weapon;
      player.weapon = WEAPON_TYPES.KNIFE;
      player.ammo = null;
      // Re-enter the depleted gun into the economy as a fresh pickup
      this.addPickup(depletedGun);
    }
  }

  /**
   * After physics step: detect bullet collisions via swept raycasts.
   *
   * For each bullet, cast a ray from its previous position to its current
   * position. If the ray hits map geometry (fixed body), the bullet stops
   * at the impact point. If it passes through a player's capsule, apply
   * damage. This is far more reliable than contactPairsWith for fast
   * projectiles against trimeshes.
   */
  private processBulletHits(now: number): void {
    const bulletsToRemove = new Set<ActiveBullet>();

    for (const bullet of this.activeBullets) {
      if (now - bullet.spawnTime > BULLET_MAX_AGE_MS) {
        bulletsToRemove.add(bullet);
        continue;
      }

      const pos = bullet.rigidBody.translation();

      // Range check
      const distSq = (pos.x - bullet.fromX) ** 2 + (pos.z - bullet.fromZ) ** 2;
      const maxRange = WEAPON_STATS[bullet.weaponType]?.range ?? 50;
      if (distSq > (maxRange + 5) ** 2) {
        bulletsToRemove.add(bullet);
        continue;
      }

      // Swept raycast from previous position to current position
      const dx = pos.x - bullet.prevX;
      const dy = pos.y - bullet.prevY;
      const dz = pos.z - bullet.prevZ;
      const travelDist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (travelDist < 0.001) {
        // Update prev position
        bullet.prevX = pos.x;
        bullet.prevY = pos.y;
        bullet.prevZ = pos.z;
        continue;
      }

      const dirX = dx / travelDist;
      const dirY = dy / travelDist;
      const dirZ = dz / travelDist;

      const ray = new this.rapier.Ray(
        { x: bullet.prevX, y: bullet.prevY, z: bullet.prevZ },
        { x: dirX, y: dirY, z: dirZ },
      );

      // Cast ray -- this hits ALL colliders (map + players)
      const hit = this.world.castRay(ray, travelDist, true);

      let hitPlayerId: string | null = null;
      let hitMap = false;
      let hitX = pos.x;
      let hitZ = pos.z;

      if (hit) {
        const hitBody = hit.collider.parent();
        if (hitBody) {
          if (hitBody.isFixed()) {
            // Hit map geometry
            hitMap = true;
            hitX = bullet.prevX + dirX * hit.timeOfImpact;
            hitZ = bullet.prevZ + dirZ * hit.timeOfImpact;
          } else if (hitBody.isKinematic()) {
            // Check if this is a player body (not ourselves)
            for (const [pid, pb] of this.playerBodies) {
              if (pb.rigidBody.handle === hitBody.handle && pid !== bullet.ownerId) {
                const victim = this.match!.players.get(pid);
                if (victim && victim.alive) {
                  hitPlayerId = pid;
                  hitX = bullet.prevX + dirX * hit.timeOfImpact;
                  hitZ = bullet.prevZ + dirZ * hit.timeOfImpact;
                }
                break;
              }
            }
          }
        }
      }

      // Also check proximity to player capsules (backup for narrow misses)
      if (!hitPlayerId && !hitMap) {
        for (const [pid, pb] of this.playerBodies) {
          if (pid === bullet.ownerId) continue;
          const victim = this.match!.players.get(pid);
          if (!victim || !victim.alive) continue;
          const pdx = victim.x - pos.x;
          const pdz = victim.z - pos.z;
          const pDist = Math.sqrt(pdx * pdx + pdz * pdz);
          if (pDist < PLAYER_CAPSULE_RADIUS + BULLET_RADIUS + 0.3) {
            hitPlayerId = pid;
            hitX = pos.x;
            hitZ = pos.z;
            break;
          }
        }
      }

      if (hitPlayerId) {
        const victim = this.match!.players.get(hitPlayerId)!;
        const shooter = this.match!.players.get(bullet.ownerId);
        const killed = damagePlayer(victim, bullet.damage, bullet.ownerId);
        if (killed && shooter) {
          shooter.kills++;
          this.handlePlayerDeath(victim);
        }
        this.onHitCallback?.({
          shooterId: bullet.ownerId,
          victimId: hitPlayerId,
          fromX: bullet.fromX,
          fromZ: bullet.fromZ,
          toX: hitX,
          toZ: hitZ,
          weapon: bullet.weaponType,
          damage: bullet.damage,
          killed,
        });
        this.onShotCallback?.({
          shooterId: bullet.ownerId,
          fromX: bullet.fromX,
          fromZ: bullet.fromZ,
          toX: hitX,
          toZ: hitZ,
          weapon: bullet.weaponType,
          hit: true,
        });
        bulletsToRemove.add(bullet);
      } else if (hitMap) {
        this.onShotCallback?.({
          shooterId: bullet.ownerId,
          fromX: bullet.fromX,
          fromZ: bullet.fromZ,
          toX: hitX,
          toZ: hitZ,
          weapon: bullet.weaponType,
          hit: true,
        });
        bulletsToRemove.add(bullet);
      }

      // Update previous position for next frame
      bullet.prevX = pos.x;
      bullet.prevY = pos.y;
      bullet.prevZ = pos.z;
    }

    for (const bullet of bulletsToRemove) {
      this.removeBullet(bullet);
    }
    this.activeBullets = this.activeBullets.filter((b) => !bulletsToRemove.has(b));
  }

  private removeBullet(bullet: ActiveBullet): void {
    try {
      this.world.removeRigidBody(bullet.rigidBody);
    } catch (_) {}
  }

  private handleMelee(player: ShooterPlayer, now: number): void {
    const stats = WEAPON_STATS[WEAPON_TYPES.KNIFE];
    if (!canFire(WEAPON_TYPES.KNIFE, null, player.lastShotTime, now)) return;

    player.lastShotTime = now;

    // Use a generous melee range (knife range + 1.5) so knife bots connect when circling
    const meleeReach = stats.range + 1.5;

    // Find closest enemy within melee range -- no facing check (melee is 360 degrees)
    // This prevents issues where the bot is right next to an enemy but facing slightly wrong
    let closestDist = meleeReach;
    let closestVictim: ShooterPlayer | null = null;

    for (const other of this.match!.players.values()) {
      if (other.id === player.id || !other.alive) continue;
      const dx = other.x - player.x;
      const dz = other.z - player.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > meleeReach) continue;

      if (dist < closestDist) {
        closestDist = dist;
        closestVictim = other;
      }
    }

    if (closestVictim) {
      // Raycast to check line of sight (can't knife through walls)
      const rayY = this.getPlayerRayHeight(player.id);
      const origin = { x: player.x, y: rayY, z: player.z };
      const dx = closestVictim.x - player.x;
      const dz = closestVictim.z - player.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const dirNorm = dist > 1e-6 ? dist : 1;
      const direction = { x: dx / dirNorm, y: 0, z: dz / dirNorm };
      const ray = new this.rapier.Ray(origin, direction);

      const hit = this.world.castRay(
        ray,
        dist + 0.5,
        true,
        undefined,
        undefined,
        undefined,
        this.playerBodies.get(player.id)?.rigidBody,
      );

      // Block only if a fixed (map) body is between attacker and victim
      if (hit) {
        const hitBody = hit.collider.parent();
        if (hitBody && hitBody.isFixed() && hit.timeOfImpact < dist * 0.9) {
          return; // Wall between attacker and victim
        }
        // Don't block melee because of other players' bodies
      }

      const killed = damagePlayer(closestVictim, stats.damage, player.id);
      if (killed) {
        player.kills++;
        this.handlePlayerDeath(closestVictim);
      }

      this.onHitCallback?.({
        shooterId: player.id,
        victimId: closestVictim.id,
        fromX: player.x,
        fromZ: player.z,
        toX: closestVictim.x,
        toZ: closestVictim.z,
        weapon: WEAPON_TYPES.KNIFE,
        damage: stats.damage,
        killed,
      });
    }
  }

  private handlePickup(player: ShooterPlayer): void {
    if (!this.match) return;

    let closestDist = PICKUP_RADIUS;
    let closestPickup: WeaponPickup | null = null;

    for (const pickup of this.match.pickups) {
      if (pickup.taken) continue;
      const dx = pickup.x - player.x;
      const dz = pickup.z - player.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < closestDist) {
        closestDist = dist;
        closestPickup = pickup;
      }
    }

    if (closestPickup) {
      // If player already has a gun, drop it as a new pickup
      if (player.weapon !== WEAPON_TYPES.KNIFE) {
        const droppedType = dropWeapon(player);
        if (droppedType) {
          this.addPickup(droppedType, player.x, player.y, player.z);
        }
      }
      pickupWeapon(player, closestPickup);
      closestPickup.taken = true;
    }
  }

  private handlePlayerDeath(player: ShooterPlayer): void {
    const droppedType = dropWeapon(player);
    if (droppedType) {
      this.addPickup(droppedType);
    }

    // Move Rapier body far away (will be repositioned on respawn)
    const body = this.playerBodies.get(player.id);
    if (body) {
      body.rigidBody.setNextKinematicTranslation({ x: 1000, y: -100, z: 1000 });
    }

    this.moveIntents.delete(player.id);
  }

  // ── Respawns ──────────────────────────────────────────────────────

  private handleRespawns(now: number): void {
    if (!this.match) return;

    for (const player of this.match.players.values()) {
      if (player.alive || player.eliminated || !player.diedAt) continue;
      if (now - player.diedAt < RESPAWN_DELAY_MS) continue;

      // Use deterministic spawn per player so respawned bots don't jump between spawn points
      const spawn = this.getRespawnSpawnPoint(player.id);

      if (respawnPlayer(player, spawn)) {
        player.y = this.arenaFloorY; // Constant floor Y
        const body = this.playerBodies.get(player.id);
        if (body) {
          const bodyY = this.arenaFloorY + PLAYER_CAPSULE_HALF_HEIGHT + PLAYER_CAPSULE_RADIUS;
          const pos = { x: spawn.x, y: bodyY, z: spawn.z };
          body.rigidBody.setNextKinematicTranslation(pos);
          body.rigidBody.setTranslation(pos, true);
        }
      }
    }
  }

  // ── Win condition ─────────────────────────────────────────────────

  private checkWinCondition(): void {
    if (!this.match || this.match.phase !== 'active') return;

    const withLives = [...this.match.players.values()].filter(
      (p) => p.lives > 0 && !p.eliminated,
    );

    if (withLives.length <= 1 && this.match.players.size > 1) {
      this.stopMatch();
      this.onMatchEndCallback?.();
    }
  }

  // ── Pickups ───────────────────────────────────────────────────────

  private spawnInitialPickups(): void {
    if (!this.match) return;

    const spawnPoints = this.mapGeometry.spawnPoints;
    const alivePlayers = [...this.match.players.values()].filter((p) => p.alive);
    const pickupsSoFar = this.match.pickups.map((p) => ({ x: p.x, y: p.y, z: p.z }));

    // Spawn one gun per bot so total guns == player count at all times
    const pickupCount = Math.max(INITIAL_WEAPON_PICKUPS, this.match.players.size);
    for (let i = 0; i < pickupCount; i++) {
      const occupied = getOccupiedSpawnIndices(spawnPoints, alivePlayers, pickupsSoFar);
      let x: number; let y: number; let z: number;

      const spawn = pickUnoccupiedSpawnPoint(spawnPoints, occupied);
      if (spawn) {
        x = spawn.x;
        y = spawn.y;
        z = spawn.z;
      } else {
        const randomEmpty = randomArenaPointInEmptySpace(
          (px, py, pz, r) => this.isPointInEmptySpace(px, py, pz, r),
          PICKUP_RADIUS,
        );
        if (randomEmpty) {
          x = randomEmpty.x; y = randomEmpty.y; z = randomEmpty.z;
        } else {
          const fallback = randomArenaPoint();
          x = fallback.x; y = fallback.y; z = fallback.z;
        }
      }

      pickupsSoFar.push({ x, y, z });
      const weaponType = GUN_TYPES[i % GUN_TYPES.length];
      this.match.pickups.push({
        id: `pickup-${i}-${Date.now()}`,
        type: weaponType,
        x,
        y,
        z,
        taken: false,
      });
    }
  }

  /**
   * Add a weapon pickup. If x,y,z are provided (e.g. weapon swap), use that position.
   * Otherwise (e.g. death drop) place at an unoccupied spawn or random empty space.
   */
  private addPickup(type: WeaponType, x?: number, y?: number, z?: number): void {
    if (!this.match) return;

    if (x !== undefined && y !== undefined && z !== undefined) {
      this.match.pickups.push({
        id: `drop-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        type,
        x,
        y,
        z,
        taken: false,
      });
      return;
    }

    const spawnPoints = this.mapGeometry.spawnPoints;
    const alivePlayers = [...this.match.players.values()].filter((p) => p.alive);
    const pickups = this.match.pickups.filter((p) => !p.taken).map((p) => ({ x: p.x, y: p.y, z: p.z }));
    const occupied = getOccupiedSpawnIndices(spawnPoints, alivePlayers, pickups);

    let px: number; let py: number; let pz: number;
    const spawn = pickUnoccupiedSpawnPoint(spawnPoints, occupied);
    if (spawn) {
      px = spawn.x; py = spawn.y; pz = spawn.z;
    } else {
      const randomEmpty = randomArenaPointInEmptySpace(
        (ax, ay, az, r) => this.isPointInEmptySpace(ax, ay, az, r),
        PICKUP_RADIUS,
      );
      if (randomEmpty) {
        px = randomEmpty.x; py = randomEmpty.y; pz = randomEmpty.z;
      } else {
        const fallback = randomArenaPoint();
        px = fallback.x; py = fallback.y; pz = fallback.z;
      }
    }

    this.match.pickups.push({
      id: `drop-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type,
      x: px,
      y: py,
      z: pz,
      taken: false,
    });
  }

  // ── Rapier body management ────────────────────────────────────────

  private createPlayerBody(player: ShooterPlayer): void {
    const bodyDesc = this.rapier.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(
        player.x,
        player.y + PLAYER_CAPSULE_HALF_HEIGHT + PLAYER_CAPSULE_RADIUS,
        player.z,
      );
    const rigidBody = this.world.createRigidBody(bodyDesc);

    const colliderDesc = this.rapier.ColliderDesc.capsule(
      PLAYER_CAPSULE_HALF_HEIGHT,
      PLAYER_CAPSULE_RADIUS,
    );
    const collider = this.world.createCollider(colliderDesc, rigidBody);

    this.playerBodies.set(player.id, { rigidBody, collider });
  }

  private removePlayerBody(playerId: string): void {
    const body = this.playerBodies.get(playerId);
    if (body) {
      this.world.removeRigidBody(body.rigidBody);
      this.playerBodies.delete(playerId);
    }
  }

  // ── State broadcast ───────────────────────────────────────────────

  private broadcastState(): void {
    if (!this.match || !this.onTickCallback) return;

    const timeRemaining = Math.max(0, (this.match.endTime - Date.now()) / 1000);

    const players = [...this.match.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      character: p.character,
      personality: p.personality,
      x: Math.round(p.x * 100) / 100,
      y: Math.round(p.y * 100) / 100,
      z: Math.round(p.z * 100) / 100,
      angle: Math.round(p.angle * 10) / 10,
      health: p.health,
      lives: p.lives,
      weapon: p.weapon,
      ammo: p.ammo,
      kills: p.kills,
      deaths: p.deaths,
      alive: p.alive,
      eliminated: p.eliminated,
      survivalTime: Math.round(getTotalSurvivalSeconds(p) * 10) / 10,
    }));

    const pickups = this.match.pickups
      .filter((p) => !p.taken)
      .map((p) => ({
        id: p.id,
        type: p.type,
        x: Math.round(p.x * 100) / 100,
        y: Math.round(p.y * 100) / 100,
        z: Math.round(p.z * 100) / 100,
      }));

    const bullets = this.activeBullets.map((b) => {
      const pos = b.rigidBody.translation();
      return {
        id: b.id,
        x: Math.round(pos.x * 100) / 100,
        y: Math.round(pos.y * 100) / 100,
        z: Math.round(pos.z * 100) / 100,
        fromX: b.fromX,
        fromY: b.fromY,
        fromZ: b.fromZ,
        ownerId: b.ownerId,
        weapon: b.weaponType,
      };
    });

    this.onTickCallback({
      matchId: this.match.id,
      phase: this.match.phase,
      tick: this.match.tick,
      timeRemaining: Math.round(timeRemaining * 10) / 10,
      players,
      pickups,
      bullets,
    });
  }

  // ── Public getters ────────────────────────────────────────────────

  getPlayer(playerId: string): ShooterPlayer | undefined {
    return this.match?.players.get(playerId);
  }

  getSpectatorState(): ShooterSpectatorState | null {
    if (!this.match) return null;

    const timeRemaining = this.match.phase === 'active'
      ? Math.max(0, (this.match.endTime - Date.now()) / 1000)
      : 0;

    const players = [...this.match.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      character: p.character,
      personality: p.personality,
      x: Math.round(p.x * 100) / 100,
      y: Math.round(p.y * 100) / 100,
      z: Math.round(p.z * 100) / 100,
      angle: Math.round(p.angle * 10) / 10,
      health: p.health,
      lives: p.lives,
      weapon: p.weapon,
      ammo: p.ammo,
      kills: p.kills,
      deaths: p.deaths,
      alive: p.alive,
      eliminated: p.eliminated,
      survivalTime: Math.round(getTotalSurvivalSeconds(p) * 10) / 10,
    }));

    const pickups = this.match.pickups
      .filter((p) => !p.taken)
      .map((p) => ({
        id: p.id,
        type: p.type,
        x: Math.round(p.x * 100) / 100,
        y: Math.round(p.y * 100) / 100,
        z: Math.round(p.z * 100) / 100,
      }));

    const bullets = this.activeBullets.map((b) => {
      const pos = b.rigidBody.translation();
      return {
        id: b.id,
        x: Math.round(pos.x * 100) / 100,
        y: Math.round(pos.y * 100) / 100,
        z: Math.round(pos.z * 100) / 100,
        fromX: b.fromX,
        fromY: b.fromY,
        fromZ: b.fromZ,
        ownerId: b.ownerId,
        weapon: b.weaponType,
      };
    });

    return {
      matchId: this.match.id,
      phase: this.match.phase,
      tick: this.match.tick,
      timeRemaining: Math.round(timeRemaining * 10) / 10,
      players,
      pickups,
      bullets,
    };
  }

  /** Build the leaderboard sorted by survival time (desc), then KDA (desc), then kills (desc). */
  getLeaderboard(): { id: string; name: string; character: string; kills: number; deaths: number; survivalTime: number }[] {
    if (!this.match) return [];
    return [...this.match.players.values()]
      .map((p) => ({
        id: p.id,
        name: p.name,
        character: p.character ?? 'G_1',
        kills: p.kills,
        deaths: p.deaths,
        survivalTime: Math.round(getTotalSurvivalSeconds(p) * 10) / 10,
      }))
      .sort((a, b) => {
        // Primary: survival time (desc)
        if (Math.abs(b.survivalTime - a.survivalTime) > 0.5) return b.survivalTime - a.survivalTime;
        // Secondary: KDA (kills - deaths) desc
        const kdaA = a.kills - a.deaths;
        const kdaB = b.kills - b.deaths;
        if (kdaA !== kdaB) return kdaB - kdaA;
        // Tertiary: kills desc
        return b.kills - a.kills;
      });
  }
}
