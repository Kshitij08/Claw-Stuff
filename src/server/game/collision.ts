import { Point, Snake, Food, Segment } from '../../shared/types.js';
import {
  HEAD_RADIUS,
  SEGMENT_RADIUS,
  FOOD_RADIUS,
  ARENA_WIDTH,
  ARENA_HEIGHT,
  SELF_COLLISION_SKIP,
} from '../../shared/constants.js';

// Simple distance calculation
function distance(p1: Point, p2: Point): number {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// Check if two circles collide
function circlesCollide(p1: Point, r1: number, p2: Point, r2: number): boolean {
  return distance(p1, p2) < r1 + r2;
}

// Check if snake head collides with food
export function checkFoodCollision(head: Point, food: Food): boolean {
  return circlesCollide(head, HEAD_RADIUS, food, FOOD_RADIUS);
}

// Check if snake head collides with another snake's body
export function checkSnakeCollision(
  head: Point,
  targetSnake: Snake,
  isOwnSnake: boolean = false
): boolean {
  // Skip first few segments if checking own snake (head can't hit itself)
  const startIndex = isOwnSnake ? SELF_COLLISION_SKIP : 0;
  
  for (let i = startIndex; i < targetSnake.segments.length; i++) {
    const segment = targetSnake.segments[i];
    if (circlesCollide(head, HEAD_RADIUS, segment, SEGMENT_RADIUS)) {
      return true;
    }
  }
  return false;
}

// Check if snake head is past arena walls (used to trigger wrap)
export function checkWallCollision(head: Point): boolean {
  return (
    head.x - HEAD_RADIUS < 0 ||
    head.x + HEAD_RADIUS > ARENA_WIDTH ||
    head.y - HEAD_RADIUS < 0 ||
    head.y + HEAD_RADIUS > ARENA_HEIGHT
  );
}

// Wrap a point to the opposite side of the arena (toroidal / classic snake wrap)
export function wrapPointInArena(point: Point): void {
  point.x = ((point.x % ARENA_WIDTH) + ARENA_WIDTH) % ARENA_WIDTH;
  point.y = ((point.y % ARENA_HEIGHT) + ARENA_HEIGHT) % ARENA_HEIGHT;
}

// Check if two snake heads collide (both die)
export function checkHeadCollision(head1: Point, head2: Point): boolean {
  return circlesCollide(head1, HEAD_RADIUS, head2, HEAD_RADIUS);
}

// Spatial hash for efficient collision detection with many snakes
export class SpatialHash {
  private cellSize: number;
  private grid: Map<string, { snakeId: string; segmentIndex: number; point: Point }[]>;
  
  constructor(cellSize: number = 50) {
    this.cellSize = cellSize;
    this.grid = new Map();
  }
  
  private getCellKey(x: number, y: number): string {
    const cellX = Math.floor(x / this.cellSize);
    const cellY = Math.floor(y / this.cellSize);
    return `${cellX},${cellY}`;
  }
  
  clear(): void {
    this.grid.clear();
  }
  
  insertSnake(snake: Snake): void {
    snake.segments.forEach((segment, index) => {
      const key = this.getCellKey(segment.x, segment.y);
      if (!this.grid.has(key)) {
        this.grid.set(key, []);
      }
      this.grid.get(key)!.push({
        snakeId: snake.id,
        segmentIndex: index,
        point: segment,
      });
    });
  }
  
  // Get all segments near a point
  getNearbySegments(point: Point, radius: number): { snakeId: string; segmentIndex: number; point: Point }[] {
    const results: { snakeId: string; segmentIndex: number; point: Point }[] = [];
    
    // Check all cells that could contain nearby segments
    const minCellX = Math.floor((point.x - radius) / this.cellSize);
    const maxCellX = Math.floor((point.x + radius) / this.cellSize);
    const minCellY = Math.floor((point.y - radius) / this.cellSize);
    const maxCellY = Math.floor((point.y + radius) / this.cellSize);
    
    for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
      for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
        const key = `${cellX},${cellY}`;
        const cell = this.grid.get(key);
        if (cell) {
          results.push(...cell);
        }
      }
    }
    
    return results;
  }
}

// Find which snake's body a head collided with
export function findCollisionTarget(
  head: Point,
  snakes: Map<string, Snake>,
  excludeSnakeId: string
): { snakeId: string; segmentIndex: number } | null {
  for (const [snakeId, snake] of snakes) {
    if (!snake.alive) continue;
    
    const isOwnSnake = snakeId === excludeSnakeId;
    const startIndex = isOwnSnake ? SELF_COLLISION_SKIP : 0;
    
    for (let i = startIndex; i < snake.segments.length; i++) {
      if (circlesCollide(head, HEAD_RADIUS, snake.segments[i], SEGMENT_RADIUS)) {
        return { snakeId, segmentIndex: i };
      }
    }
  }
  return null;
}
