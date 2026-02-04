import { Snake, Segment, Point } from '../../shared/types.js';
import {
  INITIAL_SNAKE_LENGTH,
  NORMAL_SPEED,
  BOOST_SPEED,
  MIN_LENGTH_TO_BOOST,
  SNAKE_SEGMENT_SIZE,
} from '../../shared/constants.js';

// Predefined colors for snakes
const SNAKE_COLORS = [
  '#FF6B6B', // Red
  '#4ECDC4', // Teal
  '#45B7D1', // Blue
  '#96CEB4', // Green
  '#FFEAA7', // Yellow
  '#DDA0DD', // Plum
  '#98D8C8', // Mint
  '#F7DC6F', // Gold
  '#BB8FCE', // Purple
  '#85C1E9', // Light Blue
];

let colorIndex = 0;

function getNextColor(): string {
  const color = SNAKE_COLORS[colorIndex % SNAKE_COLORS.length];
  colorIndex++;
  return color;
}

export function createSnake(
  id: string,
  name: string,
  spawnX: number,
  spawnY: number,
  spawnAngle: number,
  color?: string, // optional custom color
): Snake {
  const segments: Segment[] = [];
  
  // Create initial segments behind the head
  const angleRad = (spawnAngle * Math.PI) / 180;
  const dx = -Math.cos(angleRad) * SNAKE_SEGMENT_SIZE;
  const dy = -Math.sin(angleRad) * SNAKE_SEGMENT_SIZE;
  
  for (let i = 0; i < INITIAL_SNAKE_LENGTH; i++) {
    segments.push({
      x: spawnX + dx * i,
      y: spawnY + dy * i,
    });
  }
  
  return {
    id,
    name,
    color: color || getNextColor(),
    segments,
    angle: spawnAngle,
    speed: NORMAL_SPEED,
    boosting: false,
    score: 0,
    kills: 0,
    alive: true,
    lastBoostLoss: 0,
  };
}

export function getSnakeHead(snake: Snake): Point {
  return snake.segments[0];
}

export function moveSnake(snake: Snake): void {
  if (!snake.alive) return;
  
  const head = snake.segments[0];
  const angleRad = (snake.angle * Math.PI) / 180;
  
  // Calculate new head position
  const newHead: Segment = {
    x: head.x + Math.cos(angleRad) * snake.speed,
    y: head.y + Math.sin(angleRad) * snake.speed,
  };
  
  // Add new head at front
  snake.segments.unshift(newHead);
  
  // Remove tail (unless growing)
  snake.segments.pop();
}

export function growSnake(snake: Snake, amount: number = 1): void {
  // Add segments at the tail
  const tail = snake.segments[snake.segments.length - 1];
  for (let i = 0; i < amount; i++) {
    snake.segments.push({ ...tail });
  }
}

export function shrinkSnake(snake: Snake): Segment | null {
  if (snake.segments.length <= MIN_LENGTH_TO_BOOST) {
    snake.boosting = false;
    snake.speed = NORMAL_SPEED;
    return null;
  }
  
  // Remove and return the tail segment
  return snake.segments.pop() || null;
}

export function setSnakeBoost(snake: Snake, boosting: boolean): boolean {
  if (boosting && snake.segments.length < MIN_LENGTH_TO_BOOST) {
    return false; // Can't boost if too short
  }
  
  snake.boosting = boosting;
  snake.speed = boosting ? BOOST_SPEED : NORMAL_SPEED;
  return true;
}

export function steerSnake(snake: Snake, newAngle?: number, angleDelta?: number): number {
  if (newAngle !== undefined) {
    // Absolute angle
    snake.angle = normalizeAngle(newAngle);
  } else if (angleDelta !== undefined) {
    // Relative angle
    snake.angle = normalizeAngle(snake.angle + angleDelta);
  }
  return snake.angle;
}

export function killSnake(snake: Snake, killedBy?: string, tick?: number): void {
  snake.alive = false;
  snake.boosting = false;
  snake.speed = 0;
  snake.killedBy = killedBy;
  snake.deathTick = tick;
}

function normalizeAngle(angle: number): number {
  // Normalize angle to 0-360 range
  angle = angle % 360;
  if (angle < 0) angle += 360;
  return angle;
}

export function resetColorIndex(): void {
  colorIndex = 0;
}
