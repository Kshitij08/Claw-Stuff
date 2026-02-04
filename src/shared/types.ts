// ============ Core Game Types ============

export interface Point {
  x: number;
  y: number;
}

export interface Segment extends Point {}

export interface Food {
  id: string;
  x: number;
  y: number;
  value: number;
}

export interface Snake {
  id: string;
  name: string;
  color: string;
  segments: Segment[];
  angle: number; // Direction in degrees (0 = right, 90 = down, 180 = left, 270 = up)
  speed: number;
  boosting: boolean;
  score: number;
  kills: number;
  alive: boolean;
  lastBoostLoss: number; // Timestamp of last segment loss from boosting
  killedBy?: string;
  deathTick?: number;
}

// ============ Match Types ============

export type MatchPhase = 'lobby' | 'active' | 'finished';

export interface Match {
  id: string;
  phase: MatchPhase;
  tick: number;
  startTime: number; // When match started (active phase)
  endTime: number; // When match ends
  snakes: Map<string, Snake>;
  food: Food[];
  winner?: string;
}

export interface MatchResult {
  matchId: string;
  endedAt: number;
  winner: { name: string; score: number } | null;
  playerCount: number;
  finalScores: { name: string; score: number; kills: number }[];
}

// ============ Player/Agent Types ============

export interface AgentInfo {
  name: string;
  description?: string;
  moltbookId?: string;
}

export interface Player {
  id: string;
  agentInfo: AgentInfo;
  apiKey: string;
  lastActionTime: number;
  actionCount: number; // Actions in current second (for rate limiting)
}

// ============ API Request/Response Types ============

// GET /api/status
export interface StatusResponse {
  serverTime: number;
  currentMatch: {
    id: string;
    phase: MatchPhase;
    /** When this match is scheduled to start (for lobby UI countdowns) */
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

// POST /api/match/join
export interface JoinRequest {
  displayName?: string;
  /** Optional hex color for the snake, e.g. "#FF6B6B" */
  color?: string;
}

export interface JoinResponse {
  success: boolean;
  matchId?: string;
  playerId?: string;
  message: string;
  startsAt?: number;
  error?: string;
}

// GET /api/match/current
export interface GameStateResponse {
  matchId: string;
  phase: MatchPhase;
  tick: number;
  timeRemaining: number;
  arena: {
    width: number;
    height: number;
  };
  you?: {
    id: string;
    alive: boolean;
    x: number;
    y: number;
    angle: number;
    speed: number;
    boosting: boolean;
    length: number;
    score: number;
    segments: [number, number][];
  };
  players: {
    id: string;
    name: string;
    alive: boolean;
    x: number;
    y: number;
    angle: number;
    speed: number;
    boosting: boolean;
    length: number;
    score: number;
    segments: [number, number][];
    killedBy?: string;
    deathTick?: number;
  }[];
  food: { x: number; y: number; value: number }[];
  leaderboard: { id: string; name: string; score: number }[];
}

// POST /api/match/action
export interface ActionRequest {
  action: 'steer' | 'boost';
  angle?: number; // Absolute angle
  angleDelta?: number; // Relative angle change
  active?: boolean; // For boost action
  boost?: boolean; // Combined with steer
}

export interface ActionResponse {
  success: boolean;
  tick?: number;
  newAngle?: number;
  boosting?: boolean;
  speed?: number;
  length?: number;
  droppedFood?: { x: number; y: number; value: number };
  error?: string;
  message?: string;
  retryAfterMs?: number;
}

// GET /api/leaderboard
export interface LeaderboardResponse {
  allTime: { name: string; wins: number; totalScore: number }[];
  recentMatches: {
    matchId: string;
    endedAt: number;
    winner: { name: string; score: number } | null;
    playerCount: number;
  }[];
}

// ============ WebSocket Events (for spectators) ============

export interface SpectatorGameState {
  matchId: string;
  phase: MatchPhase;
  tick: number;
  timeRemaining: number;
  snakes: {
    id: string;
    name: string;
    color: string;
    score: number;
    segments: [number, number][];
    angle: number;
    boosting: boolean;
    alive: boolean;
  }[];
  food: [number, number, number][]; // [x, y, value]
}

export interface SpectatorMatchEnd {
  matchId: string;
  winner: { name: string; score: number } | null;
  finalScores: { name: string; score: number; kills: number }[];
  nextMatchStartsAt: number;
}
