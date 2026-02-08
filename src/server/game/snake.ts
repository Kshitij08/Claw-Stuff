import { Snake, Segment, Point } from '../../shared/types.js';
import { DEFAULT_SKIN_ID } from '../../shared/skins.js';
import {
  INITIAL_SNAKE_LENGTH,
  NORMAL_SPEED,
  SEGMENT_SPACING_FRONT,
  SEGMENT_SPACING_TAIL,
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
  skinId: string = DEFAULT_SKIN_ID,
): Snake {
  const segments: Segment[] = [];
  const angleRad = (spawnAngle * Math.PI) / 180;
  // Tapered spacing: large gap at head, decreasing toward tail
  const n = INITIAL_SNAKE_LENGTH;
  let run = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const t = n <= 1 ? 0 : (i - 1) / (n - 1);
      const gap = SEGMENT_SPACING_FRONT - t * (SEGMENT_SPACING_FRONT - SEGMENT_SPACING_TAIL);
      run += gap;
    }
    const dx = -Math.cos(angleRad) * run;
    const dy = -Math.sin(angleRad) * run;
    segments.push({ x: spawnX + dx, y: spawnY + dy });
  }
  
  return {
    id,
    name,
    color: color || getNextColor(),
    skinId,
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

function dist(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Required gap before adding a new segment; larger when snake is longer so front has big gaps, tail stays tight. */
function requiredSegmentSpacing(segmentCount: number): number {
  const range = SEGMENT_SPACING_FRONT - SEGMENT_SPACING_TAIL;
  const growth = Math.max(0, segmentCount - INITIAL_SNAKE_LENGTH);
  const cap = 26; // growth range over which we go from TAIL to FRONT spacing (larger = tail stays tight for more segments)
  const t = Math.min(1, growth / cap);
  return SEGMENT_SPACING_TAIL + t * range;
}

export function moveSnake(snake: Snake): void {
  if (!snake.alive) return;
  const head = snake.segments[0];
  const angleRad = (snake.angle * Math.PI) / 180;
  const newHead: Segment = {
    x: head.x + Math.cos(angleRad) * snake.speed,
    y: head.y + Math.sin(angleRad) * snake.speed,
  };
  const len = snake.segments.length;
  const required = len <= 1 ? SEGMENT_SPACING_TAIL : requiredSegmentSpacing(len);
  const distToNext = len <= 1 ? required + 1 : dist(newHead, snake.segments[1]);
  if (distToNext >= required) {
    snake.segments.unshift(newHead);
    snake.segments.pop();
  } else {
    (snake.segments[0] as Segment).x = newHead.x;
    (snake.segments[0] as Segment).y = newHead.y;
  }
}

export function growSnake(snake: Snake, amount: number = 1): void {
  // Add segments at the tail
  const tail = snake.segments[snake.segments.length - 1];
  for (let i = 0; i < amount; i++) {
    snake.segments.push({ ...tail });
  }
}

export function setSnakeBoost(snake: Snake, _boosting: boolean): boolean {
  // Boost mechanic removed; always keep normal speed
  snake.boosting = false;
  snake.speed = NORMAL_SPEED;
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
