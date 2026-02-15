/**
 * Ethers.js wrapper for the ClawSkins ERC-721 contract on Monad mainnet.
 * Operator mints (for agents) use the same operator wallet as betting.
 */

import { JsonRpcProvider, Wallet, Contract } from 'ethers';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ABI_PATH = join(__dirname, '../../../contracts/ClawSkins.abi.json');
let CONTRACT_ABI: any[];
try {
  CONTRACT_ABI = JSON.parse(readFileSync(ABI_PATH, 'utf-8'));
} catch {
  console.warn('[nft/contract] Could not load ABI from', ABI_PATH);
  CONTRACT_ABI = [];
}

// Use Monad RPC so totalMinted/stats match the chain where the NFT contract is deployed (Monad mainnet).
const MONAD_RPC_URL = process.env.MONAD_RPC_URL || 'https://rpc.monad.xyz';
const NFT_RPC_URL = process.env.NFT_RPC_URL || MONAD_RPC_URL;
const OPERATOR_PRIVATE_KEY = process.env.OPERATOR_PRIVATE_KEY || '';
const SKIN_NFT_CONTRACT_ADDRESS = process.env.SKIN_NFT_CONTRACT_ADDRESS || '';

let provider: JsonRpcProvider | null = null;
let operatorWallet: Wallet | null = null;
let contract: Contract | null = null;
let readContract: Contract | null = null;

function ensureInit(): void {
  if (provider) return;

  if (!SKIN_NFT_CONTRACT_ADDRESS) {
    console.warn('[nft/contract] SKIN_NFT_CONTRACT_ADDRESS not set – NFT minting disabled');
    return;
  }

  provider = new JsonRpcProvider(NFT_RPC_URL);
  readContract = new Contract(SKIN_NFT_CONTRACT_ADDRESS, CONTRACT_ABI, provider);

  if (OPERATOR_PRIVATE_KEY) {
    operatorWallet = new Wallet(OPERATOR_PRIVATE_KEY, provider);
    contract = new Contract(SKIN_NFT_CONTRACT_ADDRESS, CONTRACT_ABI, operatorWallet);
    console.log(`[nft/contract] Operator wallet: ${operatorWallet.address}, contract: ${SKIN_NFT_CONTRACT_ADDRESS}`);
  } else {
    console.warn('[nft/contract] OPERATOR_PRIVATE_KEY not set – operator mint disabled');
  }
}

let txQueue: Promise<unknown> = Promise.resolve();

function enqueueOperatorTx<T>(fn: () => Promise<T>): Promise<T> {
  const p = txQueue.then(fn, fn);
  txQueue = p.then(() => {}, () => {});
  return p as Promise<T>;
}

export function isNftConfigured(): boolean {
  ensureInit();
  return !!contract && !!SKIN_NFT_CONTRACT_ADDRESS;
}

export function getNftContractAddress(): string {
  return SKIN_NFT_CONTRACT_ADDRESS;
}

export function getNftContractAbi(): any[] {
  return CONTRACT_ABI;
}

/** Operator mints to address (free). Returns tokenId and tx hash, or null on failure. */
export function operatorMint(to: string): Promise<{ tokenId: number; txHash: string } | null> {
  ensureInit();
  if (!contract) return Promise.resolve(null);
  return enqueueOperatorTx(async () => {
    try {
      const nonce = await operatorWallet!.getNonce();
      const tx = await contract!.operatorMint(to, { nonce });
      const receipt = await tx.wait();
      // ERC721 Transfer event: topic[3] = tokenId (indexed)
      const transferTopic = receipt?.logs?.find((l: { topics?: string[] }) => l.topics?.[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');
      let tokenIdNum = transferTopic?.topics?.[3] ? parseInt(transferTopic.topics[3], 16) : 0;
      if (!tokenIdNum) {
        const total = await contract!.totalMinted();
        tokenIdNum = Number(total);
      }
      console.log(`[nft/contract] operatorMint(${to}) tx: ${receipt.hash}, tokenId: ${tokenIdNum}`);
      return { tokenId: tokenIdNum, txHash: receipt.hash };
    } catch (err) {
      console.error('[nft/contract] operatorMint failed:', err);
      return null;
    }
  });
}

export async function totalMinted(): Promise<number> {
  ensureInit();
  if (!readContract) return 0;
  try {
    const n = await readContract.totalMinted();
    return Number(n);
  } catch (err) {
    console.warn('[nft/contract] totalMinted() failed – ensure NFT contract is on Monad and MONAD_RPC_URL (or NFT_RPC_URL) points to Monad RPC:', err instanceof Error ? err.message : err);
    return 0;
  }
}

export async function balanceOf(wallet: string): Promise<number> {
  ensureInit();
  if (!readContract) return 0;
  try {
    const n = await readContract.balanceOf(wallet);
    return Number(n);
  } catch {
    return 0;
  }
}

export async function ownerOf(tokenId: number): Promise<string | null> {
  ensureInit();
  if (!readContract) return null;
  try {
    return await readContract.ownerOf(tokenId);
  } catch {
    return null;
  }
}

/** Get all token IDs owned by wallet (for enumerable contract). */
export async function tokenIdsOfOwner(wallet: string): Promise<number[]> {
  ensureInit();
  if (!readContract) return [];
  try {
    const balance = await readContract.balanceOf(wallet);
    const n = Number(balance);
    const ids: number[] = [];
    for (let i = 0; i < n; i++) {
      const id = await readContract.tokenOfOwnerByIndex(wallet, i);
      ids.push(Number(id));
    }
    return ids;
  } catch {
    return [];
  }
}

export async function getMintPriceWei(): Promise<string> {
  ensureInit();
  if (!readContract) return '0';
  try {
    const price = await readContract.mintPrice();
    return String(price);
  } catch {
    return '0';
  }
}

/** MClaw mint price (wei) – equals 55.5 MON value; owner updates via setMintPriceMClaw. */
export async function getMintPriceMClawWei(): Promise<string> {
  ensureInit();
  if (!readContract) return '0';
  try {
    const price = await readContract.mintPriceMClaw();
    return String(price);
  } catch {
    return '0';
  }
}

/** MClaw token address from the contract (use this for approve so it matches). */
export async function getMclawTokenAddress(): Promise<string | null> {
  ensureInit();
  if (!readContract) return null;
  try {
    const addr = await readContract.mclawToken();
    const a = String(addr).toLowerCase();
    if (a === '0x0000000000000000000000000000000000000000') return null;
    return a;
  } catch {
    return null;
  }
}
