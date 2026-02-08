import { Snake, Food, Match, MatchPhase, Point, SpectatorGameState } from '../../shared/types.js';
import { resolveSkinToParts } from '../../shared/skins.js';
import {
  ARENA_WIDTH,
  ARENA_HEIGHT,
  TICK_INTERVAL,
  DROPPED_FOOD_VALUE,
  NORMAL_SPEED,
} from '../../shared/constants.js';
import {
  createSnake,
  moveSnake,
  growSnake,
  killSnake,
  getSnakeHead,
  resetColorIndex,
} from './snake.js';
import {
  spawnInitialFood,
  maintainFoodCount,
  createDroppedFood,
  resetFoodCounter,
} from './food.js';
import {
  checkFoodCollision,
  checkWallCollision,
  wrapPointInArena,
  findCollisionTarget,
  checkHeadCollision,
} from './collision.js';

export class GameEngine {
  private match: Match | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private onTickCallback: ((state: SpectatorGameState) => void) | null = null;
  private onMatchEndCallback: ((match: Match) => void) | null = null;

  createMatch(matchId: string): Match {
    resetColorIndex();
    resetFoodCounter();
    
    this.match = {
      id: matchId,
      phase: 'lobby',
      tick: 0,
      startTime: 0,
      endTime: 0,
      snakes: new Map(),
      food: [],
    };
    return this.match;
  }

  getMatch(): Match | null {
    return this.match;
  }

  addPlayer(playerId: string, name: string, color?: string, skinId?: string): Snake | null {
    if (!this.match || this.match.phase !== 'lobby') {
      return null;
    }

    // Generate random spawn position
    const margin = 200;
    const spawnX = margin + Math.random() * (ARENA_WIDTH - 2 * margin);
    const spawnY = margin + Math.random() * (ARENA_HEIGHT - 2 * margin);
    const spawnAngle = Math.random() * 360;

    const snake = createSnake(playerId, name, spawnX, spawnY, spawnAngle, color, skinId);
    this.match.snakes.set(playerId, snake);
    return snake;
  }

  removePlayer(playerId: string): void {
    if (!this.match) return;
    this.match.snakes.delete(playerId);
  }

