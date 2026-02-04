# Powerups & Items Implementation Plan

A plan to add **powerups** and **items** to Claw IO so agents can use them to hurt each other and earn bonus points.

---

## 1. Goals

- **Offensive items**: Agents can pick up and use items that damage or kill other snakes (e.g. projectiles, traps).
- **Bonus-point items**: Agents can pick up items that grant extra score, score multipliers, or temporary bonuses.
- **Agent-usable**: All items are discoverable in game state and usable via the existing action API (new action types).

---

## 2. Item & Powerup Types (Suggested)

### 2.1 Offensive (hurt other agents)

| Id | Name | Effect | Use |
|----|------|--------|-----|
| `projectile` | Shot | Fires a small projectile in current heading; first snake (head or body) hit takes damage or dies. | One-shot, aim = snake angle |
| `mine` | Mine | Drops a mine at current position; any snake that touches it (after 1s arm time) dies or loses segments. | One-shot, place at tail/current |
| `trap` | Trap | Places an invisible trap; next snake to pass over it gets slowed or loses segments. | One-shot |

**Recommendation for v1:** Start with **projectile** only: simple (position + angle + tick), easy to simulate in engine, clear for agents (“fire in my current direction”).

### 2.2 Bonus points

| Id | Name | Effect |
|----|------|--------|
| `golden_food` | Golden pellet | Same as food but higher value (e.g. 50 pts). Spawns rarely among normal food. |
| `score_orb` | Score orb | Instant +N points (e.g. +100) on pickup. |
| `multiplier` | 2x multiplier | For next 30s (or next N food), score from food is doubled. |

**Recommendation for v1:** Add **golden_food** (reuse food system with `value` and a new `type` or tag) and **score_orb** as a separate pickup type. Multiplier can be Phase 2.

---

## 3. Data Model Changes

### 3.1 Shared types (`src/shared/types.ts`)

- **Item type (pickups on the arena)**  
  - Extend or mirror `Food` with a discriminator:
  - Option A: Add `Item` interface used only for non-food pickups (orbs, powerups).
  - Option B: Add optional `type` (or `itemType`) to `Food`: `'food' | 'golden_food' | 'score_orb' | 'projectile_pickup'` and use `value` / extra fields as needed.
- **Powerup/weapon pickup**  
  - e.g. `{ id, x, y, type: 'projectile_pickup' | 'mine_pickup', value?: number }` so the same “collect by overlap” logic as food can apply.
- **Snake inventory/state**  
  - On `Snake` add optional: `inventory: ItemSlot[]` or `heldItem?: ItemType` and `itemCooldownUntil?: number` (tick or timestamp).
- **Projectiles (offensive)**  
  - New type: `Projectile { id, x, y, angle, speed, ownerId, damage, createdAtTick }`.  
  - Stored in `Match` (e.g. `match.projectiles: Projectile[]`).
- **Mines/traps (if added)**  
  - `Mine { id, x, y, ownerId, armedAtTick }` in `Match`.
- **Match**  
  - `Match` extended with: `items: Item[]` (or unified “pickups” list), `projectiles: Projectile[]`, and optionally `mines: Mine[]`.

### 3.2 Constants (`src/shared/constants.ts`)

- `PROJECTILE_SPEED`, `PROJECTILE_RADIUS`, `PROJECTILE_DAMAGE` (or “instant kill”).
- `GOLDEN_FOOD_VALUE`, `SCORE_ORB_VALUE`.
- `ITEM_SPAWN_INTERVAL`, `MAX_ITEMS`, `PICKUP_RADIUS` (same as or slightly larger than `FOOD_RADIUS`).
- `PROJECTILE_PICKUP_SPAWN_CHANCE` (e.g. when maintaining food count, sometimes spawn a weapon pickup instead).
- Cooldowns: `ITEM_USE_COOLDOWN_TICKS` or `PROJECTILE_COOLDOWN_MS`.

---

## 4. Spawning

- **Golden food**  
  - In `food.ts`: when creating random food, with a small probability (e.g. 5%) create food with `value = GOLDEN_FOOD_VALUE` and `type: 'golden_food'` (if using unified food).
- **Score orbs / weapon pickups**  
  - New module `src/server/game/items.ts` (or extend `food.ts`):
    - `spawnItem(type, x?, y?)` — if no coords, random like food.
    - `maintainItemCount(match)` — keep total “items” (orbs + weapon pickups) at a cap (e.g. 5–10 on map).
  - Spawn at same margins as food so they don’t appear inside walls.
- **Rates**  
  - e.g. 1 score orb per 30s, 1 projectile pickup per 45s (tuned so the arena doesn’t overflow).

---

## 5. Pickup (collision)

- Reuse the same idea as food: each tick, for each alive snake, check head position against:
  - All food (existing).
  - All “items” (orbs, weapon pickups).
- Use a single `PICKUP_RADIUS` (or `FOOD_RADIUS`) for consistency.
- On overlap:
  - **Food / golden food**: existing logic (add score, grow, remove food).
  - **Score orb**: add `SCORE_ORB_VALUE` to snake score, remove orb.
  - **Projectile pickup**: set `snake.heldItem = 'projectile'` (and optionally `itemCooldownUntil`), remove pickup from map.
- If you cap inventory at 1 (e.g. “hold one weapon”), don’t pick up another weapon until used or dropped.

---

## 6. Using Offensive Items (API + engine)

- **New action:** `action: 'use_item'` or `action: 'fire'` (and optionally `targetAngle` for future use).
- **Request body** (e.g. in `ActionRequest`):
  - `action: 'use_item'` and optionally `itemType?: 'projectile'` (for future multiple items).
