/**
 * Shooter game constants (aligned with claw-shooter/src/constants/weapons.js where applicable).
 */

export const WEAPON_TYPES = {
  KNIFE: 'knife',
  PISTOL: 'pistol',
  SMG: 'smg',
  SHOTGUN: 'shotgun',
  ASSAULT_RIFLE: 'assault_rifle',
} as const;

export type WeaponType = (typeof WEAPON_TYPES)[keyof typeof WEAPON_TYPES];

export const GUN_TYPES: WeaponType[] = [
  WEAPON_TYPES.PISTOL,
  WEAPON_TYPES.SMG,
  WEAPON_TYPES.SHOTGUN,
  WEAPON_TYPES.ASSAULT_RIFLE,
];

export interface WeaponStats {
  type: WeaponType;
  damage: number;
  fireRate: number; // ms between shots
  range: number;
  ammo: number | null;
  isMelee: boolean;
}

export const WEAPON_STATS: Record<string, WeaponStats> = {
  [WEAPON_TYPES.KNIFE]: {
    type: WEAPON_TYPES.KNIFE,
    damage: 25,
    fireRate: 600,
    range: 1.5,
    ammo: null,
    isMelee: true,
  },
  [WEAPON_TYPES.PISTOL]: {
    type: WEAPON_TYPES.PISTOL,
    damage: 15,
    fireRate: 500,
    range: 50,
    ammo: 10,
    isMelee: false,
  },
  [WEAPON_TYPES.SMG]: {
    type: WEAPON_TYPES.SMG,
    damage: 8,
    fireRate: 120,
    range: 45,
    ammo: 20,
    isMelee: false,
  },
  [WEAPON_TYPES.SHOTGUN]: {
    type: WEAPON_TYPES.SHOTGUN,
    damage: 12,
    fireRate: 900,
    range: 25,
    ammo: 5,
    isMelee: false,
  },
  [WEAPON_TYPES.ASSAULT_RIFLE]: {
    type: WEAPON_TYPES.ASSAULT_RIFLE,
    damage: 12,
    fireRate: 150,
    range: 55,
    ammo: 15,
    isMelee: false,
  },
};

export const LIVES_PER_PLAYER = 3;
export const HEALTH_PER_LIFE = 100;

/** Map bounds (x and z; y is 0 for 2D top-down style on server) */
export const MAP_BOUNDS = {
  minX: -45,
  maxX: 45,
  minZ: -45,
  maxZ: 45,
};

export const MOVEMENT_SPEED = 260 / 1000; // units per ms (client uses 260, we tick in ms)
export const TICK_MS = 50; // 20 ticks per second

export const SHOOTER_LOBBY_DURATION = 90 * 1000; // 90s countdown after 2nd join
export const SHOOTER_MATCH_DURATION = 4 * 60 * 1000; // 4 minutes
export const SHOOTER_RESULTS_DURATION = 10 * 1000; // 10s results
export const SHOOTER_BETTING_CLOSE_BEFORE_START = 10 * 1000; // close betting 10s before match start

export const MAX_SHOOTER_PLAYERS = 10;
export const MAX_ACTIONS_PER_SECOND = 10;

/** Minimum distance between player spawn points */
export const MIN_SPAWN_SEPARATION = 4;
/** Number of weapon pickups at match start */
export const INITIAL_WEAPON_PICKUPS = 5;
export const MIN_DISTANCE_GUN_FROM_PLAYER = 6;
export const MIN_DISTANCE_GUN_FROM_GUN = 3;
