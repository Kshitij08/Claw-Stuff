/**
 * Loads collection.json and exposes tokenId -> skin metadata and image generation.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { getSkinPartPaths, generateSnake } from '../snakeGenerator.js';

export interface TokenMetadata {
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

let collection: TokenMetadata[] | null = null;

function loadCollection(): TokenMetadata[] {
  if (collection) return collection;
  const path = join(process.cwd(), 'src', 'server', 'nft', 'collection.json');
  try {
    const raw = readFileSync(path, 'utf-8');
    collection = JSON.parse(raw) as TokenMetadata[];
    return collection!;
  } catch (err) {
    console.error('[nft/skinTokenMap] Failed to load collection.json:', err);
    return [];
  }
}

/** Get metadata for a token (1-based). Returns undefined if tokenId out of range. */
export function getTokenMetadata(tokenId: number): TokenMetadata | undefined {
  const list = loadCollection();
  const entry = list.find((e) => e.tokenId === tokenId);
  return entry;
}

/** Get display name for a part path (e.g. "Rare/galaxy.png" -> "Galaxy"). */
function partPathToName(path: string): string {
  const base = path.split('/').pop() ?? path;
  const name = base.replace(/\.png$/i, '').trim();
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Minimum size for NFT images; output is square (1:1) for marketplace compatibility. */
const NFT_IMAGE_SIZE = 2048;

/** Generate composed snake PNG for a token (1:1 aspect ratio, themed dot-grid background). Returns buffer or null if generation fails. */
export async function getTokenImage(tokenId: number): Promise<Buffer | null> {
  const meta = getTokenMetadata(tokenId);
  if (!meta) return null;
  try {
    const { bodyPath, eyesPath, mouthPath } = getSkinPartPaths(
      meta.bodyId,
      meta.eyesId,
      meta.mouthId
    );
    const result = await generateSnake(bodyPath, eyesPath, mouthPath, {
      canvas: { width: NFT_IMAGE_SIZE, height: NFT_IMAGE_SIZE },
      backgroundPattern: 'dot-grid', // final NFT background: dark-theme Apple-style orbs
    });
    return result.buffer;
  } catch {
    return null;
  }
}

/** Get ERC-721 attributes array for metadata JSON. */
export function getTokenAttributes(meta: TokenMetadata): { trait_type: string; value: string; display_type?: string }[] {
  return [
    { trait_type: 'Body', value: partPathToName(meta.bodyId) },
    { trait_type: 'Body Rarity', value: meta.bodyRarity },
    { trait_type: 'Eyes', value: partPathToName(meta.eyesId) },
    { trait_type: 'Eyes Rarity', value: meta.eyesRarity },
    { trait_type: 'Mouth', value: partPathToName(meta.mouthId) },
    { trait_type: 'Mouth Rarity', value: meta.mouthRarity },
    { trait_type: 'Rarity Score', value: String(meta.rarityScore), display_type: 'number' },
    { trait_type: 'Tier', value: meta.tier },
  ];
}

/** Resolve tokenId to SkinParts for game rendering. */
export function getTokenSkinParts(tokenId: number): { bodyId: string; eyesId: string; mouthId: string } | null {
  const meta = getTokenMetadata(tokenId);
  if (!meta) return null;
  return { bodyId: meta.bodyId, eyesId: meta.eyesId, mouthId: meta.mouthId };
}
