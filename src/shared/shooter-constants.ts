// ── Arena ──────────────────────────────────────────────────────────
export const ARENA_MIN_X = -45;
export const ARENA_MAX_X = 45;
export const ARENA_MIN_Z = -45;
export const ARENA_MAX_Z = 45;
export const ARENA_SIZE = 90; // maxX - minX
/** Minimum valid Y (capsule center). Below this = fell off map → respawn. Floor is at -10. */
export const ARENA_MIN_Y = -9;

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
// Gun types: pistol, smg, shotgun, assault_rifle. Each has damage, fireRate (ms),
// range (m), spread (rad), ammo count, pellets (shotgun = 5). Shooting pattern
// and ammo consumption are in the engine (handleShoot uses stats.pellets + spread).
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
export const PICKUP_RADIUS = 2.0; // metres – agent must be this close to pick up (generous to avoid running past)
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
export const MAX_ACTIONS_PER_SECOND = 10;

// ── Physical bullets ────────────────────────────────────────────────
export const BULLET_RADIUS = 0.08;
export const BULLET_SPEED = 85;       // units per second
export const BULLET_MAX_AGE_MS = 2000; // remove if no hit
export const BULLET_MASS = 0.01;      // very light so they don't push players

// ── Bot AI ──────────────────────────────────────────────────────────
export const BOT_NAMES = [
  'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo',
  'Foxtrot', 'Ghost', 'Hawk', 'Iron', 'Jinx',
] as const;

export const PERSONALITIES = [
  'Aggressive', 'Cautious', 'Sniper', 'Rusher', 'Tactician',
] as const;
export type PersonalityType = typeof PERSONALITIES[number];

/**
 * Personality modifiers that control bot behaviour.
 *  detectRadius  – how far the bot "sees" enemies (metres)
 *  preferredDist – ideal combat distance (positioning, not shooting)
 *  speedMult     – movement speed multiplier
 *  fleeHealth    – HP threshold below which the bot retreats (0 = never)
 *  accuracy      – 0-1, tighter bullet spread for higher values
 */
export interface PersonalityMods {
  detectRadius: number;
  preferredDist: number;
  speedMult: number;
  fleeHealth: number;
  accuracy: number;
}

export const PERSONALITY_MODS: Record<PersonalityType, PersonalityMods> = {
  Aggressive: { detectRadius: 75, preferredDist: 5, speedMult: 1.25, fleeHealth: 0, accuracy: 0.82 },
  Cautious:   { detectRadius: 75, preferredDist: 6, speedMult: 1.20, fleeHealth: 0, accuracy: 0.75 },
  Sniper:     { detectRadius: 80, preferredDist: 10, speedMult: 1.15, fleeHealth: 0, accuracy: 0.92 },
  Rusher:     { detectRadius: 70, preferredDist: 3, speedMult: 1.40, fleeHealth: 0, accuracy: 0.68 },
  Tactician:  { detectRadius: 75, preferredDist: 6, speedMult: 1.20, fleeHealth: 0, accuracy: 0.80 },
};

/** Weapon tier for matchup evaluation (higher = stronger at range; knife=0). */
export const WEAPON_TIER: Record<WeaponType, number> = {
  [WEAPON_TYPES.KNIFE]: 0,
  [WEAPON_TYPES.PISTOL]: 1,
  [WEAPON_TYPES.SMG]: 2,
  [WEAPON_TYPES.SHOTGUN]: 2.5,
  [WEAPON_TYPES.ASSAULT_RIFLE]: 3,
};

// ── Bot AI tuning constants ─────────────────────────────────────────
export const BOT_MELEE_RANGE = 3.0;
export const BOT_KNIFE_RUSH_RADIUS = 15;
export const BOT_OBSTACLE_LOOKAHEAD = 3;
export const BOT_LOS_RAY_HEIGHT = 1.3;
export const BOT_STUCK_CHECK_INTERVAL_MS = 300;
export const BOT_STUCK_DISTANCE_THRESHOLD = 0.3;
export const BOT_STUCK_TIME_THRESHOLD_MS = 800;
export const BOT_STUCK_RECOVERY_DURATIONS = [500, 900, 1400];
export const BOT_STALEMATE_CHECK_INTERVAL_MS = 500;
export const BOT_STALEMATE_DIST_DELTA = 0.25;
export const BOT_STALEMATE_TIME_THRESHOLD_MS = 3000;
export const BOT_NO_LOS_STANDOFF_MS = 2000;
export const BOT_NO_LOS_EXCLUDE_DURATION_MS = 2000;
export const BOT_NO_LOS_PATH_PERSIST_MS = 500;
export const BOT_STRAFE_CHANGE_INTERVAL_MS = 800;
export const BOT_WANDER_CHANGE_MIN_MS = 800;
export const BOT_WANDER_CHANGE_MAX_MS = 1500;
export const BOT_LOW_AMMO_THRESHOLD = 3;
