/**
 * Generate all 5555 Claw Skin NFT images and upload them to Cloudflare R2.
 *
 * Prerequisites:
 *   - collection.json exists (run: npx tsx src/server/nft/generateCollection.ts)
 *   - Body/Eyes/Mouth assets in public/skins/ (or fallbacks from presets)
 *   - skia-canvas installed
 *
 * Env (e.g. in .env):
 *   R2_ACCOUNT_ID       - Cloudflare account ID
 *   R2_ACCESS_KEY_ID    - R2 API token access key
 *   R2_SECRET_ACCESS_KEY - R2 API token secret
 *   R2_BUCKET_NAME      - Bucket name
 *   NFT_IMAGE_BASE_URL  - Public base URL for images (e.g. https://pub-xxx.r2.dev or custom domain)
 *                         No trailing slash. Images will be at {NFT_IMAGE_BASE_URL}/claw-skins/{tokenId}.png
 *
 * Run: npx tsx scripts/upload-nft-images-to-r2.ts
 */

import 'dotenv/config';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getTokenImage } from '../src/server/nft/skinTokenMap.js';

const MAX_SUPPLY = 5555;
const BATCH_SIZE = 5;
const R2_PREFIX = 'claw-skins';

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucketName = process.env.R2_BUCKET_NAME;

if (!accountId || !accessKeyId || !secretAccessKey || !bucketName) {
  console.error('Missing R2 env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME');
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

async function uploadOne(tokenId: number): Promise<boolean> {
  const buffer = await getTokenImage(tokenId);
  if (!buffer) {
    console.error(`[${tokenId}] Failed to generate image`);
    return false;
  }
  const key = `${R2_PREFIX}/${tokenId}.png`;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: buffer,
      ContentType: 'image/png',
      CacheControl: 'public, max-age=31536000, immutable',
    })
  );
  return true;
}

async function run() {
  console.log('Generating and uploading NFT images to R2...');
  console.log(`Bucket: ${bucketName}, prefix: ${R2_PREFIX}/`);
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
    if (end % 100 === 0 || end === MAX_SUPPLY) {
      console.log(`Progress: ${end}/${MAX_SUPPLY} (ok: ${ok}, fail: ${fail})`);
    }
  }

  console.log(`Done. OK: ${ok}, Failed: ${fail}`);
  if (process.env.NFT_IMAGE_BASE_URL) {
    const base = process.env.NFT_IMAGE_BASE_URL.replace(/\/$/, '');
    console.log(`Image URL pattern: ${base}/${R2_PREFIX}/{tokenId}.png`);
  } else {
    console.log('Set NFT_IMAGE_BASE_URL (e.g. your R2 public URL or custom domain) so metadata points to these images.');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
