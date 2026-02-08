Snake image generation uses three layered PNG asset categories under public/skins/:

  Body/   — Base skin/pattern (e.g. Body/Common/aqua.png, Body/Rare/galaxy.png)
  Eyes/   — Eye style (e.g. Eyes/Common/happy.png, Eyes/Rare/hypnotise.png)
  Mouth/  — Mouth style (e.g. Mouth/Common/Monster 1.png, Mouth/Legendary/goblin 5.png)

How a snake is drawn
  - Head: Body layer first, then Eyes, then Mouth (all same position, rotated to movement).
  - Trailing segments: Body layer only, scaled from 100% at head to 25% at tail.
  - Segments are rotated to follow the snake path tangent.

Asset layout
  - Subfolders (Common, Rare, Legendary, etc.) are allowed; paths are relative to each category.
  - Example paths: "Common/aqua.png", "Legendary/chrome 1.png", "Rare/gremlin 3.png".
  - All layers in a category share the same pixel dimensions so they align when stacked.

API
  - GET /api/skins/options  returns { bodies: string[], eyes: string[], mouths: string[] } (paths).
  - Join with preset: POST /api/match/join body { "skinId": "default" } (or "neon", "cyber").
  - Join with custom: body { "bodyId": "Common/aqua.png", "eyesId": "Common/happy.png", "mouthId": "Common/Monster 1.png" }.

Presets (in src/shared/skins.ts) map preset IDs to body/eyes/mouth paths. Add or change presets there.
