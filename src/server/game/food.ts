import { Food, Point } from '../../shared/types.js';
import {
  ARENA_WIDTH,
  ARENA_HEIGHT,
  FOOD_VALUE,
  DROPPED_FOOD_VALUE,
  MAX_FOOD_COUNT,
  FOOD_SPAWN_MARGIN,
} from '../../shared/constants.js';

let foodIdCounter = 0;

function generateFoodId(): string {
  return `food_${++foodIdCounter}`;
}

export function createFood(x: number, y: number, value: number = FOOD_VALUE): Food {
  return {
    id: generateFoodId(),
    x,
    y,
    value,
  };
}

export function createRandomFood(): Food {
  const x = FOOD_SPAWN_MARGIN + Math.random() * (ARENA_WIDTH - 2 * FOOD_SPAWN_MARGIN);
  const y = FOOD_SPAWN_MARGIN + Math.random() * (ARENA_HEIGHT - 2 * FOOD_SPAWN_MARGIN);
  return createFood(x, y, FOOD_VALUE);
}

export function createDroppedFood(position: Point): Food {
  // Add slight randomization to position so dropped food spreads out
  const offsetX = (Math.random() - 0.5) * 20;
  const offsetY = (Math.random() - 0.5) * 20;
  return createFood(
    position.x + offsetX,
    position.y + offsetY,
    DROPPED_FOOD_VALUE
  );
}

export function spawnInitialFood(): Food[] {
  const food: Food[] = [];
  for (let i = 0; i < MAX_FOOD_COUNT; i++) {
    food.push(createRandomFood());
  }
  return food;
}

export function maintainFoodCount(currentFood: Food[]): Food[] {
  const newFood = [...currentFood];
  while (newFood.length < MAX_FOOD_COUNT) {
    newFood.push(createRandomFood());
  }
  return newFood;
}

export function removeFood(foodArray: Food[], foodId: string): Food[] {
  return foodArray.filter(f => f.id !== foodId);
}

export function resetFoodCounter(): void {
  foodIdCounter = 0;
}
