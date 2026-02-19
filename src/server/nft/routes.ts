/**
 * NFT challenge and mint API for agents. Metadata and image routes included.
 */

import { Router, Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { dbQuery } from '../db.js';
import { operatorMint, isNftConfigured, totalMinted, getNftContractAddress, getNftContractAbi, getMintPriceMClawWei, getMclawTokenAddress, tokenIdsOfOwner } from './contract.js';
import { getTokenMetadata, getTokenAttributes, getTokenImage } from './skinTokenMap.js';

const CHALLENGE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const RATE_LIMIT_MINT_MS = 60 * 1000; // 1 minute per wallet

function isValidAddress(addr: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(addr);
}

/** Generate a simple math challenge and its answer. */
function generateChallenge(): { challenge: string; answer: string } {
  const a = 10 + Math.floor(Math.random() * 90);
  const b = 2 + Math.floor(Math.random() * 12);
  const c = 1 + Math.floor(Math.random() * 99);
  const answer = a * b + c;
  return {
    challenge: `What is ${a} * ${b} + ${c}?`,
    answer: String(answer),
  };
}

export function createNftRoutes(): Router {
  const router = Router();

  // ─── POST /api/nft/challenge ─────────────────────────────────────────
  router.post('/nft/challenge', async (req: Request, res: Response) => {
    const walletAddress = typeof req.body?.walletAddress === 'string' ? req.body.walletAddress.trim() : '';
    if (!walletAddress || !isValidAddress(walletAddress)) {
      res.status(400).json({
        success: false,
        error: 'INVALID_WALLET',
        message: 'walletAddress (0x...) is required and must be a valid EVM address',
      });
      return;
    }

    const { challenge, answer } = generateChallenge();
    const challengeId = randomBytes(16).toString('hex');
    const expiresAt = Date.now() + CHALLENGE_EXPIRY_MS;

    try {
      await dbQuery(
        `INSERT INTO nft_challenges (id, wallet_address, challenge, answer, expires_at)
         VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0))`,
        [challengeId, walletAddress.toLowerCase(), challenge, answer, expiresAt]
      );
    } catch (err) {
      console.error('[nft] challenge insert failed:', err);
      res.status(500).json({
        success: false,
        error: 'INTERNAL_ERROR',
        message: 'Failed to create challenge',
      });
      return;
    }

    res.json({
      success: true,
      challengeId,
      challenge,
      expiresAt,
    });
  });

  // ─── POST /api/nft/mint ─────────────────────────────────────────────
  router.post('/nft/mint', async (req: Request, res: Response) => {
    const walletAddress = typeof req.body?.walletAddress === 'string' ? req.body.walletAddress.trim() : '';
    const challengeId = typeof req.body?.challengeId === 'string' ? req.body.challengeId.trim() : '';
    const answer = typeof req.body?.answer === 'string' ? req.body.answer.trim() : '';

    if (!walletAddress || !isValidAddress(walletAddress)) {
      res.status(400).json({
        success: false,
        error: 'INVALID_WALLET',
        message: 'walletAddress is required and must be a valid EVM address',
      });
      return;
    }
    if (!challengeId || !answer) {
      res.status(400).json({
        success: false,
        error: 'MISSING_FIELDS',
        message: 'challengeId and answer are required',
      });
      return;
    }

    if (!isNftConfigured()) {
      res.status(503).json({
        success: false,
        error: 'NFT_DISABLED',
        message: 'NFT minting is not configured',
      });
      return;
    }

    const wallet = walletAddress.toLowerCase();

    // Rate limit: 1 mint per wallet per minute
    try {
      const recent = await dbQuery<{ minted_at: Date }>(
        `SELECT minted_at FROM nft_mints
         WHERE wallet_address = $1
         ORDER BY minted_at DESC
         LIMIT 1`,
        [wallet]
      );
      if (recent.length > 0) {
        const last = new Date(recent[0].minted_at).getTime();
        if (Date.now() - last < RATE_LIMIT_MINT_MS) {
          res.status(429).json({
            success: false,
            error: 'RATE_LIMITED',
            message: 'One mint per wallet per minute. Try again shortly.',
            retryAfterMs: RATE_LIMIT_MINT_MS - (Date.now() - last),
          });
          return;
        }
      }
    } catch (err) {
      console.error('[nft] rate limit check failed:', err);
    }

    // Load and validate challenge
    let rows: { wallet_address: string; answer: string; expires_at: Date; used: boolean }[];
    try {
      rows = await dbQuery(
        `SELECT wallet_address, answer, expires_at, used
         FROM nft_challenges WHERE id = $1`,
        [challengeId]
      );
    } catch (err) {
      console.error('[nft] challenge lookup failed:', err);
      res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: 'Database error' });
      return;
    }

    if (rows.length === 0) {
      res.status(400).json({
        success: false,
        error: 'INVALID_CHALLENGE',
        message: 'Challenge not found or expired',
      });
      return;
    }

    const ch = rows[0];
    if (ch.used) {
      res.status(400).json({
        success: false,
        error: 'CHALLENGE_USED',
        message: 'This challenge was already used',
      });
      return;
    }
    if (new Date(ch.expires_at).getTime() < Date.now()) {
      res.status(400).json({
        success: false,
        error: 'CHALLENGE_EXPIRED',
        message: 'Challenge has expired',
      });
      return;
    }
    if (ch.wallet_address.toLowerCase() !== wallet) {
      res.status(400).json({
        success: false,
        error: 'WALLET_MISMATCH',
        message: 'Wallet does not match the challenge',
      });
      return;
    }
    if (ch.answer !== answer) {
      res.status(401).json({
        success: false,
        error: 'WRONG_ANSWER',
        message: 'Challenge answer is incorrect',
      });
      return;
    }

    // Atomically claim the challenge to prevent double-mint (TOCTOU fix)
    let claimed: { id: string }[];
    try {
      claimed = await dbQuery(
        `UPDATE nft_challenges SET used = true WHERE id = $1 AND used = false RETURNING id`,
        [challengeId]
      );
    } catch (err) {
      console.error('[nft] atomic challenge claim failed:', err);
      res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: 'Database error' });
      return;
    }

    if (claimed.length === 0) {
      res.status(400).json({
        success: false,
        error: 'CHALLENGE_USED',
        message: 'This challenge was already used',
      });
      return;
    }

    const result = await operatorMint(walletAddress);
    if (!result) {
      res.status(503).json({
        success: false,
        error: 'MINT_FAILED',
        message: 'On-chain mint failed. Contract may be sold out or RPC error.',
      });
      return;
    }

    try {
      await dbQuery(
        `INSERT INTO nft_mints (wallet_address, token_id, tx_hash) VALUES ($1, $2, $3)`,
        [wallet, result.tokenId, result.txHash]
      );
    } catch (err) {
      console.error('[nft] post-mint DB update failed:', err);
    }

    res.json({
      success: true,
      txHash: result.txHash,
      tokenId: result.tokenId,
    });
  });

  // ─── GET /api/nft/metadata/:tokenId ──────────────────────────────────
  // When NFT_IMAGE_BASE_URL is set, metadata is served from R2; redirect there. Otherwise build on the fly.
  router.get('/nft/metadata/:tokenId', (req: Request, res: Response) => {
    const tokenId = parseInt(req.params.tokenId, 10);
    if (!Number.isInteger(tokenId) || tokenId < 1 || tokenId > 5555) {
      res.status(400).json({ error: 'INVALID_TOKEN_ID', message: 'tokenId must be 1–5555' });
      return;
    }

    const imageBaseUrl = process.env.NFT_IMAGE_BASE_URL?.replace(/\/$/, '');
    if (imageBaseUrl) {
      res.redirect(302, `${imageBaseUrl}/${tokenId}`);
      return;
    }

    const meta = getTokenMetadata(tokenId);
    if (!meta) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'Token not found' });
      return;
    }

    const imageUrl = (process.env.API_BASE_URL || `https://${req.get('host') || 'claw-io.up.railway.app'}`) + `/api/nft/image/${tokenId}`;
    res.json({
      name: `Claw Skin #${tokenId}`,
      description: `An ${meta.tier} combined skin for Claw IO (score ${meta.rarityScore})`,
      image: imageUrl,
      attributes: getTokenAttributes(meta),
    });
  });

  // ─── GET /api/nft/image/:tokenId ─────────────────────────────────────
  // When NFT_IMAGE_BASE_URL is set, redirect to Cloudflare R2 (or CDN). Otherwise generate on the fly and cache.
  const imageCache = new Map<number, Buffer>();
  const IMAGE_CACHE_MAX = 500;

  router.get('/nft/image/:tokenId', async (req: Request, res: Response) => {
    const tokenId = parseInt(req.params.tokenId, 10);
    if (!Number.isInteger(tokenId) || tokenId < 1 || tokenId > 5555) {
      res.status(400).send('Invalid tokenId');
      return;
    }

    const imageBaseUrl = process.env.NFT_IMAGE_BASE_URL?.replace(/\/$/, '');
    if (imageBaseUrl) {
      res.redirect(302, `${imageBaseUrl}/${tokenId}.png`);
      return;
    }

    let buffer: Buffer | undefined = imageCache.get(tokenId);
    if (!buffer) {
      const generated = await getTokenImage(tokenId);
      if (!generated) {
        res.status(404).send('Image not found');
        return;
      }
      buffer = generated;
      if (imageCache.size >= IMAGE_CACHE_MAX) {
        const firstKey = imageCache.keys().next().value;
        if (firstKey !== undefined) imageCache.delete(firstKey);
      }
      imageCache.set(tokenId, buffer);
    }

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(buffer);
  });

  // ─── GET /api/nft/stats ───────────────────────────────────────────────
  router.get('/nft/stats', async (_req: Request, res: Response) => {
    const minted = await totalMinted();
    res.json({ totalMinted: minted, maxSupply: 5555 });
  });

  // ─── GET /api/nft/owned/:wallet ──────────────────────────────────────
  router.get('/nft/owned/:wallet', async (req: Request, res: Response) => {
    const wallet = (req.params.wallet || '').trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(wallet)) {
      res.status(400).json({ error: 'INVALID_WALLET', message: 'wallet must be a valid 0x-prefixed address' });
      return;
    }
    if (!isNftConfigured()) {
      res.status(503).json({ error: 'NFT_DISABLED', tokenIds: [] });
      return;
    }
    try {
      const tokenIds = await tokenIdsOfOwner(wallet);
      res.json({ tokenIds });
    } catch (err) {
      console.error('[nft] owned lookup failed:', err);
      res.status(500).json({ error: 'INTERNAL_ERROR', tokenIds: [] });
    }
  });

  // Monad mainnet only – used so the mint UI can switch the wallet to Monad if on another network.
  const MONAD_CHAIN = {
    chainId: 143,
    chainIdHex: '0x8f',
    chainName: 'Monad',
    rpcUrls: [(process.env.MONAD_RPC_URL || 'https://rpc.monad.xyz').replace(/\/$/, '')],
    nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    blockExplorerUrls: ['https://monadvision.com'],
  };

  // ─── GET /api/nft/contract-info (for frontend mint) ───────────────────
  const MCLAW_TOKEN_ADDRESS_FALLBACK = process.env.MCLAW_TOKEN_ADDRESS || '0x26813a9B80f43f98cee9045B9f7CdcA816C57777';
  router.get('/nft/contract-info', async (_req: Request, res: Response) => {
    const address = getNftContractAddress();
    if (!address) {
      res.status(503).json({ success: false, error: 'NFT not configured' });
      return;
    }
    const mintPriceWei = process.env.NFT_MINT_PRICE || '111000000000000000000';
    let mintPriceMClawWei = await getMintPriceMClawWei();
    if (mintPriceMClawWei === '0') mintPriceMClawWei = (BigInt(mintPriceWei) / 2n).toString();
    const mclawTokenFromContract = await getMclawTokenAddress();
    const mclawTokenAddress = mclawTokenFromContract ?? MCLAW_TOKEN_ADDRESS_FALLBACK;
    res.json({
      contractAddress: address,
      abi: getNftContractAbi(),
      mintPriceWei,
      mintPriceMClawWei,
      mclawTokenAddress,
      mclawMintEnabled: !!mclawTokenFromContract,
      chain: {
        chainId: MONAD_CHAIN.chainId,
        chainIdHex: MONAD_CHAIN.chainIdHex,
        chainName: MONAD_CHAIN.chainName,
        rpcUrls: MONAD_CHAIN.rpcUrls,
        nativeCurrency: MONAD_CHAIN.nativeCurrency,
        blockExplorerUrls: MONAD_CHAIN.blockExplorerUrls,
      },
    });
  });

  return router;
}