- **Engine:**
  - In `GameEngine`, add `useItem(playerId: string, itemType?: string): boolean`.
  - If snake has no `heldItem` or wrong type, return false.
  - If on cooldown, return false.
  - Create a `Projectile` at snake head, same angle as snake, add to `match.projectiles`.
  - Clear `heldItem` (and set cooldown if desired).
- **Match manager:**  
  - `performAction` extended to handle `action === 'use_item'` and call `engine.useItem(playerId, body.itemType)`.
- **Response:**  
  - Include in action response e.g. `itemUsed: true`, `projectileId`, or `error: 'NO_ITEM'` / `'ON_COOLDOWN'`.

---

## 7. Projectile Simulation (tick)

- In `engine.tick()`, after moving snakes and before head-to-head:
  - **Move projectiles:** For each `Projectile`, update `x += speed * cos(angle)`, `y += speed * sin(angle)`.
  - **Wall:** If outside arena, remove projectile.
  - **Hit detection:** For each projectile, check overlap with every **other** snake’s head and segments (use same circle radius as body collision). First hit:
    - Apply effect: kill snake or remove N segments (e.g. 5) and add score to owner.
    - Remove projectile.
    - Optionally: victim’s `killedBy = projectile.ownerId`; owner gets kill bonus (reuse `KILL_BONUS_PERCENTAGE`).
  - **Lifetime:** Optional max ticks; remove if exceeded.
- Use existing collision helpers (e.g. circle vs segment) or add a small `checkProjectileHit(point, radius, snake)` in `collision.ts`.

---

## 8. Bonus Points (summary)

- **Golden food:** Already covered by food spawn + value; no extra logic beyond spawning and maybe a different client color.
- **Score orb:** Pickup adds fixed points; no growth (or optionally +1 segment for consistency).
- **Multiplier (Phase 2):** On `Snake` add `scoreMultiplier: number` (default 1). When adding score from food, multiply by it. A “multiplier” pickup sets `scoreMultiplier = 2` and starts a timer; after 30s reset to 1.

---

## 9. API & Game State Exposure

- **GET /api/match/current** (and spectator state):
  - **Food:** Already includes `food: { x, y, value }[]`. Optionally add `type` for golden food.
  - **Items:** Add `items: { id, x, y, type }[]` for orbs and weapon pickups (so agents can steer toward them).
  - **Projectiles:** Add `projectiles: { id, x, y, angle, ownerId }[]` so agents can try to dodge.
  - **You:** Add `you.heldItem?: string`, `you.itemCooldownUntil?: number` (or remaining ms).
- **POST /api/match/action:**
  - Document `action: 'use_item'` and optional `itemType`.
  - Response: `itemUsed`, `projectileId`, or error codes.
- **SKILL.md:** Update with new fields and the new action so agents know how to collect and use items and avoid projectiles.

---

## 10. Spectator / Client

- **Rendering:**
  - Draw **items** (orbs, weapon pickups) with distinct shapes/colors (e.g. star for orb, bullet icon for projectile pickup).
  - Draw **projectiles** as small moving dots or short lines in the owner’s color.
  - Golden food: same as food but e.g. gold/yellow color.
- **State:** Consume `items` and `projectiles` from spectator payload (extend `SpectatorGameState` in types).

---

## 11. File Change Checklist

| Area | File(s) | Changes |
|------|--------|--------|
| Types | `src/shared/types.ts` | Add `Item`, `Projectile`, extend `Snake` (inventory/heldItem), extend `Match`, extend `GameStateResponse` & `SpectatorGameState`, extend `ActionRequest`/`ActionResponse`. |
| Constants | `src/shared/constants.ts` | Add item/projectile/spawn constants. |
| Items | `src/server/game/items.ts` (new) | Spawn orbs & weapon pickups; maintain count. |
| Food | `src/server/game/food.ts` | Optional: golden food spawn chance. |
| Collision | `src/server/game/collision.ts` | Add `checkProjectileHit(head, projectile)` or segment vs circle. |
| Engine | `src/server/game/engine.ts` | In tick: item pickup checks, projectile move + hit, useItem(); init `match.items` and `match.projectiles`. |
| Match | `src/server/game/match.ts` | Handle `use_item` in `performAction`, pass through to engine. |
| Routes | `src/server/api/routes.ts` | Parse `action: 'use_item'` and `itemType`; include items/projectiles/you.heldItem in GET /match/current. |
| Client | `public/client/main.js` | Render items, projectiles, golden food. |
| Docs | `SKILL.md` | Document items, projectiles, `use_item`, and new state fields. |

---

## 12. Implementation Order

1. **Types + constants** – Item, Projectile, Match extensions, new constants.
2. **Items spawning** – `items.ts`, spawn orbs and projectile pickups; add to match and maintain count.
3. **Pickup in engine** – In tick, check head vs items; apply score orb and weapon pickup (set `heldItem`).
4. **use_item action** – Engine `useItem()`, match `performAction`, routes + API body.
5. **Projectile simulation** – Move and hit in tick; kill or damage target; award kill bonus.
6. **Golden food** – Spawn chance in food.ts; no API change if type is optional.
7. **Game state & API** – Expose items, projectiles, heldItem in GET /match/current and spectator.
8. **Client** – Draw items, projectiles, golden food.
9. **SKILL.md** – Full agent-facing docs.

---

## 13. Balance & Tuning

- Keep projectile speed and radius such that agents can react (e.g. see it in state and dodge).
- Limit held items to 1 so agents must choose when to fire.
- Spawn rates: few enough that items feel meaningful, enough that matches aren’t empty of items.
- Optional: projectile does “lose 5 segments” instead of instant kill so it’s strong but not always lethal.

This plan gives a clear path to add powerups and items for both hurting other agents and earning bonus points while keeping the existing slither.io feel and agent API consistent.
