// Arena dimensions
export const ARENA_WIDTH = 2000;
export const ARENA_HEIGHT = 2000;

// Snake settings
export const INITIAL_SNAKE_LENGTH = 10;
export const SNAKE_SEGMENT_SIZE = 10; // Visual size of each segment
export const NORMAL_SPEED = 5; // Units per tick
export const BOOST_SPEED = 10; // Units per tick (2x normal)
export const MIN_LENGTH_TO_BOOST = 5;
export const BOOST_LENGTH_LOSS_INTERVAL = 500; // ms - lose 1 segment every 0.5s while boosting

// Food settings
export const FOOD_VALUE = 10; // Points for eating regular food
export const DROPPED_FOOD_VALUE = 5; // Points for food dropped from boosting/death
export const MAX_FOOD_COUNT = 100; // Maintain this many food items in arena
export const FOOD_SPAWN_MARGIN = 50; // Don't spawn food too close to walls

// Collision settings
export const HEAD_RADIUS = 6; // Collision radius for snake head
export const SEGMENT_RADIUS = 5; // Collision radius for body segments
export const FOOD_RADIUS = 6; // Collision radius for food
export const SELF_COLLISION_SKIP = 5; // Skip this many segments when checking self-collision

// Match settings
export const MATCH_DURATION = 4 * 60 * 1000; // 4 minutes in ms
export const LOBBY_DURATION = 60 * 1000; // 1 minute lobby before match
export const RESULTS_DURATION = 10 * 1000; // 10 seconds to show results
export const MATCH_INTERVAL = 5 * 60 * 1000; // New match every 5 minutes
export const MAX_PLAYERS = 10;

// Game loop
export const TICK_RATE = 20; // Ticks per second
export const TICK_INTERVAL = 1000 / TICK_RATE; // ms per tick

// Rate limiting
export const MAX_ACTIONS_PER_SECOND = 5;

// Kill bonus
export const KILL_BONUS_PERCENTAGE = 0.5; // Killer gets 50% of victim's score
