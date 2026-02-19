import { defineConfig } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: __dirname,
  build: {
    outDir: 'public/client',
    emptyOutDir: false,
    lib: {
      entry: path.resolve(__dirname, 'src/wallet-reown-entry.js'),
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
      ethers: path.resolve(__dirname, 'node_modules/ethers'),
    },
  },
});
