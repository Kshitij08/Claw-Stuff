import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: __dirname,
  build: {
    outDir: 'public/client',
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'src/wallet-reown-entry.js'),
      name: 'ReownBundle',
      fileName: () => 'wallet-reown.js',
      formats: ['es'],
    },
    rollupOptions: {
      output: {
        entryFileNames: 'wallet-reown.js',
      },
    },
  },
  resolve: {
    alias: {
      // ensure single ethers instance when loaded with page's ethers
      ethers: resolve(__dirname, 'node_modules/ethers'),
    },
  },
});
