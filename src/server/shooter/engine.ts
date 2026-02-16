/**
 * Server-side shooter game engine. Ticks at fixed interval; applies move, shoot, damage, respawn, pickups.
 * Uses Rapier3D for physics (building collision, player collision, arena walls).
 */

import {
  MAP_BOUNDS,
  WEAPON_TYPES,
  WEAPON_STATS,
  GUN_TYPES,
  LIVES_PER_PLAYER,
  HEALTH_PER_LIFE,
  TICK_MS,
  MOVEMENT_SPEED,
  PLAYER_COLLISION_RADIUS,
  INITIAL_WEAPON_PICKUPS,
  MIN_SPAWN_SEPARATION,
  MIN_DISTANCE_GUN_FROM_PLAYER,
  MIN_DISTANCE_GUN_FROM_GUN,
  SHOOTER_MATCH_DURATION,
  MAX_SHOOTER_PLAYERS,
  type WeaponType,
} from './constants.js';
import { ShooterPhysics, type BuildingBBox } from './physics.js';

export interface ShooterPlayer {
  id: string;
  name: string;
  x: number;
  z: number;
  angle: number; // radians, 0 = +z
  health: number;
  lives: number;
  weapon: WeaponType;
  ammo: number; // -1 for knife (unlimited)
  kills: number;
  score: number;
  alive: boolean;
  lastShotAt: number; // tick index
  /** Character/skin id e.g. G_1 */
  characterId?: string;
  /** True when player moved this tick (for client Run/Idle animation) */
  moving?: boolean;
}

/** Pending action from API (applied next tick) */
export interface ShooterAction {
  angle?: number; // radians
  shoot?: boolean;
  /** If true, player advances one tick in current angle direction. If omitted/false, player does not move. */
  move?: boolean;
}

export interface WeaponPickup {
  id: string;
  x: number;
  z: number;
  weaponType: WeaponType;
  taken: boolean;
}

export interface ShooterMatchState {
  id: string;
  phase: 'lobby' | 'countdown' | 'active' | 'finished';
  tick: number;
  startTime: number; // ms (when phase became active)
  endTime: number; // startTime + MATCH_DURATION
  players: Map<string, ShooterPlayer>;
  pickups: WeaponPickup[];
  /** Player id -> pending action (cleared each tick) */
  pendingActions: Map<string, ShooterAction>;
  /** Spawn points used at match start */
  spawnPoints: { x: number; z: number }[];
}

