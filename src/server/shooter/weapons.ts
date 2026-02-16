/**
 * Weapon helpers for the shooter game engine.
 * Stats are defined in shooter-constants.ts; this module provides
 * convenience functions used by the engine.
 */

import {
  WEAPON_STATS,
  WEAPON_TYPES,
  GUN_TYPES,
  type WeaponType,
} from '../../shared/shooter-constants.js';

export { WEAPON_STATS, WEAPON_TYPES, GUN_TYPES };

/** Returns true if the weapon can fire (enough ammo, cooldown elapsed). */
export function canFire(
  weapon: WeaponType,
  ammo: number | null,
  lastShotTime: number,
  now: number,
): boolean {
  const stats = WEAPON_STATS[weapon];
  if (!stats) return false;
  if (now - lastShotTime < stats.fireRate) return false;
  if (stats.isMelee) return true;
  if (ammo !== null && ammo <= 0) return false;
  return true;
}

/** Consume one shot's worth of ammo. Returns the new ammo count. */
export function consumeAmmo(ammo: number | null): number | null {
  if (ammo === null) return null; // unlimited (knife)
  return Math.max(0, ammo - 1);
}

/** Pick a random gun type for weapon pickups. */
export function randomGunType(): WeaponType {
  return GUN_TYPES[Math.floor(Math.random() * GUN_TYPES.length)];
}

/** Human-readable weapon labels. */
export const WEAPON_LABELS: Record<WeaponType, string> = {
  [WEAPON_TYPES.KNIFE]: 'Knife',
  [WEAPON_TYPES.PISTOL]: 'Pistol',
  [WEAPON_TYPES.SMG]: 'SMG',
  [WEAPON_TYPES.SHOTGUN]: 'Shotgun',
  [WEAPON_TYPES.ASSAULT_RIFLE]: 'Assault Rifle',
};
