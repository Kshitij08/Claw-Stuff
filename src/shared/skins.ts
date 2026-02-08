/**
 * Snake skins are composed from three layered PNG assets under public/skins/:
 * - Body/  — base skin/pattern (e.g. Body/Common/aqua.png)
 * - Eyes/  — eye style (e.g. Eyes/Common/happy.png)
 * - Mouth/ — mouth style (e.g. Mouth/Common/Monster 1.png)
 *
 * Head = body + eyes + mouth stacked; trailing segments use body only.
 */

export interface SkinParts {
  bodyId: string;
  eyesId: string;
  mouthId: string;
}

/** Preset skin IDs and their Body/Eyes/Mouth paths (relative to Body/, Eyes/, Mouth/). */
export const SKIN_PRESETS: Record<string, SkinParts> = {
  default: {
    bodyId: 'Common/aqua.png',
    eyesId: 'Common/happy.png',
    mouthId: 'Common/Monster 1.png',
  },
  neon: {
    bodyId: 'Rare/galaxy.png',
    eyesId: 'Rare/hypnotise.png',
    mouthId: 'Rare/gremlin 3.png',
  },
  cyber: {
    bodyId: 'Legendary/chrome 1.png',
    eyesId: 'Legendary/clown 1.png',
    mouthId: 'Legendary/goblin 5.png',
  },
};

export const DEFAULT_SKIN_ID = 'default';

/**
 * Resolve snake skin to body/eyes/mouth part IDs.
 * - If skinId is a preset name (e.g. "default"), return that preset.
 * - If skinId is JSON like '{"bodyId":"...","eyesId":"...","mouthId":"..."}', parse and return.
 * - Otherwise return default preset.
 */
export function resolveSkinToParts(skinId: string): SkinParts {
  const preset = SKIN_PRESETS[skinId];
  if (preset) return preset;
  try {
    const parsed = JSON.parse(skinId) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      'bodyId' in parsed &&
      'eyesId' in parsed &&
      'mouthId' in parsed &&
      typeof (parsed as SkinParts).bodyId === 'string' &&
      typeof (parsed as SkinParts).eyesId === 'string' &&
      typeof (parsed as SkinParts).mouthId === 'string'
    ) {
      return parsed as SkinParts;
    }
  } catch {
    // not JSON, fall through
  }
  return SKIN_PRESETS[DEFAULT_SKIN_ID];
}

export function isValidSkinId(skinId: string): boolean {
  return skinId in SKIN_PRESETS;
}

/** Build skin_id value to store when using a custom body/eyes/mouth combo. */
export function toStoredSkinId(parts: SkinParts): string {
  return JSON.stringify(parts);
}