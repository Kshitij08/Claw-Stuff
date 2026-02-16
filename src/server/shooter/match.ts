/**
 * Shooter match manager.
 *
 * Mirrors the claw-snake MatchManager pattern:
 *  - Lobby opens immediately on start.
 *  - When the 2nd API agent joins (or immediately with AI bots), a countdown begins.
 *  - After countdown, match goes active for 4 minutes.
 *  - When ≤1 player has lives remaining (or time expires), match ends.
 *  - 10s results display, then next lobby opens.
 *
 * AI Bot Integration:
 *  - On match start, empty slots are filled with server-side AI bots.
 *  - When an API agent joins a full match, the lowest-priority AI bot is
 *    removed to make room (API agents always get priority).
 *  - AI bots use the same action pipeline as API agents.
 */

import { ShooterEngine } from './engine.js';
import { BotAIManager } from './bot-ai.js';
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
  BOT_NAMES,
  PERSONALITIES,
  type PersonalityType,
} from '../../shared/shooter-constants.js';

/** Minimum number of total players (AI + API) to start a match. */
const MIN_PLAYERS_FOR_MATCH = 2;
/** Number of AI bots to fill in the arena. */
const AI_FILL_COUNT = 5;

export class ShooterMatchManager {
  private engine: ShooterEngine;
  private botAI: BotAIManager;
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
    this.botAI = new BotAIManager();
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

    // Wire bot AI pre-tick: runs before engine processes actions
    this.engine.onPreTick(() => {
      const match = this.engine.getMatch();
      if (match) {
        this.botAI.tick(match, this.engine);
      }
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
    this.botAI.clear();
    this.countdownStartsAt = 0;

    // Auto-fill with AI bots
    this.fillWithAIBots();

    // With AI bots in the arena, start countdown immediately
    const match = this.engine.getMatch();
    if (match && match.players.size >= MIN_PLAYERS_FOR_MATCH && !this.lobbyCountdownTimer) {
      this.startLobbyCountdown();
    }

    console.log(`[ShooterMatchManager] Lobby open: ${matchId} (${this.botAI.size} AI bots)`);
    this.onLobbyOpenCallback?.(matchId, this.countdownStartsAt);
    this.onStatusChangeCallback?.();
  }

  /** Fill empty slots with server-side AI bots up to AI_FILL_COUNT. */
  private fillWithAIBots(): void {
    const match = this.engine.getMatch();
    if (!match) return;

    const slotsToFill = Math.min(AI_FILL_COUNT, MAX_PLAYERS) - match.players.size;
    let nameIndex = 0;

    for (let i = 0; i < slotsToFill; i++) {
      const botId = `ai_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const botName = BOT_NAMES[nameIndex % BOT_NAMES.length];
      const personality = PERSONALITIES[i % PERSONALITIES.length] as PersonalityType;
      nameIndex++;

      const player = this.engine.addPlayer(botId, botName, undefined, { personality, isAI: true });
      if (player) {
        this.botAI.addBot(botId, personality);
      }
    }

    console.log(`[ShooterMatchManager] Filled ${slotsToFill} AI bot slots`);
  }

  /**
   * Remove one AI bot to make room for an API agent.
   * Picks the AI bot with the fewest kills (least impactful removal).
   * Returns the removed bot's playerId, or null if no AI bot found.
   */
  private removeOneAIBot(): string | null {
    const match = this.engine.getMatch();
    if (!match) return null;

    const aiBotIds = this.botAI.getBotIds();
    if (aiBotIds.length === 0) return null;

    // Find the AI bot with lowest survival time, then lowest KDA (kills - deaths)
    let bestId: string | null = null;
    let bestSurvival = Infinity;
    let bestKda = Infinity;

    for (const botId of aiBotIds) {
      const player = match.players.get(botId);
      if (!player) continue;
      const survival = getTotalSurvivalSeconds(player);
      const kda = player.kills - player.deaths;
      if (
        survival < bestSurvival ||
        (Math.abs(survival - bestSurvival) < 0.5 && kda < bestKda)
      ) {
        bestSurvival = survival;
        bestKda = kda;
        bestId = botId;
      }
    }

    if (bestId) {
      this.engine.removePlayer(bestId);
      this.botAI.removeBot(bestId);
      console.log(`[ShooterMatchManager] Removed AI bot ${bestId} to make room for API agent`);
    }

    return bestId;
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

    // If arena is full, try to replace an AI bot
    if (match.players.size >= MAX_PLAYERS) {
      const removed = this.removeOneAIBot();
      if (!removed) {
        return { success: false, error: 'LOBBY_FULL', message: `Match lobby is full (${MAX_PLAYERS}/${MAX_PLAYERS} players, no AI bots to replace)` };
      }
    }

    const name = displayName || agentInfo.name;
    const playerId = `sp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

    const player = this.engine.addPlayer(playerId, name, strategyTag, { isAI: false });
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
      match.players.size >= MIN_PLAYERS_FOR_MATCH &&
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
      winner: winner ? { id: winner.id, name: winner.name, character: winner.character, kills: winner.kills, survivalTime: winner.survivalTime } : null,
      finalRanking: leaderboard.map((entry, i) => ({
        rank: i + 1,
        id: entry.id,
        name: entry.name,
        character: entry.character,
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
