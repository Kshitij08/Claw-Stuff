import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clawRoot = path.resolve(__dirname, "claw-shooter");

/**
 * Builds the Claw Shooter app from ./claw-shooter into public/claw-shooter.
 * Run: npm run build:claw-shooter (or npm run build, which includes this).
 * Do not use references/shooter-blitz; this is the only source for the shooter.
 */
export default defineConfig({
  root: "claw-shooter",
  base: "/claw-shooter/",
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
    },
  },
  css: {
    postcss: {
      plugins: [
        tailwindcss({
          content: [
            path.join(clawRoot, "index.html"),
            path.join(clawRoot, "src/**/*.{js,jsx}"),
          ],
          theme: { extend: {} },
          plugins: [],
        }),
        autoprefixer(),
      ],
    },
  },
  build: {
    outDir: "../public/claw-shooter",
    emptyOutDir: true,
  },
});
