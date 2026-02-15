/**
 * Generate a single sample NFT image to verify the pipeline before uploading all 5555.
 * Writes the image to sample-nft-image.png in the project root.
 *
 * Usage: npx tsx scripts/generate-sample-nft-image.ts [tokenId]
 * Default tokenId: 1
 */

import 'dotenv/config';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { getTokenImage } from '../src/server/nft/skinTokenMap.js';
import { getTokenMetadata } from '../src/server/nft/skinTokenMap.js';

const tokenId = parseInt(process.argv[2] || '1', 10);
if (!Number.isInteger(tokenId) || tokenId < 1 || tokenId > 5555) {
  console.error('Usage: npx tsx scripts/generate-sample-nft-image.ts [tokenId]');
  console.error('tokenId must be 1–5555');
  process.exit(1);
}

async function main() {
  console.log(`Generating sample NFT image for tokenId ${tokenId}...`);

  const meta = getTokenMetadata(tokenId);
  if (!meta) {
    console.error(`Token ${tokenId} not found in collection.`);
    process.exit(1);
  }
  console.log(`Combo: Body=${meta.bodyId}, Eyes=${meta.eyesId}, Mouth=${meta.mouthId} (${meta.tier})`);

  const buffer = await getTokenImage(tokenId);
  if (!buffer) {
    console.error('Image generation failed. Check that Body/Eyes/Mouth assets exist in public/skins/');
    process.exit(1);
  }

  const outPath = join(process.cwd(), 'sample-nft-image.png');
  writeFileSync(outPath, buffer);
  console.log(`Saved: ${outPath}`);
  console.log('Open this file to verify the NFT image looks correct.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
