/**
 * Shooter match manager: lobby, countdown (90s after 2nd join), betting open/close, match start/end.
 * Mirrors snake MatchManager lifecycle; no manual start.
 */

import { ShooterEngine } from './engine.js';
import type { ShooterMatchState, ShooterPlayer } from './engine.js';
import { recordAgentJoin, recordMatchEnd, getHighestShooterMatchId, ensureMatchExists } from '../db.js';
import * as bettingService from '../betting/service.js';
import type { AgentInfo } from '../../shared/types.js';
import {
  SHOOTER_LOBBY_DURATION,
  SHOOTER_MATCH_DURATION,
  SHOOTER_RESULTS_DURATION,
  SHOOTER_BETTING_CLOSE_BEFORE_START,
  TICK_MS,
} from './constants.js';

const EFFECTIVE_LOBBY_DURATION = SHOOTER_LOBBY_DURATION; // 5s countdown (dev and prod)

const DEBOUNCE_BETTING_MS = 5_000;

interface ShooterPlayerInfo {
  id: string;
  agentInfo: AgentInfo;
  apiKey: string;
}

/** Spectator payload (same shape as GET /api/shooter/match/spectator) for Socket.IO broadcast */
export type ShooterSpectatorState = {
  matchId: string;
  phase: string;
  tick: number;
  timeRemaining: number;
  arena: { width: number; height: number };
  players: Array<{
    id: string;
    name: string;
    alive: boolean;
    x: number;
    z: number;
    angle: number;
    health: number;
    lives: number;
    weapon: string;
    ammo: number;
    kills: number;
    score: number;
    characterId?: string;
  }>;
  pickups: Array<{ id: string; x: number; z: number; weaponType: string }>;
  leaderboard: Array<{ id: string; name: string; score: number; kills: number; lives: number; alive: boolean }>;
};

export class ShooterMatchManager {
  private engine: ShooterEngine;
  private players: Map<string, ShooterPlayerInfo> = new Map();
  private nextMatchId: number = 1;
  private lobbyStartTimeout: ReturnType<typeof setTimeout> | null = null;
  private bettingCloseTimeout: ReturnType<typeof setTimeout> | null = null;
  private bettingOpenTimeout: ReturnType<typeof setTimeout> | null = null;
  private bettingOpenedOnChain: boolean = false;
  private resultsTimeout: ReturnType<typeof setTimeout> | null = null;
  private currentMatchStartTime: number = 0;
  private nextMatchStartTime: number = 0;
  private onStateUpdateCallback: ((state: ShooterSpectatorState) => void) | null = null;

  constructor() {
    this.engine = new ShooterEngine();
    this.engine.onMatchEnd((state) => this.handleMatchEnd(state));
    this.engine.onTick((match) => {
      if (match.phase === 'active' && this.onStateUpdateCallback) {
        this.onStateUpdateCallback(this.buildSpectatorPayload(match));
      }
    });
  }

  onStateUpdate(cb: (state: ShooterSpectatorState) => void): void {
    this.onStateUpdateCallback = cb;
  }

