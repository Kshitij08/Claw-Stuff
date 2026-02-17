# Why production showed errors that localhost didn't

## What happened

The claw-shooter page on production (e.g. https://claw-io.up.railway.app/claw-shooter/) threw `ReferenceError`s (e.g. `floorY is not defined`, `spectatorMatchState is not defined`, `useEffect is not defined`) and showed a blank screen. The same app on localhost often did not show these errors.

## Why the errors happened

1. **Undefined variables**  
   Code referenced variables that were never defined or passed in that scope:
   - `floorY` in `Map.jsx` – used in `useEffect` and dependency array but never computed or received as a prop.
   - `spectatorMatchState` in `Experience.jsx` – leftover from an old refactor; the component actually uses `gameState` from context.
   - `useEffect` in `App.jsx` – used but not imported from `react`.
   - `Experience` in `App.jsx` – rendered but not imported.
   - `insertCoin` in `App.jsx` – called in an effect but never imported (Playroom API).

2. **Context shape mismatch**  
   Some components (e.g. `SpectatorExperience`) expected context fields that `GameManager` never provided (`spectatorMatchState`, `mapFloorY`, `setMapFloorY`). If those components were ever rendered, they would throw when destructuring from `useGameManager()`.

## Why localhost didn't catch them (even when you serve the production build)

- **Different code path**  
  On localhost you may have been testing the main Snake page (`/`) more than `/claw-shooter/`. The claw-shooter bundle only runs when you open the claw-shooter URL, so bugs in that bundle only appear there.

- **Caching**  
  The browser or dev server might have served an older bundle where that code path didn’t exist or wasn’t hit yet.

- **Dev vs production build**  
  Local dev often uses `npm run dev` (Vite dev server) with different bundling and no minification. Production uses `npm run build` + `build:claw-shooter`, so the exact code paths and chunk layout can differ. The bugs were still present in source; they just weren’t executed or noticed in dev.

- **Hot reload / timing**  
  In dev, hot reload or navigation might not remount the same component tree, so the line that referenced the undefined variable might not run.

So: the issues were real bugs in the source (undefined refs, missing imports, context mismatches). Production exposed them because that’s where the full claw-shooter flow was exercised and cached bundles were up to date.

## How to avoid this next time

1. **Always test the deployed URL**  
   After changes that touch claw-shooter, open `https://your-domain/claw-shooter/` (or your production URL) and confirm the page loads and works.

2. **Test production build locally**  
   Run `npm run build` and `npm run build:claw-shooter`, then serve the `public/` folder (e.g. `npx serve public`) and open `/claw-shooter/` to mimic production. Even then you can miss errors if:
   - The `public/` folder was from an **older build** (before the buggy code). Railway does a fresh build on each deploy; your local `public/` might be stale. Run a full build **immediately before** testing.
   - The **browser cached** the previous JS bundle. Use hard refresh (Ctrl+Shift+R) or an incognito window, or DevTools → Network → "Disable cache", when testing the production build.

3. **Lint and type-check**  
   Use ESLint (and TypeScript if you add it) so undefined variables and missing imports are caught before deploy.

4. **Single source of truth for context**  
   Keep `GameManager` as the single place that defines what context provides; any component using `useGameManager()` should only destructure fields that exist in that context.

## Fixes applied (and similar issues to watch for)

| Issue | Location | Fix |
|-------|----------|-----|
| `useEffect` not defined | App.jsx | Removed effect that called undefined `insertCoin`; added missing `Experience` import. |
| `spectatorMatchState` not defined | Experience.jsx | Use `gameState` and `players` from context instead. |
| `floorY` not defined | Map.jsx | Compute `floorY` in the same `useMemo` as scale/position; add optional `onReady` prop. |
| Context missing `spectatorMatchState`, `mapFloorY`, `setMapFloorY` | SpectatorExperience.jsx | Use `gameState` from context and local `useState` for `mapFloorY`. |
| Context missing `weaponPickups` | BotController.jsx uses it | Added `weaponPickups: gameState?.pickups ?? []` to GameManager value. |

When adding new context consumers, always destructure only what `GameManager` actually provides. When adding new variables in a component, ensure they are defined in that scope (props, useMemo, useState, or imports).
