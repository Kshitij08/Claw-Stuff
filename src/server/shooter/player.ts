/**
 * Player entity helpers for the shooter game engine.
 * Creates, updates, damages, kills, and respawns ShooterPlayer objects.
 */

import type { ShooterPlayer, WeaponPickup } from '../../shared/shooter-types.js';
import {
  WEAPON_TYPES,
  WEAPON_STATS,
  HEALTH_PER_LIFE,
  LIVES_PER_PLAYER,
  ARENA_MIN_X,
  ARENA_MAX_X,
  ARENA_MIN_Z,
  ARENA_MAX_Z,
  MIN_SPAWN_SEPARATION,
  type WeaponType,
  type PersonalityType,
} from '../../shared/shooter-constants.js';
import type { SpawnPoint } from './glb-loader.js';

const BOT_CHARACTERS = Array.from({ length: 10 }, (_, i) => `G_${i + 1}`);
let characterIndex = 0;

export function resetCharacterIndex(): void {
  characterIndex = 0;
}

/** Create a new player at a given spawn point. */
export function createPlayer(
  id: string,
  name: string,
  spawn: SpawnPoint,
  strategyTag?: string,
  options?: { personality?: PersonalityType; isAI?: boolean },
): ShooterPlayer {
  return {
    id,
    name,
    strategyTag,
    x: spawn.x,
    y: spawn.y,
    z: spawn.z,
    angle: Math.random() * 360,
    health: HEALTH_PER_LIFE,
    lives: LIVES_PER_PLAYER,
    weapon: WEAPON_TYPES.KNIFE,
    ammo: null,
    kills: 0,
    deaths: 0,
    alive: true,
    eliminated: false,
    character: BOT_CHARACTERS[characterIndex++ % BOT_CHARACTERS.length],
    personality: options?.personality,
    isAI: options?.isAI ?? false,
    aliveSince: Date.now(),
    survivalTime: 0,
    diedAt: null,
    lastShotTime: 0,
  };
}

/** Apply damage to a player. Returns true if this hit killed them. */
export function damagePlayer(
  player: ShooterPlayer,
  damage: number,
  killerId: string,
): boolean {
  if (!player.alive || player.eliminated) return false;

  player.health -= damage;
  if (player.health <= 0) {
    player.health = 0;
    killPlayer(player);

    // Credit the killer
    // (killerId handled by caller on the killer's player object)
    return true;
  }
  return false;
}

/** Mark a player as dead. Decrements lives, records survival time. */
function killPlayer(player: ShooterPlayer): void {
  player.alive = false;
  player.deaths++;
  player.lives--;
  player.diedAt = Date.now();

  // Accumulate survival time for this life
  const lifeMs = Date.now() - player.aliveSince;
  player.survivalTime += lifeMs / 1000;

  if (player.lives <= 0) {
    player.eliminated = true;
  }
}

/** Respawn a dead (but not eliminated) player. Returns false if not ready. */
export function respawnPlayer(
  player: ShooterPlayer,
  spawn: SpawnPoint,
): boolean {
  if (player.eliminated || player.alive) return false;

  player.x = spawn.x;
  player.y = spawn.y;
  player.z = spawn.z;
  player.angle = Math.random() * 360;
  player.health = HEALTH_PER_LIFE;
  player.weapon = WEAPON_TYPES.KNIFE;
  player.ammo = null;
  player.alive = true;
  player.diedAt = null;
  player.aliveSince = Date.now();
  player.lastShotTime = 0;
  return true;
}

/** Pick up a weapon from the ground. */
export function pickupWeapon(player: ShooterPlayer, pickup: WeaponPickup): void {
  const stats = WEAPON_STATS[pickup.type];
  if (!stats) return;
  player.weapon = pickup.type;
  player.ammo = stats.ammo;
}

/** Drop the current weapon on death (returns the type to create a pickup, or null if knife). */
export function dropWeapon(player: ShooterPlayer): WeaponType | null {
  if (player.weapon === WEAPON_TYPES.KNIFE) return null;
  const dropped = player.weapon;
  player.weapon = WEAPON_TYPES.KNIFE;
  player.ammo = null;
  return dropped;
}

/** Get total survival time including current life if alive. */
export function getTotalSurvivalSeconds(player: ShooterPlayer): number {
  if (player.alive) {
    return player.survivalTime + (Date.now() - player.aliveSince) / 1000;
  }
  return player.survivalTime;
}

// ── Spawn helpers ──────────────────────────────────────────────────

/** Distance within which an entity (player or pickup) is considered to occupy a spawn point. */
const SPAWN_OCCUPANCY_RADIUS = 2.5;

/**
 * Get the set of spawn point indices that are occupied by any alive player or untaken pickup.
 * Used so we never spawn two players or two weapons at the same spawn.
 */
export function getOccupiedSpawnIndices(
  spawnPoints: SpawnPoint[],
  players: ShooterPlayer[],
  pickups: { x: number; y: number; z: number }[],
): Set<number> {
  const occupied = new Set<number>();
  const r2 = SPAWN_OCCUPANCY_RADIUS * SPAWN_OCCUPANCY_RADIUS;

  for (let i = 0; i < spawnPoints.length; i++) {
    const sp = spawnPoints[i];
    for (const p of players) {
      if (!p.alive) continue;
      const dx = sp.x - p.x, dz = sp.z - p.z;
      if (dx * dx + dz * dz <= r2) {
        occupied.add(i);
        break;
      }
    }
    if (occupied.has(i)) continue;
    for (const pk of pickups) {
      const dx = sp.x - pk.x, dz = sp.z - pk.z;
      if (dx * dx + dz * dz <= r2) {
        occupied.add(i);
        break;
      }
    }
  }
  return occupied;
}

