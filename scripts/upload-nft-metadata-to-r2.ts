/**
 * Generate ERC-721 metadata JSON for all 5555 Claw Skin NFTs and upload to Cloudflare R2.
 *
 * Metadata is stored at claw-skins/{tokenId} (no extension) so contract tokenURI(1) =
 * baseURI + "1" resolves to the JSON. Images remain at claw-skins/{tokenId}.png.
 *
 * Prerequisites:
 *   - collection.json exists (run: npx tsx src/server/nft/generateCollection.ts)
 *
 * Env (same as image upload):
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME
 *   NFT_IMAGE_BASE_URL - Base URL (no trailing slash). Metadata: {base}/claw-skins/{id}, Image: {base}/claw-skins/{id}.png
 *
 * Run: npx tsx scripts/upload-nft-metadata-to-r2.ts
 */

import 'dotenv/config';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getTokenMetadata, getTokenAttributes } from '../src/server/nft/skinTokenMap.js';

const MAX_SUPPLY = 5555;
const BATCH_SIZE = 50;
const R2_PREFIX = 'claw-skins';

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucketName = process.env.R2_BUCKET_NAME;
const imageBaseUrl = process.env.NFT_IMAGE_BASE_URL?.replace(/\/$/, '');

if (!accountId || !accessKeyId || !secretAccessKey || !bucketName) {
  console.error('Missing R2 env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME');
  process.exit(1);
}
if (!imageBaseUrl) {
  console.error('NFT_IMAGE_BASE_URL is required so metadata image field points to R2.');
  process.exit(1);
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId,
    secretAccessKey,
  },
});

function buildMetadataJson(tokenId: number): string | null {
  const meta = getTokenMetadata(tokenId);
  if (!meta) return null;
  const json = {
    name: `Claw Skin #${tokenId}`,
    description: `An ${meta.tier} combined skin for Claw IO (score ${meta.rarityScore})`,
    image: `${imageBaseUrl}/${R2_PREFIX}/${tokenId}.png`,
    attributes: getTokenAttributes(meta),
  };
  return JSON.stringify(json, null, 0);
}

async function uploadOne(tokenId: number): Promise<boolean> {
  const body = buildMetadataJson(tokenId);
  if (!body) {
    console.error(`[${tokenId}] No metadata`);
    return false;
  }
  const key = `${R2_PREFIX}/${tokenId}`; // no .json so tokenURI(1) = base/claw-skins/1
  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: Buffer.from(body, 'utf-8'),
      ContentType: 'application/json',
      CacheControl: 'public, max-age=31536000, immutable',
    })
  );
  return true;
}

async function run() {
  console.log('Uploading NFT metadata JSON to R2...');
  console.log(`Bucket: ${bucketName}, prefix: ${R2_PREFIX}/ (keys: 1, 2, ... 5555)`);
  let ok = 0;
  let fail = 0;

  for (let start = 1; start <= MAX_SUPPLY; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE - 1, MAX_SUPPLY);
    const results = await Promise.all(
      Array.from({ length: end - start + 1 }, (_, i) => uploadOne(start + i))
    );
    for (const r of results) {
      if (r) ok++;
      else fail++;
    }
    if (end % 500 === 0 || end === MAX_SUPPLY) {
      console.log(`Progress: ${end}/${MAX_SUPPLY} (ok: ${ok}, fail: ${fail})`);
    }
  }

  console.log(`Done. OK: ${ok}, Failed: ${fail}`);
  console.log(`Metadata URL pattern: ${imageBaseUrl}/${R2_PREFIX}/{tokenId}`);
  console.log('Set contract baseURI to: ' + imageBaseUrl + '/' + R2_PREFIX + '/');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
