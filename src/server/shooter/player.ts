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

/**
 * Pick the best spawn point that is far from all alive players.
 * Falls back to random if no spawn points available.
 */
export function pickSpawnPoint(
  spawnPoints: SpawnPoint[],
  alivePlayers: ShooterPlayer[],
): SpawnPoint {
  if (spawnPoints.length === 0) {
    return randomArenaPoint();
  }

  // Score each spawn by minimum distance to any alive player (higher = better)
  let bestSpawn = spawnPoints[0];
  let bestMinDist = -1;

  for (const sp of spawnPoints) {
    let minDist = Infinity;
    for (const p of alivePlayers) {
      const dx = sp.x - p.x;
      const dz = sp.z - p.z;
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

function randomArenaPoint(): SpawnPoint {
  const margin = 5;
  return {
    x: ARENA_MIN_X + margin + Math.random() * (ARENA_MAX_X - ARENA_MIN_X - 2 * margin),
    y: 0,
    z: ARENA_MIN_Z + margin + Math.random() * (ARENA_MAX_Z - ARENA_MIN_Z - 2 * margin),
  };
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
