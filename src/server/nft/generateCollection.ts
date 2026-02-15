/**
 * Generates the definitive collection of 5555 combined skin NFTs.
 * Each entry is a unique Body+Eyes+Mouth combo with additive rarity scoring.
 * Run: npx tsx src/server/nft/generateCollection.ts
 * Output: src/server/nft/collection.json
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import { getSkinOptions } from '../skinOptions.js';

const MAX_SUPPLY = 5555;

/** Rarity tier names by combined score (3–9). */
const RARITY_TIERS: Record<number, string> = {
  3: 'Common',
  4: 'Uncommon',
  5: 'Rare',
  6: 'Epic',
  7: 'Mythic',
  8: 'Ultra',
  9: 'Legendary',
};

/** Score per part rarity (path prefix). */
const RARITY_SCORE: Record<string, number> = {
  Common: 1,
  Rare: 2,
  Legendary: 3,
};

/** Fallback parts when no PNGs on disk (from SKIN_PRESETS). */
const FALLBACK_PARTS = {
  bodies: ['Common/aqua.png', 'Rare/galaxy.png', 'Legendary/chrome 1.png'],
  eyes: ['Common/happy.png', 'Rare/hypnotise.png', 'Legendary/clown 1.png'],
  mouths: ['Common/Monster 1.png', 'Rare/gremlin 3.png', 'Legendary/goblin 5.png'],
};

type Rarity = 'Common' | 'Rare' | 'Legendary';

interface PartWithRarity {
  path: string;
  rarity: Rarity;
  score: number;
}

interface Combo {
  bodyId: string;
  eyesId: string;
  mouthId: string;
  bodyRarity: Rarity;
  eyesRarity: Rarity;
  mouthRarity: Rarity;
  rarityScore: number;
  tier: string;
}

/** Extract rarity from path (e.g. "Common/aqua.png" -> Common). */
function getRarityFromPath(path: string): Rarity {
  const segment = path.split('/')[0];
  if (segment === 'Rare' || segment === 'Legendary') return segment;
  return 'Common';
}

/** Build part lists with rarity. Use fallback if options empty. */
function getPartsWithRarity(): {
  bodies: PartWithRarity[];
  eyes: PartWithRarity[];
  mouths: PartWithRarity[];
} {
  const options = getSkinOptions();
  const toParts = (paths: string[]): PartWithRarity[] =>
    paths.map((path) => {
      const rarity = getRarityFromPath(path);
      return { path, rarity, score: RARITY_SCORE[rarity] ?? 1 };
    });

  const bodies =
    options.bodies.length > 0 ? toParts(options.bodies) : toParts(FALLBACK_PARTS.bodies);
  const eyes =
    options.eyes.length > 0 ? toParts(options.eyes) : toParts(FALLBACK_PARTS.eyes);
  const mouths =
    options.mouths.length > 0 ? toParts(options.mouths) : toParts(FALLBACK_PARTS.mouths);

  return { bodies, eyes, mouths };
}

/** Seeded simple RNG for reproducible generation. */
function createRng(seed: number) {
  let s = seed;
  return function next(): number {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/** Weighted pick: ~60% Common, ~30% Rare, ~10% Legendary. */
function weightedPick<T>(arr: T[], rng: () => number, getRarity: (t: T) => Rarity): T {
  const weights = { Common: 0.6, Rare: 0.3, Legendary: 0.1 };
  const r = rng();
  let acc = 0;
  for (const w of ['Common', 'Rare', 'Legendary'] as Rarity[]) {
    acc += weights[w];
    if (r < acc) {
      const filtered = arr.filter((x) => getRarity(x) === w);
      return filtered[Math.floor(rng() * filtered.length)] ?? arr[0];
    }
  }
  return arr[Math.floor(rng() * arr.length)];
}

/** Generate 5555 unique combos with weighted rarity. */
function generateCombos(
  bodies: PartWithRarity[],
  eyes: PartWithRarity[],
  mouths: PartWithRarity[]
): Combo[] {
  const rng = createRng(42);
  const seen = new Set<string>();
  const combos: Combo[] = [];
  const key = (b: string, e: string, m: string) => `${b}|${e}|${m}`;
  const maxAttempts = 200000;
  let attempts = 0;

  while (combos.length < MAX_SUPPLY && attempts < maxAttempts) {
    attempts++;
    const body = weightedPick(bodies, rng, (x) => x.rarity);
    const eye = weightedPick(eyes, rng, (x) => x.rarity);
    const mouth = weightedPick(mouths, rng, (x) => x.rarity);
    const k = key(body.path, eye.path, mouth.path);
    if (seen.has(k)) continue;
    seen.add(k);
    const rarityScore = body.score + eye.score + mouth.score;
    combos.push({
      bodyId: body.path,
      eyesId: eye.path,
      mouthId: mouth.path,
      bodyRarity: body.rarity,
      eyesRarity: eye.rarity,
      mouthRarity: mouth.rarity,
      rarityScore,
      tier: RARITY_TIERS[rarityScore] ?? 'Common',
    });
  }

  if (combos.length < MAX_SUPPLY) {
    const need = MAX_SUPPLY - combos.length;
    for (let i = 0; i < need; i++) {
      const c = combos[i % combos.length];
      combos.push({ ...c });
    }
  }

  return combos;
}

/** Fisher–Yates shuffle. */
function shuffle<T>(arr: T[], rng: () => number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface CollectionEntry {
  tokenId: number;
  bodyId: string;
  eyesId: string;
  mouthId: string;
  bodyRarity: string;
  eyesRarity: string;
  mouthRarity: string;
  rarityScore: number;
  tier: string;
}

export function runGenerateCollection(): CollectionEntry[] {
  const { bodies, eyes, mouths } = getPartsWithRarity();
  let combos = generateCombos(bodies, eyes, mouths);
  combos = shuffle(combos, createRng(123));
  const entries: CollectionEntry[] = combos.slice(0, MAX_SUPPLY).map((c, i) => ({
    tokenId: i + 1,
    bodyId: c.bodyId,
    eyesId: c.eyesId,
    mouthId: c.mouthId,
    bodyRarity: c.bodyRarity,
    eyesRarity: c.eyesRarity,
    mouthRarity: c.mouthRarity,
    rarityScore: c.rarityScore,
    tier: c.tier,
  }));
  return entries;
}

function main() {
  const entries = runGenerateCollection();
  const outPath = join(process.cwd(), 'src', 'server', 'nft', 'collection.json');
  writeFileSync(outPath, JSON.stringify(entries, null, 0), 'utf-8');
  console.log(`Wrote ${entries.length} entries to ${outPath}`);
}

main();