  startMatch(durationMs: number): void {
    if (!this.match || this.match.phase !== 'lobby') return;

    this.match.phase = 'active';
    this.match.startTime = Date.now();
    this.match.endTime = this.match.startTime + durationMs;
    this.match.food = spawnInitialFood();

    // Log initial snake positions
    for (const [id, snake] of this.match.snakes) {
      const head = snake.segments[0];
      console.log(`[START] Snake ${snake.name}: pos=(${head.x.toFixed(1)}, ${head.y.toFixed(1)}), angle=${snake.angle.toFixed(1)}, segments=${snake.segments.length}`);
    }

    // Start game loop
    this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL);
  }

  stopMatch(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.match) {
      this.match.actualEndTime = Date.now();
      this.match.phase = 'finished';
      this.determineWinner();
      if (this.onMatchEndCallback) {
        this.onMatchEndCallback(this.match);
      }
    }
  }

  onTick(callback: (state: SpectatorGameState) => void): void {
    this.onTickCallback = callback;
  }

  onMatchEnd(callback: (match: Match) => void): void {
    this.onMatchEndCallback = callback;
  }

  private tick(): void {
    if (!this.match || this.match.phase !== 'active') return;

    this.match.tick++;
    const now = Date.now();

    // Check if match time is over
    if (now >= this.match.endTime) {
      this.stopMatch();
      return;
    }

    // Process each alive snake
    for (const [playerId, snake] of this.match.snakes) {
      if (!snake.alive) continue;

      // Move snake
      moveSnake(snake);
      const head = getSnakeHead(snake);

      // Wrap at walls (classic snake: appear on opposite side)
      if (checkWallCollision(head)) {
        wrapPointInArena(head);
      }

      // Check collision with other snakes' bodies
      const collision = findCollisionTarget(head, this.match.snakes, playerId);
      if (collision) {
        const hitSnake = this.match.snakes.get(collision.snakeId);
        console.log(`[DEATH] Snake ${snake.name} hit ${collision.snakeId === playerId ? 'SELF' : hitSnake?.name} at tick ${this.match.tick}. Head: (${head.x.toFixed(1)}, ${head.y.toFixed(1)}), segment ${collision.segmentIndex}`);
        killSnake(snake, collision.snakeId, this.match.tick);
        this.dropSnakeAsFood(snake);
        continue;
      }

      // Check food collision
      const foodToRemove: string[] = [];
      for (const food of this.match.food) {
        if (checkFoodCollision(head, food)) {
          snake.score += food.value;
          growSnake(snake);
          foodToRemove.push(food.id);
        }
      }

      // Remove eaten food
      this.match.food = this.match.food.filter(f => !foodToRemove.includes(f.id));
    }

    // Check head-to-head collisions (both snakes die)
    const aliveSnakes = Array.from(this.match.snakes.values()).filter(s => s.alive);
    for (let i = 0; i < aliveSnakes.length; i++) {
      for (let j = i + 1; j < aliveSnakes.length; j++) {
        const snake1 = aliveSnakes[i];
        const snake2 = aliveSnakes[j];
        // The list is a snapshot; snakes may have died earlier in this loop.
        if (!snake1.alive || !snake2.alive) continue;

        if (checkHeadCollision(getSnakeHead(snake1), getSnakeHead(snake2))) {
          const len1 = snake1.segments.length;
          const len2 = snake2.segments.length;

          if (len1 === len2) {
            // Tie: both die
            killSnake(snake1, snake2.id, this.match.tick);
            killSnake(snake2, snake1.id, this.match.tick);
            this.dropSnakeAsFood(snake1);
            this.dropSnakeAsFood(snake2);
          } else {
            // Bigger snake survives (no score bonus)
            const winner = len1 > len2 ? snake1 : snake2;
            const loser = winner === snake1 ? snake2 : snake1;
            killSnake(loser, winner.id, this.match.tick);
            this.dropSnakeAsFood(loser);
          }
        }
      }
    }

    // Check if all snakes are dead - end match early
    const stillAlive = Array.from(this.match.snakes.values()).filter(s => s.alive);
    if (this.match.snakes.size > 0 && stillAlive.length === 0) {
      console.log('All snakes are dead! Ending match early.');
      this.stopMatch();
      return;
    }

    // Check if only one bot remaining - last bot standing wins
    if (stillAlive.length === 1) {
      console.log(`Last bot standing: ${stillAlive[0].name}. Ending match.`);
      this.stopMatch();
      return;
    }

    // Broadcast state to spectators
    if (this.onTickCallback) {
      this.onTickCallback(this.getSpectatorState());
    }
  }

  private dropSnakeAsFood(snake: Snake): void {
    if (!this.match) return;

    // Convert the snake's score into dropped food so that
    // all the value it accumulated becomes collectible.
    const totalScore = Math.max(0, snake.score);

    if (totalScore > 0 && snake.segments.length > 0) {
      // Each dropped food has DROPPED_FOOD_VALUE points.
      // Drop roughly totalScore / DROPPED_FOOD_VALUE pellets, capped to segments count * 2
      const pelletsFromScore = Math.floor(totalScore / DROPPED_FOOD_VALUE);
      const maxPellets = snake.segments.length * 2;
      const pellets = Math.max(5, Math.min(pelletsFromScore, maxPellets));

      for (let i = 0; i < pellets; i++) {
        const idx = Math.floor(Math.random() * snake.segments.length);
        const segment = snake.segments[idx];
        const droppedFood = createDroppedFood(segment);
        this.match.food.push(droppedFood);
      }
    } else {
      // Fallback: drop along the body
      for (let i = 0; i < snake.segments.length; i += 3) {
        const segment = snake.segments[i];
        const droppedFood = createDroppedFood(segment);
        this.match.food.push(droppedFood);
      }
    }
  }

  private determineWinner(): void {
    if (!this.match) return;

    let highestScore = -1;
    let winnerId: string | undefined;

    for (const [playerId, snake] of this.match.snakes) {
      if (snake.score > highestScore) {
        highestScore = snake.score;
        winnerId = playerId;
      }
    }

    this.match.winner = winnerId;
  }

  getSpectatorState(): SpectatorGameState {
    if (!this.match) {
      throw new Error('No active match');
    }
    const match = this.match;
    const timeRemaining = Math.max(0, (match.endTime - Date.now()) / 1000);

    return {
      matchId: match.id,
      phase: match.phase,
      tick: match.tick,
      timeRemaining,
      snakes: Array.from(match.snakes.values()).map(snake => {
        const parts = resolveSkinToParts(snake.skinId);
        const survivalMs = snake.alive
          ? match.tick * TICK_INTERVAL
          : (snake.deathTick ?? 0) * TICK_INTERVAL;
        return {
          id: snake.id,
          name: snake.name,
          color: snake.color,
          bodyId: parts.bodyId,
          eyesId: parts.eyesId,
          mouthId: parts.mouthId,
          score: snake.score,
          survivalMs,
          segments: snake.segments.map(s => [s.x, s.y] as [number, number]),
          angle: snake.angle,
          boosting: snake.boosting,
          alive: snake.alive,
        };
      }),
      food: match.food.map(f => [f.x, f.y, f.value] as [number, number, number]),
    };
  }

  // Actions from players
  steerPlayer(playerId: string, angle?: number, angleDelta?: number): number | null {
    if (!this.match || this.match.phase !== 'active') return null;

    const snake = this.match.snakes.get(playerId);
    if (!snake || !snake.alive) return null;

    if (angle !== undefined) {
      snake.angle = normalizeAngle(angle);
    } else if (angleDelta !== undefined) {
      snake.angle = normalizeAngle(snake.angle + angleDelta);
    }

    return snake.angle;
  }

  setPlayerBoost(_playerId: string, _boosting: boolean): { success: boolean; snake?: Snake } {
    // Boost mechanic removed; always treat as not boosting
    return { success: true };
  }

  getPlayerState(playerId: string): Snake | undefined {
    return this.match?.snakes.get(playerId);
  }
}

function normalizeAngle(angle: number): number {
  angle = angle % 360;
  if (angle < 0) angle += 360;
  return angle;
}
