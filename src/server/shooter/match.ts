/**
 * Shooter match manager.
 *
 * Mirrors the claw-snake MatchManager pattern:
 *  - Lobby opens immediately on start.
 *  - When the 2nd player joins, a 90s countdown begins.
 *  - After countdown, match goes active for 4 minutes.
 *  - When ≤1 player has lives remaining (or time expires), match ends.
 *  - 10s results display, then next lobby opens.
 */

import { ShooterEngine } from './engine.js';
import { getTotalSurvivalSeconds } from './player.js';
import type {
  ShooterPlayer,
  ShooterRegisteredPlayer,
  ShooterAgentInfo,
  ShooterStatusResponse,
  ShooterSpectatorState,
  ShooterSpectatorShotEvent,
  ShooterSpectatorHitEvent,
  ShooterSpectatorMatchEnd,
  ShooterMatchPhase,
} from '../../shared/shooter-types.js';
import {
  MATCH_DURATION_MS,
  LOBBY_COUNTDOWN_MS,
  RESULTS_DURATION_MS,
  MAX_PLAYERS,
} from '../../shared/shooter-constants.js';

export class ShooterMatchManager {
  private engine: ShooterEngine;
  private registeredPlayers: Map<string, ShooterRegisteredPlayer> = new Map();
  private nextMatchId = 1;
  private lobbyCountdownTimer: NodeJS.Timeout | null = null;
  private resultsTimer: NodeJS.Timeout | null = null;
  private countdownStartsAt = 0;

  // Callbacks for Socket.IO integration
  private onStateUpdateCallback: ((state: ShooterSpectatorState) => void) | null = null;
  private onShotCallback: ((shot: ShooterSpectatorShotEvent) => void) | null = null;
  private onHitCallback: ((hit: ShooterSpectatorHitEvent) => void) | null = null;
  private onMatchEndCallback: ((result: ShooterSpectatorMatchEnd) => void) | null = null;
  private onLobbyOpenCallback: ((matchId: string, startsAt: number) => void) | null = null;
  private onStatusChangeCallback: (() => void) | null = null;

  constructor() {
    this.engine = new ShooterEngine();
  }

  // ── Event registration ────────────────────────────────────────────

