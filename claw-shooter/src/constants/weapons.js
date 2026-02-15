// Weapon types
export const WEAPON_TYPES = {
  KNIFE: "knife",
  PISTOL: "pistol",
  SMG: "smg",
  SHOTGUN: "shotgun",
  ASSAULT_RIFLE: "assault_rifle",
};

// Knife (default, melee, no ammo)
export const KNIFE = {
  type: WEAPON_TYPES.KNIFE,
  damage: 25,
  fireRate: 600,
  range: 1.5,
  ammo: null, // unlimited
  isMelee: true,
};

// Gun stats: damage, fireRate (ms), speed, spread, ammo, color (hex)
export const WEAPON_STATS = {
  [WEAPON_TYPES.KNIFE]: KNIFE,
  [WEAPON_TYPES.PISTOL]: {
    type: WEAPON_TYPES.PISTOL,
    damage: 15,
    fireRate: 500,
    speed: 20,
    spread: 0.02,
    ammo: 10,
    pellets: 1,
    isMelee: false,
    color: 0xffff00,
  },
  [WEAPON_TYPES.SMG]: {
    type: WEAPON_TYPES.SMG,
    damage: 8,
    fireRate: 120,
    speed: 22,
    spread: 0.08,
    ammo: 20,
    pellets: 1,
    isMelee: false,
    color: 0xff8800,
  },
  [WEAPON_TYPES.SHOTGUN]: {
    type: WEAPON_TYPES.SHOTGUN,
    damage: 12,
    fireRate: 900,
    speed: 18,
    spread: 0.15,
    ammo: 5,
    pellets: 5,
    isMelee: false,
    color: 0xff0000,
  },
  [WEAPON_TYPES.ASSAULT_RIFLE]: {
    type: WEAPON_TYPES.ASSAULT_RIFLE,
    damage: 12,
    fireRate: 150,
    speed: 25,
    spread: 0.04,
    ammo: 15,
    pellets: 1,
    isMelee: false,
    color: 0x00ffff,
  },
};

export const GUN_TYPES = [
  WEAPON_TYPES.PISTOL,
  WEAPON_TYPES.SMG,
  WEAPON_TYPES.SHOTGUN,
  WEAPON_TYPES.ASSAULT_RIFLE,
];

export const BOT_NAMES = [
  "Alpha",
  "Bravo",
  "Charlie",
  "Delta",
  "Echo",
  "Foxtrot",
  "Ghost",
  "Hawk",
  "Iron",
  "Jinx",
];

export const PERSONALITIES = [
  "Aggressive",
  "Cautious",
  "Sniper",
  "Rusher",
  "Tactician",
];

export const LIVES_PER_BOT = 3;
export const HEALTH_PER_LIFE = 100;
export const PLAYER_COUNT = 4;

/** Play area bounds so bots don't wander off the map (x and z; y is unchanged) */
export const MAP_BOUNDS = {
  minX: -45,
  maxX: 45,
  minZ: -45,
  maxZ: 45,
};

/** Min distance (m) between gun pickup spawn and any player spawn so guns don't sit on bot spawns */
export const MIN_DISTANCE_GUN_FROM_PLAYER_SPAWN = 6;

/** Min distance (m) between any two player spawns so they never spawn on top of each other */
export const MIN_SPAWN_SEPARATION = 4;

/** Human-readable weapon names for UI */
export const WEAPON_LABELS = {
  [WEAPON_TYPES.KNIFE]: "Knife",
  [WEAPON_TYPES.PISTOL]: "Pistol",
  [WEAPON_TYPES.SMG]: "SMG",
  [WEAPON_TYPES.SHOTGUN]: "Shotgun",
  [WEAPON_TYPES.ASSAULT_RIFLE]: "Assault Rifle",
};

/** Delay (ms) before a new set of weapon pickups spawns after all are taken */
export const WEAPON_RESPAWN_DELAY = 5000;