  private buildSpectatorPayload(match: ShooterMatchState): ShooterSpectatorState {
    const timeRemaining = Math.max(0, (match.endTime - Date.now()) / 1000);
    const playersList = Array.from(match.players.values()).map((p) => ({
      id: p.id,
      name: p.name,
      alive: p.alive,
      x: p.x,
      z: p.z,
      angle: p.angle,
      health: p.health,
      lives: p.lives,
      weapon: p.weapon,
      ammo: p.ammo,
      kills: p.kills,
      score: p.score,
      characterId: p.characterId,
    }));
    const leaderboard = Array.from(match.players.values())
      .map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score,
        kills: p.kills,
        lives: p.lives,
        alive: p.alive,
      }))
      .sort((a, b) => {
        if (a.alive !== b.alive) return a.alive ? -1 : 1;
        if (b.score !== a.score) return b.score - a.score;
        return b.kills - a.kills;
      });
    return {
      matchId: match.id,
      phase: match.phase,
      tick: match.tick,
      timeRemaining,
      arena: { width: 90, height: 90 },
      players: playersList,
      pickups: match.pickups.filter((p) => !p.taken).map((p) => ({ id: p.id, x: p.x, z: p.z, weaponType: p.weaponType })),
      leaderboard,
    };
  }

  getSpectatorState(): ShooterSpectatorState | null {
    const match = this.engine.getMatch();
    if (!match || match.phase !== 'active') return null;
    return this.buildSpectatorPayload(match);
  }

  async start(): Promise<void> {
    try {
      const highestId = await getHighestShooterMatchId();
      this.nextMatchId = highestId + 1;
      console.log(`[ShooterMatchManager] Initialized nextMatchId to ${this.nextMatchId} (highest: ${highestId})`);
    } catch (err) {
      console.warn('[ShooterMatchManager] getHighestShooterMatchId failed, starting from 1:', err);
      this.nextMatchId = 1;
    }
    console.log('[ShooterMatchManager] Opening initial shooter lobby...');
    this.openLobby();
  }

  stop(): void {
    if (this.lobbyStartTimeout) clearTimeout(this.lobbyStartTimeout);
    this.lobbyStartTimeout = null;
    if (this.bettingCloseTimeout) clearTimeout(this.bettingCloseTimeout);
    this.bettingCloseTimeout = null;
    if (this.bettingOpenTimeout) clearTimeout(this.bettingOpenTimeout);
    this.bettingOpenTimeout = null;
    this.bettingOpenedOnChain = false;
    if (this.resultsTimeout) clearTimeout(this.resultsTimeout);
    this.resultsTimeout = null;
    this.engine.stopMatch();
  }

  private openLobby(): void {
    const match = this.engine.getMatch();
    if (match && match.phase !== 'finished') {
      console.log(`[ShooterMatchManager] Skipping openLobby - match ${match.id} is still ${match.phase}`);
      return;
    }
    if (this.lobbyStartTimeout) clearTimeout(this.lobbyStartTimeout);
    if (this.bettingCloseTimeout) clearTimeout(this.bettingCloseTimeout);
    if (this.bettingOpenTimeout) clearTimeout(this.bettingOpenTimeout);
    this.bettingOpenedOnChain = false;
    if (this.resultsTimeout) clearTimeout(this.resultsTimeout);

    const matchId = `shooter_match_${this.nextMatchId++}`;
    this.engine.createMatch(matchId);
    this.players.clear();
    this.currentMatchStartTime = 0;
    this.nextMatchStartTime = 0;

    ensureMatchExists(matchId, 'shooter').catch(() => {});
    console.log(`[ShooterMatchManager] Lobby opened for ${matchId}. Waiting for agents...`);
  }

  private scheduleBettingOpen(match: ShooterMatchState): void {
    const allAgentNames = Array.from(match.players.values()).map((p) => {
      const info = this.players.get(p.id);
      return info?.agentInfo.name ?? p.name;
    });
    if (!this.bettingOpenedOnChain) {
      if (this.bettingOpenTimeout) clearTimeout(this.bettingOpenTimeout);
      bettingService.openBettingForMatch(match.id, allAgentNames, false).catch(() => {});
      this.bettingOpenTimeout = setTimeout(() => {
        this.bettingOpenTimeout = null;
        this.bettingOpenedOnChain = true;
        const finalMatch = this.engine.getMatch();
        if (!finalMatch) return;
        const finalNames = Array.from(finalMatch.players.values()).map((p) => {
          const info = this.players.get(p.id);
          return info?.agentInfo.name ?? p.name;
        });
        bettingService.openBettingForMatch(finalMatch.id, finalNames, true).catch(() => {});
      }, DEBOUNCE_BETTING_MS);
    } else {
      bettingService.addBettingAgent(match.id, allAgentNames[allAgentNames.length - 1]).catch(() => {});
    }
  }

  private startMatch(): void {
    const match = this.engine.getMatch();
    if (!match) return;
    if (this.bettingOpenTimeout) {
      clearTimeout(this.bettingOpenTimeout);
      this.bettingOpenTimeout = null;
    }
    if (!this.bettingOpenedOnChain && match.players.size >= 2) {
      this.bettingOpenedOnChain = true;
      const allNames = Array.from(match.players.values()).map((p) => {
        const info = this.players.get(p.id);
        return info?.agentInfo.name ?? p.name;
      });
      bettingService.openBettingForMatch(match.id, allNames, true).catch(() => {});
    }
    bettingService.closeBettingForMatch(match.id).catch(() => {});
    if (this.bettingCloseTimeout) {
      clearTimeout(this.bettingCloseTimeout);
      this.bettingCloseTimeout = null;
    }
    console.log(`[ShooterMatchManager] Starting match ${match.id} with ${match.players.size} players`);
    this.engine.startMatch();
  }

  private handleMatchEnd(state: ShooterMatchState): void {
    const match = state;
    const endedAt = Date.now();
    const matchDurationMs = match.phase === 'active' ? (match.endTime - match.startTime) : 0;

    const withSurvival = Array.from(match.players.values()).map((p) => {
      const survivalMs = p.alive ? matchDurationMs : 0;
      return { name: p.name, score: p.score, kills: p.kills, survivalMs };
    });
    withSurvival.sort((a, b) => {
      if (b.survivalMs !== a.survivalMs) return b.survivalMs - a.survivalMs;
      if (b.kills !== a.kills) return b.kills - a.kills;
      return b.score - a.score;
    });

    const drawThresholdMs = 50;
    const topSurvival = withSurvival[0]?.survivalMs ?? 0;
    const winners = withSurvival.filter((e) => Math.abs(e.survivalMs - topSurvival) <= drawThresholdMs);
    const winnerAgentNames = winners.map((w) => {
      const pid = Array.from(match.players.values()).find((p) => p.name === w.name)?.id;
      return pid ? this.players.get(pid)?.agentInfo.name ?? w.name : w.name;
    });
    const isDraw = winnerAgentNames.length > 1;
    const winnerAgentName = winnerAgentNames[0] ?? null;

    const agentNameToApiKey = new Map<string, string>();
    for (const [playerId, info] of this.players) {
      agentNameToApiKey.set(info.agentInfo.name, info.apiKey);
    }
    const winnerWalletPromises = winnerAgentNames.map((name) => {
      const apiKey = agentNameToApiKey.get(name);
      if (!apiKey) return Promise.resolve(null);
      return bettingService.getAgentWallet(name, apiKey).catch(() => null);
    });
    Promise.all(winnerWalletPromises).then((wallets) => {
      const winnerAgentWallets = wallets.map((w) => w || '0x0000000000000000000000000000000000000000');
      bettingService
        .resolveMatchBetting({
          matchId: match.id,
          winnerAgentNames,
          winnerAgentWallets,
          isDraw,
        })
        .catch((err) => console.error('[ShooterMatchManager] resolveMatchBetting failed:', err));
    });

    const finalScoresForDb = withSurvival.map((row) => {
      const agentName = Array.from(match.players.values()).find((p) => p.name === row.name);
      const pid = agentName?.id;
      const canonical = pid ? this.players.get(pid)?.agentInfo.name ?? row.name : row.name;
      return { agentName: canonical, score: row.score, kills: row.kills };
    });

    recordMatchEnd({
      matchId: match.id,
      winnerAgentName,
      endedAt,
      finalScores: finalScoresForDb,
      gameType: 'shooter',
    }).catch(() => {});

    this.resultsTimeout = setTimeout(() => {
      this.resultsTimeout = null;
      this.openLobby();
    }, SHOOTER_RESULTS_DURATION);
  }

  joinMatch(
    apiKey: string,
    agentInfo: AgentInfo,
    displayName?: string,
    characterId?: string
  ): { success: boolean; playerId?: string; matchId?: string; message: string; startsAt?: number; error?: string } {
    const match = this.engine.getMatch();
    if (!match) {
      return { success: false, message: 'No active shooter lobby', error: 'NO_LOBBY' };
    }
    if (match.phase !== 'lobby') {
      return {
        success: false,
        message: 'Match already in progress. Wait for next match.',
        error: 'MATCH_IN_PROGRESS',
      };
    }
    if (match.players.size >= 10) {
      return {
        success: false,
        message: 'Match lobby is full (10/10 players)',
        error: 'LOBBY_FULL',
      };
    }
    for (const info of this.players.values()) {
      if (info.apiKey === apiKey) {
        return { success: false, message: 'You have already joined this match', error: 'ALREADY_JOINED' };
      }
    }

    const wasFirst = match.players.size === 0;
    const isSecond = match.players.size === 1;

    const playerId = `player_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const name = displayName ?? agentInfo.name;
    const player = this.engine.addPlayer(playerId, name, characterId ?? 'G_1');
    if (!player) {
      return { success: false, message: 'Failed to join match', error: 'JOIN_FAILED' };
    }

    this.players.set(playerId, { id: playerId, agentInfo, apiKey });

    if (isSecond) {
      const now = Date.now();
      this.currentMatchStartTime = now + EFFECTIVE_LOBBY_DURATION;
      this.nextMatchStartTime = this.currentMatchStartTime + SHOOTER_MATCH_DURATION + SHOOTER_RESULTS_DURATION + EFFECTIVE_LOBBY_DURATION;

      if (this.lobbyStartTimeout) clearTimeout(this.lobbyStartTimeout);
      this.lobbyStartTimeout = setTimeout(() => this.startMatch(), EFFECTIVE_LOBBY_DURATION);

      if (EFFECTIVE_LOBBY_DURATION > SHOOTER_BETTING_CLOSE_BEFORE_START) {
        if (this.bettingCloseTimeout) clearTimeout(this.bettingCloseTimeout);
        this.bettingCloseTimeout = setTimeout(() => {
          const m = this.engine.getMatch();
          if (m) bettingService.closeBettingForMatch(m.id).catch(() => {});
        }, EFFECTIVE_LOBBY_DURATION - SHOOTER_BETTING_CLOSE_BEFORE_START);
      }

      this.engine.setPhaseCountdown();
      this.scheduleBettingOpen(match);
      console.log(
        `[ShooterMatchManager] Second agent joined lobby for ${match.id}. Match will start in ${EFFECTIVE_LOBBY_DURATION / 1000}s.`
      );
    } else if (wasFirst) {
      console.log(`[ShooterMatchManager] First agent joined lobby for ${match.id}. Waiting for another.`);
    } else {
      this.scheduleBettingOpen(match);
    }

    recordAgentJoin({
      agentName: agentInfo.name,
      apiKey,
      playerId,
      matchId: match.id,
      skinId: characterId,
      gameType: 'shooter',
    }).catch(() => {});

    const timeUntilStart = Math.max(0, this.currentMatchStartTime - Date.now());
    const message =
      this.currentMatchStartTime > 0
        ? `Joined lobby. Match starts in ${Math.round(timeUntilStart / 1000)} seconds.`
        : 'Joined lobby. Waiting for another bot to join before countdown starts.';

    return {
      success: true,
      playerId,
      matchId: match.id,
      message,
      startsAt: this.currentMatchStartTime,
    };
  }

  getPlayerByApiKey(apiKey: string): ShooterPlayerInfo | undefined {
    for (const info of this.players.values()) {
      if (info.apiKey === apiKey) return info;
    }
    return undefined;
  }

  getStatus(): {
    serverTime: number;
    currentMatch: { id: string; phase: string; playerCount: number; startsAt: number } | null;
    nextMatch: { id: string; lobbyOpensAt: number; startsAt: number } | null;
  } {
    const match = this.engine.getMatch();
    const serverTime = Date.now();
    let currentMatch: { id: string; phase: string; playerCount: number; startsAt: number } | null = null;
    let nextMatch: { id: string; lobbyOpensAt: number; startsAt: number } | null = null;

    if (match && match.phase !== 'finished') {
      const playerCount = match.players.size;
      const startsAt =
        match.phase === 'lobby' && this.currentMatchStartTime > 0
          ? this.currentMatchStartTime
          : match.phase === 'countdown'
            ? this.currentMatchStartTime
            : match.phase === 'active'
              ? match.startTime
              : 0;
      currentMatch = {
        id: match.id,
        phase: match.phase,
        playerCount,
        startsAt,
      };
      if (match.phase === 'lobby' && playerCount === 0) {
        nextMatch = { id: match.id, lobbyOpensAt: 0, startsAt: 0 };
      } else if (this.nextMatchStartTime > 0) {
        nextMatch = {
          id: `shooter_match_${this.nextMatchId}`,
          lobbyOpensAt: this.nextMatchStartTime - SHOOTER_MATCH_DURATION - SHOOTER_RESULTS_DURATION - EFFECTIVE_LOBBY_DURATION,
          startsAt: this.nextMatchStartTime - SHOOTER_RESULTS_DURATION - EFFECTIVE_LOBBY_DURATION,
        };
      }
    }
    return { serverTime, currentMatch, nextMatch };
  }

  getMatchState(): ShooterMatchState | null {
    return this.engine.getMatch();
  }

  performAction(
    playerId: string,
    action: { angle?: number; shoot?: boolean; move?: boolean }
  ): { success: boolean; error?: string; message?: string } {
    const match = this.engine.getMatch();
    if (!match) return { success: false, error: 'NO_MATCH', message: 'No active match' };
    if (match.phase !== 'active') return { success: false, error: 'MATCH_NOT_ACTIVE', message: 'Match not active' };
    const player = match.players.get(playerId);
    if (!player) return { success: false, error: 'NOT_IN_MATCH', message: 'Player not in match' };
    if (!player.alive) return { success: false, error: 'DEAD', message: 'You are dead' };
    this.engine.setPendingAction(playerId, action);
    return { success: true };
  }
}