function distance(x1: number, z1: number, x2: number, z2: number): number {
  return Math.sqrt((x2 - x1) ** 2 + (z2 - z1) ** 2);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Generate spawn points and pickup positions */
function generateSpawnPoints(count: number): { x: number; z: number }[] {
  const points: { x: number; z: number }[] = [];
  const margin = 18;
  for (let i = 0; i < count * 3; i++) {
    const x = MAP_BOUNDS.minX + margin + Math.random() * (MAP_BOUNDS.maxX - MAP_BOUNDS.minX - 2 * margin);
    const z = MAP_BOUNDS.minZ + margin + Math.random() * (MAP_BOUNDS.maxZ - MAP_BOUNDS.minZ - 2 * margin);
    const ok = points.every((p) => distance(p.x, p.z, x, z) >= MIN_SPAWN_SEPARATION);
    if (ok) {
      points.push({ x, z });
      if (points.length >= count) break;
    }
  }
  return points;
}

function generatePickupPositions(
  spawnPoints: { x: number; z: number }[],
  occupied: { x: number; z: number }[],
  count: number
): { x: number; z: number }[] {
  const positions: { x: number; z: number }[] = [];
  const candidates = [...spawnPoints];
  for (let i = 0; i < count; i++) {
    const filtered = candidates.filter(
      (p) => occupied.every((o) => distance(p.x, p.z, o.x, o.z) >= MIN_DISTANCE_GUN_FROM_PLAYER)
    );
    const distFiltered =
      positions.length === 0
        ? filtered
        : filtered.filter((p) => positions.every((pos) => distance(p.x, p.z, pos.x, pos.z) >= MIN_DISTANCE_GUN_FROM_GUN));
    if (distFiltered.length === 0) break;
    const chosen = distFiltered[Math.floor(Math.random() * distFiltered.length)];
    positions.push(chosen);
  }
  return positions;
}

export class ShooterEngine {
  private state: ShooterMatchState | null = null;
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private onTickCallback: ((state: ShooterMatchState) => void) | null = null;
  private onMatchEndCallback: ((state: ShooterMatchState) => void) | null = null;
  private physics: ShooterPhysics = new ShooterPhysics();

  /** Initialize Rapier WASM and load map geometry. Call once at server startup. */
  async init(): Promise<void> {
    try {
      await this.physics.init();
      console.log('[ShooterEngine] Physics initialized successfully');
    } catch (err) {
      console.error('[ShooterEngine] Physics initialization failed, falling back to simple movement:', err);
    }
  }

  /** Whether Rapier physics is active (false = fallback to simple bounds-only movement) */
  get physicsReady(): boolean {
    return this.physics.isReady();
  }

  /** Building bounding boxes for API exposure */
  getBuildingBBoxes(): BuildingBBox[] {
    return this.physics.getBuildingBBoxes();
  }

  createMatch(matchId: string): ShooterMatchState {
    if (this.state && this.state.phase !== 'finished') {
      throw new Error('Match already in progress');
    }

    // Clean up any lingering Rapier player bodies from a previous match
    this.physics.resetPlayers();

    const spawnPoints = this.generateValidSpawnPoints(MAX_SHOOTER_PLAYERS);
    const state: ShooterMatchState = {
      id: matchId,
      phase: 'lobby',
      tick: 0,
      startTime: 0,
      endTime: 0,
      players: new Map(),
      pickups: [],
      pendingActions: new Map(),
      spawnPoints,
    };
    this.state = state;
    return state;
  }

  /** Generate spawn points that don't overlap with buildings */
  private generateValidSpawnPoints(count: number): { x: number; z: number }[] {
    const points: { x: number; z: number }[] = [];
    const margin = 18;
    const maxAttempts = count * 10;
    for (let i = 0; i < maxAttempts; i++) {
      const x = MAP_BOUNDS.minX + margin + Math.random() * (MAP_BOUNDS.maxX - MAP_BOUNDS.minX - 2 * margin);
      const z = MAP_BOUNDS.minZ + margin + Math.random() * (MAP_BOUNDS.maxZ - MAP_BOUNDS.minZ - 2 * margin);
      const ok = points.every((p) => distance(p.x, p.z, x, z) >= MIN_SPAWN_SEPARATION);
      if (!ok) continue;
      // Reject spawn points inside buildings (if physics is ready)
      if (this.physics.isReady() && this.physics.isInsideBuilding(x, z)) continue;
      points.push({ x, z });
      if (points.length >= count) break;
    }
    // Fallback: if we couldn't find enough valid points, fill with unvalidated ones
    if (points.length < count) {
      const fallback = generateSpawnPoints(count - points.length);
      points.push(...fallback);
    }
    return points;
  }

  getMatch(): ShooterMatchState | null {
    return this.state;
  }

  onTick(cb: (state: ShooterMatchState) => void): void {
    this.onTickCallback = cb;
  }

  onMatchEnd(cb: (state: ShooterMatchState) => void): void {
    this.onMatchEndCallback = cb;
  }

  startMatch(): void {
    if (!this.state || this.state.phase !== 'countdown') return;
    this.state.phase = 'active';
    this.state.startTime = Date.now();
    this.state.endTime = this.state.startTime + SHOOTER_MATCH_DURATION;

    const alivePlayers = Array.from(this.state.players.values()).filter((p) => p.lives > 0);
    const occupied = alivePlayers.map((p) => ({ x: p.x, z: p.z }));
    const pickupPositions = generatePickupPositions(
      this.state.spawnPoints,
      occupied,
      Math.min(INITIAL_WEAPON_PICKUPS, this.state.spawnPoints.length)
    );
    this.state.pickups = pickupPositions.map((pos, i) => ({
      id: `pickup-${i}-${Date.now()}`,
      x: pos.x,
      z: pos.z,
      weaponType: GUN_TYPES[i % GUN_TYPES.length],
      taken: false,
    }));

    this.tickInterval = setInterval(() => this.tick(), TICK_MS);
  }

  addPlayer(
    playerId: string,
    name: string,
    characterId?: string
  ): ShooterPlayer | null {
    const match = this.state;
    if (!match || match.phase !== 'lobby' || match.players.size >= MAX_SHOOTER_PLAYERS) return null;
    const idx = match.players.size;
    const spawn = match.spawnPoints[idx % match.spawnPoints.length] ?? { x: 0, z: 0 };
    const player: ShooterPlayer = {
      id: playerId,
      name,
      x: spawn.x,
      z: spawn.z,
      angle: 0,
      health: HEALTH_PER_LIFE,
      lives: LIVES_PER_PLAYER,
      weapon: WEAPON_TYPES.KNIFE,
      ammo: -1,
      kills: 0,
      score: 0,
      alive: true,
      lastShotAt: -9999,
      characterId: characterId ?? `G_1`,
    };
    match.players.set(playerId, player);

    // Create Rapier physics body for this player
    if (this.physics.isReady()) {
      this.physics.createPlayerBody(playerId, spawn.x, spawn.z);
    }

    return player;
  }

  setPhaseCountdown(): void {
    if (this.state && this.state.phase === 'lobby') {
      this.state.phase = 'countdown';
    }
  }

  setPendingAction(playerId: string, action: ShooterAction): void {
    if (!this.state) return;
    this.state.pendingActions.set(playerId, action);
  }

  private tick(): void {
    const match = this.state;
    if (!match || match.phase !== 'active') return;

    const now = Date.now();
    if (now >= match.endTime) {
      this.finishMatch();
      return;
    }

    match.tick += 1;

    // Apply pending actions: update angle and determine movement
    for (const [playerId, action] of match.pendingActions) {
      const player = match.players.get(playerId);
      if (!player || !player.alive) continue;
      if (action.angle !== undefined) {
        player.angle = action.angle;
      }
    }

    if (this.physics.isReady()) {
      // ── Rapier physics path: use KinematicCharacterController for proper collision ──

      const speed = MOVEMENT_SPEED * TICK_MS; // units per tick
      const debugTick = match.tick % 100 === 0;
      for (const player of match.players.values()) {
        if (!player.alive) {
          player.moving = false;
          continue;
        }
        const action = match.pendingActions.get(player.id);
        const wantsMove = action?.move === true;

        if (wantsMove) {
          // Compute desired movement in the player's facing direction
          const dx = Math.sin(player.angle) * speed;
          const dz = Math.cos(player.angle) * speed;

          if (debugTick) {
            console.log(`[tick ${match.tick}] ${player.name} wants move: angle=${player.angle.toFixed(2)} dx=${dx.toFixed(3)} dz=${dz.toFixed(3)} pos=(${player.x.toFixed(2)}, ${player.z.toFixed(2)})`);
          }

          // movePlayer uses KinematicCharacterController to slide along walls
          const newPos = this.physics.movePlayer(player.id, dx, dz);
          if (newPos) {
            const prevX = player.x;
            const prevZ = player.z;
            player.x = newPos.x;
            player.z = newPos.z;
            player.moving = Math.abs(player.x - prevX) > 0.001 || Math.abs(player.z - prevZ) > 0.001;

            if (debugTick) {
              console.log(`  -> newPos=(${newPos.x.toFixed(2)}, ${newPos.z.toFixed(2)}) moving=${player.moving}`);
            }
          } else {
            player.moving = false;
            if (debugTick) console.log(`  -> movePlayer returned null`);
          }
        } else {
          player.moving = false;
          if (debugTick) console.log(`[tick ${match.tick}] ${player.name} move=false`);
        }
      }

      // Step the world to finalize kinematic body positions
      this.physics.stepWorld();

    } else {
      // ── Fallback: simple movement without physics (no building collision) ──

      const speed = MOVEMENT_SPEED * TICK_MS; // units per tick
      for (const player of match.players.values()) {
        if (!player.alive) continue;
        const action = match.pendingActions.get(player.id);
        const wantsMove = action?.move === true;
        if (wantsMove) {
          const prevX = player.x;
          const prevZ = player.z;
          player.x += Math.sin(player.angle) * speed;
          player.z += Math.cos(player.angle) * speed;
          player.x = clamp(player.x, MAP_BOUNDS.minX, MAP_BOUNDS.maxX);
          player.z = clamp(player.z, MAP_BOUNDS.minZ, MAP_BOUNDS.maxZ);
          player.moving = player.x !== prevX || player.z !== prevZ;
        } else {
          player.moving = false;
        }
      }

      // Player-player collision: push overlapping players apart (fallback only)
      const alivePlayers = Array.from(match.players.values()).filter((p) => p.alive);
      const minDist = PLAYER_COLLISION_RADIUS * 2;
      for (let i = 0; i < alivePlayers.length; i++) {
        for (let j = i + 1; j < alivePlayers.length; j++) {
          const a = alivePlayers[i];
          const b = alivePlayers[j];
          const dx = b.x - a.x;
          const dz = b.z - a.z;
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist < minDist && dist > 0.001) {
            const overlap = (minDist - dist) / 2;
            const nx = dx / dist;
            const nz = dz / dist;
            a.x -= nx * overlap;
            a.z -= nz * overlap;
            b.x += nx * overlap;
            b.z += nz * overlap;
            a.x = clamp(a.x, MAP_BOUNDS.minX, MAP_BOUNDS.maxX);
            a.z = clamp(a.z, MAP_BOUNDS.minZ, MAP_BOUNDS.maxZ);
            b.x = clamp(b.x, MAP_BOUNDS.minX, MAP_BOUNDS.maxX);
            b.z = clamp(b.z, MAP_BOUNDS.minZ, MAP_BOUNDS.maxZ);
          }
        }
      }
    }

    // Process shoots (from same tick's pending actions)
    for (const [playerId, action] of match.pendingActions) {
      if (!action.shoot) continue;
      const player = match.players.get(playerId);
      if (!player || !player.alive) continue;
      const stats = WEAPON_STATS[player.weapon];
      if (!stats) continue;
      if (stats.ammo !== null && player.ammo <= 0) continue;
      const fireRateTicks = stats.fireRate / TICK_MS;
      if (match.tick - player.lastShotAt < fireRateTicks) continue;

      player.lastShotAt = match.tick;
      if (stats.ammo !== null) player.ammo -= 1;

      // Hit check: find closest enemy in range (wider cone for melee)
      const range = stats.range;
      const hitCone = stats.isMelee ? 0.8 : 0.4; // radians – melee ~46°, ranged ~23°
      let bestTarget: ShooterPlayer | null = null;
      let bestDist = range + 1;
      for (const other of match.players.values()) {
        if (other.id === player.id || !other.alive) continue;
        const d = distance(player.x, player.z, other.x, other.z);
        if (d >= bestDist) continue;
        const angleTo = Math.atan2(other.x - player.x, other.z - player.z);
        let diff = Math.abs(angleTo - player.angle);
        if (diff > Math.PI) diff = 2 * Math.PI - diff;
        if (diff < hitCone) {
          bestDist = d;
          bestTarget = other;
        }
      }
      if (bestTarget) {
        bestTarget.health -= stats.damage;
        if (bestTarget.health <= 0) {
          bestTarget.alive = false;
          bestTarget.lives -= 1;
          player.kills += 1;
          player.score += 100;
          if (bestTarget.lives > 0) {
            this.respawn(bestTarget, match);
          }
        }
      }
    }

    // Consume shoot flag after processing (prevents infinite shooting from stale actions)
    // but keep move + angle so movement persists between agent action sends
    for (const [, action] of match.pendingActions) {
      action.shoot = false;
    }

    // Pickups
    for (const pickup of match.pickups) {
      if (pickup.taken) continue;
      for (const player of match.players.values()) {
        if (!player.alive) continue;
        if (distance(player.x, player.z, pickup.x, pickup.z) < 2) {
          pickup.taken = true;
          player.weapon = pickup.weaponType;
          const s = WEAPON_STATS[pickup.weaponType];
          player.ammo = s?.ammo ?? -1;
          break;
        }
      }
    }

    // Single winner check
    const alive = Array.from(match.players.values()).filter((p) => p.alive);
    if (alive.length <= 1 && match.players.size >= 2) {
      this.finishMatch();
      return;
    }

    if (this.onTickCallback) this.onTickCallback(match);
  }

  private respawn(player: ShooterPlayer, match: ShooterMatchState): void {
    const used = Array.from(match.players.values()).filter((p) => p.alive).map((p) => ({ x: p.x, z: p.z }));
    let spawn = match.spawnPoints[Math.floor(Math.random() * match.spawnPoints.length)];
    for (let i = 0; i < 20; i++) {
      const ok = used.every((u) => distance(u.x, u.z, spawn.x, spawn.z) >= MIN_SPAWN_SEPARATION);
      // Also avoid buildings on respawn
      const inBuilding = this.physics.isReady() && this.physics.isInsideBuilding(spawn.x, spawn.z);
      if (ok && !inBuilding) break;
      spawn = match.spawnPoints[Math.floor(Math.random() * match.spawnPoints.length)];
    }
    player.x = spawn.x;
    player.z = spawn.z;
    player.health = HEALTH_PER_LIFE;
    player.weapon = WEAPON_TYPES.KNIFE;
    player.ammo = -1;
    player.alive = true;

    // Teleport Rapier body to new spawn
    if (this.physics.isReady()) {
      this.physics.teleportPlayer(player.id, spawn.x, spawn.z);
    }
  }

  private finishMatch(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    if (!this.state) return;
    this.state.phase = 'finished';
    this.physics.resetPlayers();
    if (this.onMatchEndCallback) this.onMatchEndCallback(this.state);
  }

  stopMatch(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    if (this.state) this.state.phase = 'finished';
    this.physics.resetPlayers();
  }
}