/**
 * Pick an unoccupied spawn point (players prioritized: call this for players first, then weapons).
 * Returns null if all spawns are occupied.
 */
export function pickUnoccupiedSpawnPoint(
  spawnPoints: SpawnPoint[],
  occupiedIndices: Set<number>,
): SpawnPoint | null {
  if (spawnPoints.length === 0) return null;
  for (let i = 0; i < spawnPoints.length; i++) {
    if (!occupiedIndices.has(i)) return spawnPoints[i];
  }
  return null;
}

/**
 * Pick a random unoccupied spawn point. Used for respawns so players don't always get the same spawn.
 * Returns null if all spawns are occupied.
 */
export function pickRandomUnoccupiedSpawnPoint(
  spawnPoints: SpawnPoint[],
  occupiedIndices: Set<number>,
): SpawnPoint | null {
  if (spawnPoints.length === 0) return null;
  const available: SpawnPoint[] = [];
  for (let i = 0; i < spawnPoints.length; i++) {
    if (!occupiedIndices.has(i)) available.push(spawnPoints[i]);
  }
  if (available.length === 0) return null;
  return available[Math.floor(Math.random() * available.length)];
}

/**
 * Pick the best spawn point that is far from all alive players.
 * Prefers unoccupied spawn points; falls back to random if none or all occupied.
 */
export function pickSpawnPoint(
  spawnPoints: SpawnPoint[],
  alivePlayers: ShooterPlayer[],
  occupiedIndices?: Set<number>,
): SpawnPoint {
  if (spawnPoints.length === 0) {
    return randomArenaPoint();
  }
  if (occupiedIndices !== undefined) {
    const sp = pickUnoccupiedSpawnPoint(spawnPoints, occupiedIndices);
    if (sp) return sp;
  }

  // Fallback: score by distance to alive players (higher = better)
  let bestSpawn = spawnPoints[0];
  let bestMinDist = -1;
  for (const sp of spawnPoints) {
    let minDist = Infinity;
    for (const p of alivePlayers) {
      const dx = sp.x - p.x, dz = sp.z - p.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < minDist) minDist = dist;
    }
    if (minDist > bestMinDist) {
      bestMinDist = minDist;
      bestSpawn = sp;
    }
  }
  return bestSpawn;
}

/** Default floor Y, updated by engine from spawn point data. */
let defaultFloorY = 0;

/** Playable area bounds derived from spawn points (much tighter than arena bounds). */
let playableMinX = ARENA_MIN_X;
let playableMaxX = ARENA_MAX_X;
let playableMinZ = ARENA_MIN_Z;
let playableMaxZ = ARENA_MAX_Z;

export function setDefaultFloorY(y: number): void {
  defaultFloorY = y;
}

/**
 * Set the playable area to the bounding box of GLB spawn points + margin.
 * Random positions will be constrained to this area instead of the full arena.
 */
export function setPlayableBounds(spawnPoints: SpawnPoint[]): void {
  if (spawnPoints.length === 0) return;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const sp of spawnPoints) {
    if (sp.x < minX) minX = sp.x;
    if (sp.x > maxX) maxX = sp.x;
    if (sp.z < minZ) minZ = sp.z;
    if (sp.z > maxZ) maxZ = sp.z;
  }
  const margin = 3;
  playableMinX = Math.max(ARENA_MIN_X, minX - margin);
  playableMaxX = Math.min(ARENA_MAX_X, maxX + margin);
  playableMinZ = Math.max(ARENA_MIN_Z, minZ - margin);
  playableMaxZ = Math.min(ARENA_MAX_Z, maxZ + margin);
}

export function randomArenaPoint(): SpawnPoint {
  return {
    x: playableMinX + Math.random() * (playableMaxX - playableMinX),
    y: defaultFloorY,
    z: playableMinZ + Math.random() * (playableMaxZ - playableMinZ),
  };
}

/**
 * Try to find a random point in the playable area that is in empty space (not inside/on map mesh).
 * checkEmpty(x, y, z) should return true if a sphere at that point does not intersect the map.
 * Returns a point or null after maxAttempts.
 */
export function randomArenaPointInEmptySpace(
  checkEmpty: (x: number, y: number, z: number, radius: number) => boolean,
  radius: number,
  maxAttempts = 50,
): SpawnPoint | null {
  for (let i = 0; i < maxAttempts; i++) {
    const x = playableMinX + Math.random() * (playableMaxX - playableMinX);
    const z = playableMinZ + Math.random() * (playableMaxZ - playableMinZ);
    const y = defaultFloorY;
    if (checkEmpty(x, y, z, radius)) return { x, y, z };
  }
  return null;
}

/** Generate spread spawn positions (min separation) for initial placement. */
export function generateSpreadSpawns(
  spawnPoints: SpawnPoint[],
  count: number,
): SpawnPoint[] {
  const result: SpawnPoint[] = [];
  const candidates = [...spawnPoints];

  for (const sp of candidates) {
    if (result.length >= count) break;
    const tooClose = result.some((r) => {
      const dx = r.x - sp.x;
      const dz = r.z - sp.z;
      return Math.sqrt(dx * dx + dz * dz) < MIN_SPAWN_SEPARATION;
    });
    if (!tooClose) result.push(sp);
  }

  // Fill remaining with random points
  let attempts = 0;
  while (result.length < count && attempts < 100) {
    attempts++;
    const p = randomArenaPoint();
    const tooClose = result.some((r) => {
      const dx = r.x - p.x;
      const dz = r.z - p.z;
      return Math.sqrt(dx * dx + dz * dz) < MIN_SPAWN_SEPARATION;
    });
    if (!tooClose) result.push(p);
  }

  return result;
}
