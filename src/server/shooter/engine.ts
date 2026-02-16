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
  MIN_DISTANCE_GUN_FROM_GUN,
  BULLET_RADIUS,
  BULLET_SPEED,
  BULLET_MAX_AGE_MS,
  BULLET_MASS,
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
  fromZ: number;
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

  /** Per-player desired movement direction. Persists until 'stop' action. */
  private moveIntents: Map<string, { angle: number }> = new Map();

  private onTickCallback: ((state: ShooterSpectatorState) => void) | null = null;
  private onShotCallback: ((shot: ShooterSpectatorShotEvent) => void) | null = null;
  private onHitCallback: ((hit: ShooterSpectatorHitEvent) => void) | null = null;
  private onMatchEndCallback: (() => void) | null = null;

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
    this.actionQueue = [];
    this.activeBullets = [];
    this.bulletIdCounter = 0;
    resetCharacterIndex();

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

  addPlayer(playerId: string, name: string, strategyTag?: string): ShooterPlayer | null {
    if (!this.match) return null;
    if (this.match.players.has(playerId)) return null;

    const spawnPoints = this.mapGeometry.spawnPoints;
    const alivePlayers = [...this.match.players.values()].filter((p) => p.alive);
    const pickups = this.match.pickups.filter((p) => !p.taken).map((p) => ({ x: p.x, y: p.y, z: p.z }));
    const occupied = getOccupiedSpawnIndices(spawnPoints, alivePlayers, pickups);

    let spawn = pickUnoccupiedSpawnPoint(spawnPoints, occupied) ?? null;
    if (!spawn && spawnPoints.length > 0) {
      spawn = pickSpawnPoint(spawnPoints, alivePlayers, occupied);
    }
    if (!spawn) {
      const randomEmpty = randomArenaPointInEmptySpace(
        (x, y, z, r) => this.isPointInEmptySpace(x, y, z, r),
        PLAYER_CAPSULE_RADIUS + 0.2,
      );
      spawn = randomEmpty ?? randomArenaPoint();
    }

    const player = createPlayer(playerId, name, spawn, strategyTag);
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
   * movement. We also try per-axis sliding to let players glide along walls.
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
    return !hitsMap;
  }

  private syncPositions(): void {
    if (!this.match) return;

    for (const [playerId, body] of this.playerBodies) {
      const player = this.match.players.get(playerId);
      if (!player) continue;

      const pos = body.rigidBody.translation();
      player.x = pos.x;
      player.y = pos.y;
      player.z = pos.z;

      // Clamp to arena bounds (safety net)
      player.x = Math.max(ARENA_MIN_X, Math.min(ARENA_MAX_X, player.x));
      player.z = Math.max(ARENA_MIN_Z, Math.min(ARENA_MAX_Z, player.z));
    }
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
    const gunHeight = player.y + PLAYER_CAPSULE_HALF_HEIGHT + 0.3;

    for (let i = 0; i < stats.pellets; i++) {
      const spreadAngle = aimAngle + (Math.random() - 0.5) * stats.spread * (180 / Math.PI);
      const rad = (spreadAngle * Math.PI) / 180;
      const dirX = Math.cos(rad);
      const dirZ = Math.sin(rad);

      const bulletId = `bullet_${++this.bulletIdCounter}_${Date.now()}`;
      const bodyDesc = this.rapier.RigidBodyDesc.dynamic()
        .setTranslation(player.x + dirX * 0.5, gunHeight, player.z + dirZ * 0.5)
        .setLinearDamping(0)
        .setCcdEnabled(true);
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
        fromX: player.x,
        fromZ: player.z,
      });
    }

    if (player.ammo !== null && player.ammo <= 0) {
      player.weapon = WEAPON_TYPES.KNIFE;
      player.ammo = null;
    }
  }

  /** After physics step: resolve bullet contacts, apply damage, remove hit/expired bullets. */
  private processBulletHits(now: number): void {
    const bulletsToRemove = new Set<ActiveBullet>();

    for (const bullet of this.activeBullets) {
      if (now - bullet.spawnTime > BULLET_MAX_AGE_MS) {
        bulletsToRemove.add(bullet);
        continue;
      }

      const pos = bullet.rigidBody.translation();
      const distSq = (pos.x - bullet.fromX) ** 2 + (pos.z - bullet.fromZ) ** 2;
      const maxRange = WEAPON_STATS[bullet.weaponType]?.range ?? 50;
      if (distSq > (maxRange + 5) ** 2) {
        bulletsToRemove.add(bullet);
        continue;
      }

      let hitPlayerId: string | null = null;
      let hitMap = false;

      this.world.contactPairsWith(bullet.collider, (other: RAPIER.Collider) => {
        const otherBody = other.parent();
        if (!otherBody) return;
        if (otherBody.isKinematic()) {
          for (const [pid, pb] of this.playerBodies) {
            if (pb.rigidBody.handle === otherBody.handle && pid !== bullet.ownerId) {
              const victim = this.match!.players.get(pid);
              if (victim && victim.alive) hitPlayerId = pid;
              return;
            }
          }
        } else if (otherBody.isFixed()) {
          hitMap = true;
        }
      });

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
          toX: pos.x,
          toZ: pos.z,
          weapon: bullet.weaponType,
          damage: bullet.damage,
          killed,
        });
        this.onShotCallback?.({
          shooterId: bullet.ownerId,
          fromX: bullet.fromX,
          fromZ: bullet.fromZ,
          toX: pos.x,
          toZ: pos.z,
          weapon: bullet.weaponType,
          hit: true,
        });
        bulletsToRemove.add(bullet);
      } else if (hitMap) {
        bulletsToRemove.add(bullet);
      }
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

    // Find closest enemy within melee range and in front of player
    const rad = (player.angle * Math.PI) / 180;
    const facingX = Math.cos(rad);
    const facingZ = Math.sin(rad);
    let closestDist = stats.range + 0.5;
    let closestVictim: ShooterPlayer | null = null;

    for (const other of this.match!.players.values()) {
      if (other.id === player.id || !other.alive) continue;
      const dx = other.x - player.x;
      const dz = other.z - player.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > stats.range + 0.5) continue;

      // Check roughly in front (dot product > 0)
      const dot = dx * facingX + dz * facingZ;
      if (dot < 0 && dist > 1) continue;

      if (dist < closestDist) {
        closestDist = dist;
        closestVictim = other;
      }
    }

    if (closestVictim) {
      // Raycast to check line of sight (can't knife through walls)
      const origin = { x: player.x, y: player.y + 1.0, z: player.z };
      const dx = closestVictim.x - player.x;
      const dz = closestVictim.z - player.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const direction = { x: dx / dist, y: 0, z: dz / dist };
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

      // If ray hits something closer than the victim, it's a wall
      if (hit && hit.timeOfImpact < dist * 0.9) {
        // Check it's not the victim's own collider
        const victimBody = this.playerBodies.get(closestVictim.id);
        if (!victimBody || hit.collider.handle !== victimBody.collider.handle) {
          return; // Blocked by wall
        }
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

      const spawnPoints = this.mapGeometry.spawnPoints;
      const alivePlayers = [...this.match.players.values()].filter((p) => p.alive);
      const pickups = this.match.pickups.filter((p) => !p.taken).map((p) => ({ x: p.x, y: p.y, z: p.z }));
      const occupied = getOccupiedSpawnIndices(spawnPoints, alivePlayers, pickups);

      let spawn = pickRandomUnoccupiedSpawnPoint(spawnPoints, occupied) ?? null;
      if (!spawn && spawnPoints.length > 0) {
        spawn = pickSpawnPoint(spawnPoints, alivePlayers, occupied);
      }
      if (!spawn) {
        const randomEmpty = randomArenaPointInEmptySpace(
          (x, y, z, r) => this.isPointInEmptySpace(x, y, z, r),
          PLAYER_CAPSULE_RADIUS + 0.2,
        );
        spawn = randomEmpty ?? randomArenaPoint();
      }

      if (respawnPlayer(player, spawn)) {
        const body = this.playerBodies.get(player.id);
        if (body) {
          body.rigidBody.setNextKinematicTranslation({
            x: spawn.x,
            y: spawn.y + PLAYER_CAPSULE_HALF_HEIGHT + PLAYER_CAPSULE_RADIUS,
            z: spawn.z,
          });
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

    for (let i = 0; i < INITIAL_WEAPON_PICKUPS; i++) {
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

  /** Build the leaderboard sorted by survival time (desc), then kills. */
  getLeaderboard(): { id: string; name: string; kills: number; deaths: number; survivalTime: number }[] {
    if (!this.match) return [];
    return [...this.match.players.values()]
      .map((p) => ({
        id: p.id,
        name: p.name,
        kills: p.kills,
        deaths: p.deaths,
        survivalTime: Math.round(getTotalSurvivalSeconds(p) * 10) / 10,
      }))
      .sort((a, b) => b.survivalTime - a.survivalTime || b.kills - a.kills);
  }
}