  onStateUpdate(cb: (state: ShooterSpectatorState) => void): void {
    this.onStateUpdateCallback = cb;
  }
  onShot(cb: (shot: ShooterSpectatorShotEvent) => void): void {
    this.onShotCallback = cb;
  }
  onHit(cb: (hit: ShooterSpectatorHitEvent) => void): void {
    this.onHitCallback = cb;
  }
  onMatchEndEvent(cb: (result: ShooterSpectatorMatchEnd) => void): void {
    this.onMatchEndCallback = cb;
  }
  onLobbyOpen(cb: (matchId: string, startsAt: number) => void): void {
    this.onLobbyOpenCallback = cb;
  }
  onStatusChange(cb: () => void): void {
    this.onStatusChangeCallback = cb;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  async start(): Promise<void> {
    await this.engine.init();

    // Wire engine callbacks
    this.engine.onTick((state) => {
      this.onStateUpdateCallback?.(state);
    });
    this.engine.onShot((shot) => {
      this.onShotCallback?.(shot);
    });
    this.engine.onHit((hit) => {
      this.onHitCallback?.(hit);
    });
    this.engine.onMatchEnd(() => {
      this.handleMatchEnd();
    });

    // Open initial lobby
    this.openLobby();
    console.log('[ShooterMatchManager] Started');
  }

  stop(): void {
    this.engine.stopMatch();
    if (this.lobbyCountdownTimer) {
      clearTimeout(this.lobbyCountdownTimer);
      this.lobbyCountdownTimer = null;
    }
    if (this.resultsTimer) {
      clearTimeout(this.resultsTimer);
      this.resultsTimer = null;
    }
  }

  // ── Lobby ─────────────────────────────────────────────────────────

  private openLobby(): void {
    const matchId = `shooter_${this.nextMatchId++}`;
    this.engine.createMatch(matchId);
    this.registeredPlayers.clear();
    this.countdownStartsAt = 0;

    console.log(`[ShooterMatchManager] Lobby open: ${matchId}`);
    this.onLobbyOpenCallback?.(matchId, 0);
    this.onStatusChangeCallback?.();
  }

  // ── Join ──────────────────────────────────────────────────────────

  joinMatch(
    apiKey: string,
    agentInfo: ShooterAgentInfo,
    displayName?: string,
    strategyTag?: string,
  ): {
    success: boolean;
    playerId?: string;
    matchId?: string;
    message: string;
    startsAt?: number;
    error?: string;
  } {
    const match = this.engine.getMatch();
    if (!match) {
      return { success: false, error: 'NO_MATCH', message: 'No match available' };
    }

    if (match.phase !== 'lobby' && match.phase !== 'countdown') {
      // Allow late join during active phase
      if (match.phase !== 'active') {
        return { success: false, error: 'MATCH_IN_PROGRESS', message: 'Match already finished. Wait for next lobby.' };
      }
    }

    if (match.players.size >= MAX_PLAYERS) {
      return { success: false, error: 'LOBBY_FULL', message: `Match lobby is full (${MAX_PLAYERS}/${MAX_PLAYERS} players)` };
    }

    // Check if this agent already joined (by API key)
    for (const [, rp] of this.registeredPlayers) {
      if (rp.apiKey === apiKey) {
        return {
          success: true,
          playerId: rp.id,
          matchId: match.id,
          message: 'Already joined this match.',
          startsAt: this.countdownStartsAt || undefined,
        };
      }
    }

    const name = displayName || agentInfo.name;
    const playerId = `sp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

    const player = this.engine.addPlayer(playerId, name, strategyTag);
    if (!player) {
      return { success: false, error: 'JOIN_FAILED', message: 'Failed to add player to match' };
    }

    this.registeredPlayers.set(playerId, {
      id: playerId,
      agentInfo,
      apiKey,
      lastActionTime: 0,
      actionCount: 0,
    });

    // If this is the 2nd player in lobby, start countdown
    if (
      (match.phase === 'lobby' || match.phase === 'countdown') &&
      match.players.size >= 2 &&
      !this.lobbyCountdownTimer
    ) {
      this.startLobbyCountdown();
    }

    this.onStatusChangeCallback?.();

    return {
      success: true,
      playerId,
      matchId: match.id,
      message: this.countdownStartsAt
        ? `Joined match. Starts in ${Math.round((this.countdownStartsAt - Date.now()) / 1000)}s.`
        : 'Joined lobby. Waiting for more players.',
      startsAt: this.countdownStartsAt || undefined,
    };
  }

  // ── Countdown ─────────────────────────────────────────────────────

  private startLobbyCountdown(): void {
    const match = this.engine.getMatch();
    if (!match) return;

    match.phase = 'countdown';
    this.countdownStartsAt = Date.now() + LOBBY_COUNTDOWN_MS;

    console.log(`[ShooterMatchManager] Countdown started, match begins in ${LOBBY_COUNTDOWN_MS / 1000}s`);
    this.onLobbyOpenCallback?.(match.id, this.countdownStartsAt);
    this.onStatusChangeCallback?.();

    this.lobbyCountdownTimer = setTimeout(() => {
      this.lobbyCountdownTimer = null;
      this.engine.startMatch(MATCH_DURATION_MS);
      this.onStatusChangeCallback?.();
    }, LOBBY_COUNTDOWN_MS);
  }

  // ── Match end ─────────────────────────────────────────────────────

  private handleMatchEnd(): void {
    const match = this.engine.getMatch();
    if (!match) return;

    const leaderboard = this.engine.getLeaderboard();
    const winner = leaderboard.length > 0 ? leaderboard[0] : null;

    const result: ShooterSpectatorMatchEnd = {
      matchId: match.id,
      winner: winner ? { name: winner.name, kills: winner.kills, survivalTime: winner.survivalTime } : null,
      finalRanking: leaderboard.map((entry, i) => ({
        rank: i + 1,
        name: entry.name,
        kills: entry.kills,
        deaths: entry.deaths,
        survivalTime: entry.survivalTime,
      })),
      nextMatchStartsAt: Date.now() + RESULTS_DURATION_MS,
    };

    console.log(`[ShooterMatchManager] Match ${match.id} ended. Winner: ${winner?.name ?? 'none'}`);
    this.onMatchEndCallback?.(result);

    // Open next lobby after results display
    this.resultsTimer = setTimeout(() => {
      this.resultsTimer = null;
      this.openLobby();
    }, RESULTS_DURATION_MS);
  }

  // ── Actions ───────────────────────────────────────────────────────

  queueAction(playerId: string, action: any): { success: boolean; error?: string; message?: string } {
    const match = this.engine.getMatch();
    if (!match || match.phase !== 'active') {
      return { success: false, error: 'MATCH_NOT_ACTIVE', message: 'Match is not in active phase' };
    }

    const player = this.engine.getPlayer(playerId);
    if (!player) {
      return { success: false, error: 'NOT_IN_MATCH', message: 'You are not in this match' };
    }

    if (!player.alive && !player.eliminated) {
      return { success: false, error: 'DEAD', message: 'You are dead. Respawning soon...' };
    }

    if (player.eliminated) {
      return { success: false, error: 'ELIMINATED', message: 'You have been eliminated from this match' };
    }

    this.engine.queueAction(playerId, action);
    return { success: true };
  }

  // ── Getters ───────────────────────────────────────────────────────

  getStatus(): ShooterStatusResponse {
    const match = this.engine.getMatch();
    const now = Date.now();

    return {
      serverTime: now,
      currentMatch: match
        ? {
            id: match.id,
            phase: match.phase,
            startsAt: this.countdownStartsAt || undefined,
            startedAt: match.startTime,
            endsAt: match.endTime,
            playerCount: match.players.size,
          }
        : null,
      nextMatch: {
        id: `shooter_${this.nextMatchId}`,
        lobbyOpensAt: 0,
        startsAt: 0,
      },
    };
  }

  getSpectatorState(): ShooterSpectatorState | null {
    return this.engine.getSpectatorState();
  }

  getGameStateForPlayer(apiKey: string): any {
    const match = this.engine.getMatch();
    if (!match) return null;

    // Find the player by API key
    let playerId: string | null = null;
    for (const [id, rp] of this.registeredPlayers) {
      if (rp.apiKey === apiKey) {
        playerId = id;
        break;
      }
    }

    const timeRemaining = match.phase === 'active'
      ? Math.max(0, (match.endTime - Date.now()) / 1000)
      : 0;

    const allPlayers = [...match.players.values()];
    const leaderboard = this.engine.getLeaderboard();

    const myPlayer = playerId ? match.players.get(playerId) : null;

    return {
      matchId: match.id,
      phase: match.phase,
      tick: match.tick,
      timeRemaining: Math.round(timeRemaining * 10) / 10,
      arena: {
        minX: -45,
        maxX: 45,
        minZ: -45,
        maxZ: 45,
      },
      you: myPlayer
        ? {
            id: myPlayer.id,
            alive: myPlayer.alive,
            x: Math.round(myPlayer.x * 100) / 100,
            y: Math.round(myPlayer.y * 100) / 100,
            z: Math.round(myPlayer.z * 100) / 100,
            angle: Math.round(myPlayer.angle * 10) / 10,
            health: myPlayer.health,
            lives: myPlayer.lives,
            weapon: myPlayer.weapon,
            ammo: myPlayer.ammo,
            kills: myPlayer.kills,
            deaths: myPlayer.deaths,
          }
        : undefined,
      players: allPlayers
        .filter((p) => p.id !== playerId)
        .map((p) => ({
          id: p.id,
          name: p.name,
          alive: p.alive,
          x: Math.round(p.x * 100) / 100,
          y: Math.round(p.y * 100) / 100,
          z: Math.round(p.z * 100) / 100,
          angle: Math.round(p.angle * 10) / 10,
          health: p.health,
          lives: p.lives,
          weapon: p.weapon,
        })),
      weaponPickups: match.pickups
        .filter((p) => !p.taken)
        .map((p) => ({
          id: p.id,
          type: p.type,
          x: Math.round(p.x * 100) / 100,
          y: Math.round(p.y * 100) / 100,
          z: Math.round(p.z * 100) / 100,
        })),
      leaderboard,
    };
  }

  /** Resolve playerId from API key. */
  getPlayerIdByApiKey(apiKey: string): string | null {
    for (const [id, rp] of this.registeredPlayers) {
      if (rp.apiKey === apiKey) return id;
    }
    return null;
  }
}
