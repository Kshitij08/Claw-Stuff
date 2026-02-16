// ── Arena ──────────────────────────────────────────────────────────
export const ARENA_MIN_X = -45;
export const ARENA_MAX_X = 45;
export const ARENA_MIN_Z = -45;
export const ARENA_MAX_Z = 45;
export const ARENA_SIZE = 90; // maxX - minX

// ── Player ─────────────────────────────────────────────────────────
export const PLAYER_CAPSULE_RADIUS = 0.5;
export const PLAYER_CAPSULE_HALF_HEIGHT = 0.7; // total ~1.9m
export const PLAYER_MOVE_SPEED = 6; // units per second
export const HEALTH_PER_LIFE = 100;
export const LIVES_PER_PLAYER = 3;
export const MAX_PLAYERS = 10;
export const RESPAWN_DELAY_MS = 2000;
export const MIN_SPAWN_SEPARATION = 4;

// ── Weapons ────────────────────────────────────────────────────────
export const WEAPON_TYPES = {
  KNIFE: 'knife',
  PISTOL: 'pistol',
  SMG: 'smg',
  SHOTGUN: 'shotgun',
  ASSAULT_RIFLE: 'assault_rifle',
} as const;

export type WeaponType = typeof WEAPON_TYPES[keyof typeof WEAPON_TYPES];

export interface WeaponStats {
  type: WeaponType;
  damage: number;
  fireRate: number;   // ms cooldown between shots
  range: number;      // max hit distance (metres)
  spread: number;     // radians spread per pellet
  ammo: number | null; // null = unlimited (knife)
  pellets: number;
  isMelee: boolean;
}

export const WEAPON_STATS: Record<WeaponType, WeaponStats> = {
  [WEAPON_TYPES.KNIFE]: {
    type: WEAPON_TYPES.KNIFE,
    damage: 25,
    fireRate: 600,
    range: 2,
    spread: 0,
    ammo: null,
    pellets: 1,
    isMelee: true,
  },
  [WEAPON_TYPES.PISTOL]: {
    type: WEAPON_TYPES.PISTOL,
    damage: 15,
    fireRate: 500,
    range: 50,
    spread: 0.02,
    ammo: 10,
    pellets: 1,
    isMelee: false,
  },
  [WEAPON_TYPES.SMG]: {
    type: WEAPON_TYPES.SMG,
    damage: 8,
    fireRate: 120,
    range: 40,
    spread: 0.08,
    ammo: 20,
    pellets: 1,
    isMelee: false,
  },
  [WEAPON_TYPES.SHOTGUN]: {
    type: WEAPON_TYPES.SHOTGUN,
    damage: 12,
    fireRate: 900,
    range: 25,
    spread: 0.15,
    ammo: 5,
    pellets: 5,
    isMelee: false,
  },
  [WEAPON_TYPES.ASSAULT_RIFLE]: {
    type: WEAPON_TYPES.ASSAULT_RIFLE,
    damage: 12,
    fireRate: 150,
    range: 60,
    spread: 0.04,
    ammo: 15,
    pellets: 1,
    isMelee: false,
  },
};

export const GUN_TYPES: WeaponType[] = [
  WEAPON_TYPES.PISTOL,
  WEAPON_TYPES.SMG,
  WEAPON_TYPES.SHOTGUN,
  WEAPON_TYPES.ASSAULT_RIFLE,
];

// ── Pickups ────────────────────────────────────────────────────────
export const INITIAL_WEAPON_PICKUPS = 5;
export const PICKUP_RADIUS = 1.5; // metres – agent must be this close to pick up
export const MIN_DISTANCE_GUN_FROM_PLAYER_SPAWN = 6;
export const MIN_DISTANCE_GUN_FROM_GUN = 3;

// ── Match ──────────────────────────────────────────────────────────
export const MATCH_DURATION_MS = 4 * 60 * 1000; // 4 minutes
export const LOBBY_COUNTDOWN_MS = 15 * 1000;     // 15s after 2nd agent joins
export const RESULTS_DURATION_MS = 10 * 1000;
export const MATCH_INTERVAL_MS = 5 * 60 * 1000;

// ── Game loop ──────────────────────────────────────────────────────
export const TICK_RATE = 20;
export const TICK_INTERVAL_MS = 1000 / TICK_RATE; // 50ms

// ── Rate limiting ──────────────────────────────────────────────────
export const MAX_ACTIONS_PER_SECOND = 5;

// ── Physical bullets ────────────────────────────────────────────────
export const BULLET_RADIUS = 0.08;
export const BULLET_SPEED = 85;       // units per second
export const BULLET_MAX_AGE_MS = 2000; // remove if no hit
export const BULLET_MASS = 0.01;      // very light so they don't push players
