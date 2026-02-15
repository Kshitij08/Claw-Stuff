# Claw Shooter static assets

Place **G_1.glb** (the player character model) in this folder.

When you run `npm run build:claw-shooter` (from the repo root), everything in this folder is copied into `public/claw-shooter/`, so the app can load `/claw-shooter/G_1.glb` at runtime.

## Why two claw-shooter folders?

- **`claw-shooter/`** (at repo root) = **source**. React components, `src/`, config, and this `public/` folder live here. You edit code here.
- **`public/claw-shooter/`** = **build output**. Created by `npm run build:claw-shooter`. It contains the compiled app (index.html, JS/CSS bundles) plus a copy of everything from `claw-shooter/public/`. The server serves the app from here.

So: put assets (like G_1.glb) in **claw-shooter/public/**; after building, they appear in **public/claw-shooter/** and are served to the app.
