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
    damage: 22,
    fireRate: 650,
    range: 2,
    spread: 0,
    ammo: null,
    pellets: 1,
    isMelee: true,
  },
  [WEAPON_TYPES.PISTOL]: {
    type: WEAPON_TYPES.PISTOL,
    damage: 18,
    fireRate: 450,
    range: 50,
    spread: 0.015,
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
export const LOBBY_COUNTDOWN_MS = 90 * 1000;     // 90s lobby for betting window
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

/** Super aggressive: high detect, close preferred, fast, never flee. */
export const PERSONALITY_MODS: Record<PersonalityType, PersonalityMods> = {
  Aggressive: { detectRadius: 95, preferredDist: 3, speedMult: 1.35, fleeHealth: 0, accuracy: 0.86 },
  Cautious:   { detectRadius: 90, preferredDist: 4, speedMult: 1.28, fleeHealth: 0, accuracy: 0.80 },
  Sniper:     { detectRadius: 95, preferredDist: 8, speedMult: 1.22, fleeHealth: 0, accuracy: 0.92 },
  Rusher:     { detectRadius: 88, preferredDist: 2, speedMult: 1.50, fleeHealth: 0, accuracy: 0.72 },
  Tactician:  { detectRadius: 90, preferredDist: 4, speedMult: 1.30, fleeHealth: 0, accuracy: 0.84 },
};

/** Weapon tier for matchup evaluation (higher = stronger at range; knife=0). */
export const WEAPON_TIER: Record<WeaponType, number> = {
  [WEAPON_TYPES.KNIFE]: 0,
  [WEAPON_TYPES.PISTOL]: 1,
  [WEAPON_TYPES.SMG]: 2,
  [WEAPON_TYPES.SHOTGUN]: 2.5,
  [WEAPON_TYPES.ASSAULT_RIFLE]: 3,
};

// ── Spawn / floor ───────────────────────────────────────────────────
/** Subtract this from min(spawn Y) so bots spawn on the ground, not floating. */
export const SPAWN_FLOOR_Y_OFFSET = 1.2;

// ── Bot AI tuning constants ─────────────────────────────────────────
/** Melee trigger range (server uses knife range + 1.5 so hits up to ~3.5m). */
export const BOT_MELEE_RANGE = 3.5;
export const BOT_KNIFE_RUSH_RADIUS = 15;
/** When a gun bot has enemy closer than this, kite backward (retreat) to maintain range. */
export const BOT_KITE_DIST = 10;
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
/** When in no-LOS standoff (e.g. wall between bots), move this long in break direction to escape chase. */
export const BOT_NO_LOS_STANDOFF_BREAK_DURATION_MS = 2800;
export const BOT_NO_LOS_EXCLUDE_DURATION_MS = 2000;
export const BOT_NO_LOS_PATH_PERSIST_MS = 500;
export const BOT_STRAFE_CHANGE_INTERVAL_MS = 800;
export const BOT_WANDER_CHANGE_MIN_MS = 800;
export const BOT_WANDER_CHANGE_MAX_MS = 1500;
export const BOT_LOW_AMMO_THRESHOLD = 3;
/** Minimum time to keep the same target before allowing a switch (reduces flip-flopping). */
export const BOT_TARGET_LOCK_MIN_MS = 4000;
/** If bot hasn't moved for this long and no enemies nearby, force wander to find a new target. */
export const BOT_STUCK_WANDER_MS = 3000;
/** Effective "no limit" radius for target/weapon selection — if it's on the map, bot targets it. */
export const BOT_TARGET_NO_LIMIT = 500;
