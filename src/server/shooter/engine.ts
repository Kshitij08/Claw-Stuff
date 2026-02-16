/**
 * Server-side shooter game engine. Ticks at fixed interval; applies move, shoot, damage, respawn, pickups.
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
  INITIAL_WEAPON_PICKUPS,
  MIN_SPAWN_SEPARATION,
  MIN_DISTANCE_GUN_FROM_PLAYER,
  MIN_DISTANCE_GUN_FROM_GUN,
  SHOOTER_MATCH_DURATION,
  MAX_SHOOTER_PLAYERS,
  type WeaponType,
} from './constants.js';

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
  const margin = 8;
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

  createMatch(matchId: string): ShooterMatchState {
    if (this.state && this.state.phase !== 'finished') {
      throw new Error('Match already in progress');
    }
    const spawnPoints = generateSpawnPoints(MAX_SHOOTER_PLAYERS);
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

    // Apply pending actions (move angle only; shoot processed after move)
    for (const [playerId, action] of match.pendingActions) {
      const player = match.players.get(playerId);
      if (!player || !player.alive) continue;
      if (action.angle !== undefined) {
        player.angle = action.angle;
      }
    }

    // Move alive players only when they have a pending action with move: true
    for (const player of match.players.values()) {
      if (!player.alive) continue;
      const action = match.pendingActions.get(player.id);
      if (!action || action.move !== true) continue;
      const speed = MOVEMENT_SPEED * TICK_MS; // units per tick
      player.x += Math.sin(player.angle) * speed;
      player.z += Math.cos(player.angle) * speed;
      player.x = clamp(player.x, MAP_BOUNDS.minX, MAP_BOUNDS.maxX);
      player.z = clamp(player.z, MAP_BOUNDS.minZ, MAP_BOUNDS.maxZ);
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

      // Hit check: find closest enemy in range (cone or line)
      const range = stats.range;
      let bestTarget: ShooterPlayer | null = null;
      let bestDist = range + 1;
      for (const other of match.players.values()) {
        if (other.id === player.id || !other.alive) continue;
        const d = distance(player.x, player.z, other.x, other.z);
        if (d >= bestDist) continue;
        const angleTo = Math.atan2(other.x - player.x, other.z - player.z);
        let diff = Math.abs(angleTo - player.angle);
        if (diff > Math.PI) diff = 2 * Math.PI - diff;
        if (diff < 0.3) {
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

    match.pendingActions.clear();

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
      if (ok) break;
      spawn = match.spawnPoints[Math.floor(Math.random() * match.spawnPoints.length)];
    }
    player.x = spawn.x;
    player.z = spawn.z;
    player.health = HEALTH_PER_LIFE;
    player.weapon = WEAPON_TYPES.KNIFE;
    player.ammo = -1;
    player.alive = true;
  }

  private finishMatch(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    if (!this.state) return;
    this.state.phase = 'finished';
    if (this.onMatchEndCallback) this.onMatchEndCallback(this.state);
  }

  stopMatch(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    if (this.state) this.state.phase = 'finished';
  }
}
