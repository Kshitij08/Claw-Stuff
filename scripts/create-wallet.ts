/**
 * Generate a new EVM wallet (address + private key).
 * Run: npx tsx scripts/create-wallet.ts
 *
 * SECURITY: Keep the private key and mnemonic secret. Never commit them.
 */

import { Wallet } from "ethers";

function main() {
  const wallet = Wallet.createRandom();

  console.log("\n--- New EVM Wallet ---\n");
  console.log("Address:    ", wallet.address);
  console.log("Private key:", wallet.privateKey);
  if (wallet.mnemonic) {
    console.log("Mnemonic:   ", wallet.mnemonic.phrase);
  }
  console.log("\n--- Keep these secret. Do not commit or share. ---\n");
}

main();
