import { Snake, Food, Match, MatchPhase, Point, SpectatorGameState } from '../../shared/types.js';
import {
  ARENA_WIDTH,
  ARENA_HEIGHT,
  TICK_INTERVAL,
  BOOST_LENGTH_LOSS_INTERVAL,
  KILL_BONUS_PERCENTAGE,
  DROPPED_FOOD_VALUE,
} from '../../shared/constants.js';
import {
  createSnake,
  moveSnake,
  growSnake,
  shrinkSnake,
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

  addPlayer(playerId: string, name: string, color?: string): Snake | null {
    if (!this.match || this.match.phase !== 'lobby') {
      return null;
    }

    // Generate random spawn position
    const margin = 200;
    const spawnX = margin + Math.random() * (ARENA_WIDTH - 2 * margin);
    const spawnY = margin + Math.random() * (ARENA_HEIGHT - 2 * margin);
    const spawnAngle = Math.random() * 360;

    const snake = createSnake(playerId, name, spawnX, spawnY, spawnAngle, color);
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

      // Handle boost length loss
      if (snake.boosting && now - snake.lastBoostLoss >= BOOST_LENGTH_LOSS_INTERVAL) {
        const droppedSegment = shrinkSnake(snake);
        if (droppedSegment) {
          const droppedFood = createDroppedFood(droppedSegment);
          this.match.food.push(droppedFood);
          snake.lastBoostLoss = now;
        }
      }

      // Move snake
      moveSnake(snake);
      const head = getSnakeHead(snake);

      // Check wall collision
      if (checkWallCollision(head)) {
        console.log(`[DEATH] Snake ${snake.name} hit wall at tick ${this.match.tick}. Head: (${head.x.toFixed(1)}, ${head.y.toFixed(1)})`);
        killSnake(snake, undefined, this.match.tick);
        this.dropSnakeAsFood(snake);
        continue;
      }

      // Check collision with other snakes' bodies
      const collision = findCollisionTarget(head, this.match.snakes, playerId);
      if (collision) {
        const hitSnake = this.match.snakes.get(collision.snakeId);
        console.log(`[DEATH] Snake ${snake.name} hit ${collision.snakeId === playerId ? 'SELF' : hitSnake?.name} at tick ${this.match.tick}. Head: (${head.x.toFixed(1)}, ${head.y.toFixed(1)}), segment ${collision.segmentIndex}`);
        killSnake(snake, collision.snakeId, this.match.tick);
        this.dropSnakeAsFood(snake);

        // Award kill bonus to the killer
        const killer = this.match.snakes.get(collision.snakeId);
        if (killer && killer.alive) {
          const bonus = Math.floor(snake.score * KILL_BONUS_PERCENTAGE);
          killer.score += bonus;
          killer.kills = (killer.kills ?? 0) + 1;
        }
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
        if (checkHeadCollision(getSnakeHead(snake1), getSnakeHead(snake2))) {
          killSnake(snake1, snake2.id, this.match.tick);
          killSnake(snake2, snake1.id, this.match.tick);
          this.dropSnakeAsFood(snake1);
          this.dropSnakeAsFood(snake2);
          // Both get a kill credit for head-on collision
          snake1.kills = (snake1.kills ?? 0) + 1;
          snake2.kills = (snake2.kills ?? 0) + 1;
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

    const timeRemaining = Math.max(0, (this.match.endTime - Date.now()) / 1000);

    return {
      matchId: this.match.id,
      phase: this.match.phase,
      tick: this.match.tick,
      timeRemaining,
      snakes: Array.from(this.match.snakes.values()).map(snake => ({
        id: snake.id,
        name: snake.name,
        color: snake.color,
        score: snake.score,
        segments: snake.segments.map(s => [s.x, s.y] as [number, number]),
        angle: snake.angle,
        boosting: snake.boosting,
        alive: snake.alive,
      })),
      food: this.match.food.map(f => [f.x, f.y, f.value] as [number, number, number]),
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

  setPlayerBoost(playerId: string, boosting: boolean): { success: boolean; snake?: Snake } {
    if (!this.match || this.match.phase !== 'active') {
      return { success: false };
    }

    const snake = this.match.snakes.get(playerId);
    if (!snake || !snake.alive) {
      return { success: false };
    }

    if (boosting && snake.segments.length < 5) {
      return { success: false };
    }

    snake.boosting = boosting;
    snake.speed = boosting ? 10 : 5;
    if (boosting) {
      snake.lastBoostLoss = Date.now();
    }

    return { success: true, snake };
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
