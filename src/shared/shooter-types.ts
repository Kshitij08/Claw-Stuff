import type { WeaponType, PersonalityType } from './shooter-constants.js';

// ── Core entities ──────────────────────────────────────────────────

export interface ShooterPlayer {
  id: string;
  name: string;
  strategyTag?: string;
  x: number;
  y: number;
  z: number;
  angle: number;          // facing direction in degrees (0 = +X, 90 = +Z)
  health: number;
  lives: number;
  weapon: WeaponType;
  ammo: number | null;
  kills: number;
  deaths: number;
  alive: boolean;
  eliminated: boolean;    // all lives spent
  /** Character model id, e.g. "G_3" */
  character: string;
  /** Bot personality (AI bots only). */
  personality?: PersonalityType;
  /** True if this is a server-side AI bot (not an API agent). */
  isAI?: boolean;
  /** Timestamp when this life started (for survival time calc) */
  aliveSince: number;
  /** Accumulated survival seconds from previous lives */
  survivalTime: number;
  /** Timestamp of death (for respawn delay) */
  diedAt: number | null;
  /** Timestamp of last shot fired (for fire-rate cooldown) */
  lastShotTime: number;
}

export interface WeaponPickup {
  id: string;
  type: WeaponType;
  x: number;
  y: number;
  z: number;
  taken: boolean;
}

export type ShooterMatchPhase = 'lobby' | 'countdown' | 'active' | 'finished';

export interface ShooterMatch {
  id: string;
  phase: ShooterMatchPhase;
  tick: number;
  startTime: number;     // when active phase started
  endTime: number;       // scheduled end of active phase
  players: Map<string, ShooterPlayer>;
  pickups: WeaponPickup[];
}

// ── Agent info (from Moltbook auth) ────────────────────────────────

export interface ShooterAgentInfo {
  name: string;
  description?: string;
  moltbookId?: string;
}

export interface ShooterRegisteredPlayer {
  id: string;
  agentInfo: ShooterAgentInfo;
  apiKey: string;
  lastActionTime: number;
  actionCount: number;
}

// ── API request / response types ───────────────────────────────────

export interface ShooterStatusResponse {
  serverTime: number;
  currentMatch: {
    id: string;
    phase: ShooterMatchPhase;
    startsAt?: number;
    startedAt: number;
    endsAt: number;
    playerCount: number;
  } | null;
  nextMatch: {
    id: string;
    lobbyOpensAt: number;
    startsAt: number;
  };
}

export interface ShooterJoinRequest {
  displayName?: string;
  strategyTag?: string;
}

export interface ShooterJoinResponse {
  success: boolean;
  matchId?: string;
  playerId?: string;
  message: string;
  startsAt?: number;
  error?: string;
}

export interface ShooterGameStateResponse {
  matchId: string;
  phase: ShooterMatchPhase;
  tick: number;
  timeRemaining: number;
  arena: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
  };
  you?: {
    id: string;
    alive: boolean;
    x: number;
    y: number;
    z: number;
    angle: number;
    health: number;
    lives: number;
    weapon: WeaponType;
    ammo: number | null;
    kills: number;
    deaths: number;
  };
  players: {
    id: string;
    name: string;
    alive: boolean;
    x: number;
    y: number;
    z: number;
    angle: number;
    health: number;
    lives: number;
    weapon: WeaponType;
  }[];
  weaponPickups: {
    id: string;
    type: WeaponType;
    x: number;
    y: number;
    z: number;
  }[];
  leaderboard: {
    id: string;
    name: string;
    kills: number;
    deaths: number;
    survivalTime: number;
  }[];
}

export type ShooterActionType = 'move' | 'shoot' | 'melee' | 'pickup' | 'stop';

export interface ShooterActionRequest {
  action: ShooterActionType;
  /** Movement / aim direction in degrees (0 = +X, 90 = +Z) */
  angle?: number;
  /** Aim direction for shooting (defaults to player facing angle) */
  aimAngle?: number;
}

export interface ShooterActionResponse {
  success: boolean;
  tick?: number;
  error?: string;
  message?: string;
  retryAfterMs?: number;
}

// ── Spectator (Socket.IO) types ────────────────────────────────────

export interface ShooterSpectatorPlayer {
  id: string;
  name: string;
  character: string;
  personality?: string;
  x: number;
  y: number;
  z: number;
  angle: number;
  health: number;
  lives: number;
  weapon: WeaponType;
  ammo: number | null;
  kills: number;
  deaths: number;
  alive: boolean;
  eliminated: boolean;
  survivalTime: number;
}

export interface ShooterSpectatorBullet {
  id: string;
  x: number;
  y: number;
  z: number;
  fromX: number;
  fromY: number;
  fromZ: number;
  ownerId: string;
  weapon: WeaponType;
}

export interface ShooterSpectatorState {
  matchId: string;
  phase: ShooterMatchPhase;
  tick: number;
  timeRemaining: number;
  players: ShooterSpectatorPlayer[];
  pickups: {
    id: string;
    type: WeaponType;
    x: number;
    y: number;
    z: number;
  }[];
  /** Active physical bullets (for debug/visual) */
  bullets: ShooterSpectatorBullet[];
}

export interface ShooterSpectatorHitEvent {
  shooterId: string;
  victimId: string;
  fromX: number;
  fromZ: number;
  toX: number;
  toZ: number;
  weapon: WeaponType;
  damage: number;
  killed: boolean;
}

export interface ShooterSpectatorShotEvent {
  shooterId: string;
  fromX: number;
  fromZ: number;
  toX: number;
  toZ: number;
  weapon: WeaponType;
  hit: boolean;
}

export interface ShooterSpectatorMatchEnd {
  matchId: string;
  winner: { name: string; kills: number; survivalTime: number } | null;
  finalRanking: {
    rank: number;
    name: string;
    kills: number;
    deaths: number;
    survivalTime: number;
  }[];
  nextMatchStartsAt: number;
}
