/**
 * Runtime snake image generator.
 * Composes Body + Eyes + Mouth PNGs along an S-curve path with tapering segments.
 * Uses skia-canvas (optional dependency).
 */

import { join, basename } from 'path';
import { readFile } from 'fs/promises';

const SKINS_BASE = join(process.cwd(), 'public', 'skins');

export interface SnakeGeneratorConfig {
  bodySegments: number;
  tailScale: number;
  curve: {
    totalLength: number;
    amplitude: number;
    frequency: number;
    segmentSpacingScale: number;
    tailSpacingRatio: number;
  };
  partScale: number;
  headScale: number;
  /** Optional multiplier for body segment size (e.g. 1.25 for 25% larger segments in preview) */
  segmentScaleMultiplier?: number;
  canvas: { width: number; height: number };
  padding: number;
}

const DEFAULT_CONFIG: SnakeGeneratorConfig = {
  bodySegments: 15,
  tailScale: 0.25,
  curve: {
    totalLength: 1400,
    amplitude: 180,
    frequency: 2,
    segmentSpacingScale: 2.75, /* increased for more gap between segments in preview */
    tailSpacingRatio: 0.25,
  },
  partScale: 0.5,   /* 0.4 * 1.25 for 25% larger preview snake */
  headScale: 1.75,  /* 1.4 * 1.25 for 25% larger preview snake */
  segmentScaleMultiplier: 1.25, /* so body segments match the 25% preview size increase */
  canvas: { width: 3072, height: 2048 },
  padding: 80,
};

export interface GenerateSnakeResult {
  buffer: Buffer;
  traits: { body: string; eyes: string; mouth: string };
  width: number;
  height: number;
}

export interface HeadInfo {
  headCanvas: unknown;
  bodyTexture: unknown;
  traits: { body: string; eyes: string; mouth: string };
}

export interface HeadPlacement {
  headCenterX: number;
  headCenterY: number;
  headAngle: number;
  headScale: number;
}

let skiaCanvas: { Canvas: new (w: number, h: number) => unknown; Image: new (data: Buffer) => unknown } | null = null;

async function loadSkiaCanvas(): Promise<typeof skiaCanvas> {
  if (skiaCanvas) return skiaCanvas;
  try {
    const mod = await import('skia-canvas');
    skiaCanvas = { Canvas: mod.Canvas, Image: mod.Image };
    return skiaCanvas;
  } catch {
    return null;
  }
}

export async function isGeneratorAvailable(): Promise<boolean> {
  const skia = await loadSkiaCanvas();
  return skia !== null;
}

async function loadImage(filePath: string): Promise<unknown> {
  const data = await readFile(filePath);
  const { Image } = (await loadSkiaCanvas())!;
  return new (Image as new (data: Buffer) => unknown)(data);
}

async function composeHead(
  bodyPath: string,
  eyesPath: string,
  mouthPath: string
): Promise<HeadInfo> {
  const [bodyImg, eyesImg, mouthImg] = await Promise.all([
    loadImage(bodyPath) as Promise<{ width: number; height: number }>,
    loadImage(eyesPath) as Promise<{ width: number; height: number }>,
    loadImage(mouthPath) as Promise<{ width: number; height: number }>,
  ]);

  const width = bodyImg.width;
  const height = bodyImg.height;

  const { Canvas } = (await loadSkiaCanvas())!;
  const headCanvas = new (Canvas as new (w: number, h: number) => unknown)(width, height) as {
    getContext: (ctx: string) => { clearRect: (a: number, b: number, c: number, d: number) => void; drawImage: (img: unknown, a: number, b: number, c: number, d: number) => void };
  };
  const ctx = headCanvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(bodyImg, 0, 0, width, height);
  ctx.drawImage(eyesImg, 0, 0, width, height);
  ctx.drawImage(mouthImg, 0, 0, width, height);

  return {
    headCanvas,
    bodyTexture: bodyImg,
    traits: {
      body: basename(bodyPath),
      eyes: basename(eyesPath),
      mouth: basename(mouthPath),
    },
  };
}

function computeSnakePath(config: SnakeGeneratorConfig): { x: number; y: number }[] {
  const { totalLength, amplitude, frequency, segmentSpacingScale = 1, tailSpacingRatio = 1 } = config.curve;
  const { bodySegments } = config;

  const effectiveLength = totalLength * segmentSpacingScale;
  const n = bodySegments;

  const dMax = (2 * effectiveLength) / (n * (1 + tailSpacingRatio));
  const dMin = dMax * tailSpacingRatio;
  const gaps: number[] = [];
  for (let i = 0; i < n; i++) {
    const frac = n > 1 ? i / (n - 1) : 0;
    gaps.push(dMax - (dMax - dMin) * frac);
  }

  const points: { x: number; y: number }[] = [];
  let x = 0;
  for (let i = 0; i <= bodySegments; i++) {
    const t = i / bodySegments;
    const y = amplitude * Math.sin(t * frequency * Math.PI);
    points.push({ x, y });
    if (i < bodySegments) x += gaps[i];
  }
  return points;
}

function computeScales(bodySegments: number, tailScale: number): number[] {
  const scales = [1];
  for (let i = 1; i <= bodySegments; i++) {
    const t = (bodySegments - 1) ? (i - 1) / (bodySegments - 1) : 0;
    scales.push(1 - (1 - tailScale) * t);
  }
  return scales;
}

function computeTangents(points: { x: number; y: number }[]): number[] {
  return points.map((p, i) => {
    const q = points[i + 1] ?? p;
    return Math.atan2(q.y - p.y, q.x - p.x);
  });
}

interface DrawContext {
  save(): void;
  restore(): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  translate(x: number, y: number): void;
  rotate(r: number): void;
  drawImage(img: unknown, x: number, y: number, w: number, h: number): void;
}

function drawBodySegments(
  ctx: DrawContext,
  cfg: SnakeGeneratorConfig & { canvas: { width: number; height: number } },
  headInfo: HeadInfo,
  pathPoints: { x: number; y: number }[],
  scales: number[],
  angles: number[]
): HeadPlacement {
  const bodyTexture = headInfo.bodyTexture as { width: number; height: number };
  const baseW = bodyTexture.width;
  const baseH = bodyTexture.height;

  const partScale = cfg.partScale || 1;
  const padding = cfg.padding ?? 0;
  const headScaleMultiplier = cfg.headScale ?? 1;
  const segmentScaleMultiplier = cfg.segmentScaleMultiplier ?? 1;

  const headHalfWidth = (baseW * partScale * headScaleMultiplier) / 2;
  const offsetX = padding + headHalfWidth;
  const offsetY = cfg.canvas.height / 2;

  for (let i = cfg.bodySegments; i >= 1; i--) {
    const p = pathPoints[i];
    const scale = scales[i] * partScale * segmentScaleMultiplier;
    const w = baseW * scale;
    const h = baseH * scale;

    ctx.save();
    ctx.translate(offsetX + p.x, offsetY + p.y);
    ctx.rotate(angles[i]);
    ctx.drawImage(bodyTexture, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  const headPoint = pathPoints[0];
  return {
    headCenterX: offsetX + headPoint.x,
    headCenterY: offsetY + headPoint.y,
    headAngle: angles[0],
    headScale: scales[0] * partScale * headScaleMultiplier,
  };
}

function drawHead(ctx: DrawContext, headInfo: HeadInfo, placement: HeadPlacement): void {
  const headCanvas = headInfo.headCanvas as { width: number; height: number };
  const w = headCanvas.width * placement.headScale;
  const h = headCanvas.height * placement.headScale;

  ctx.save();
  ctx.translate(placement.headCenterX, placement.headCenterY);
  ctx.rotate(placement.headAngle);
  ctx.drawImage(headCanvas, -w / 2, -h / 2, w, h);
  ctx.restore();
}

/**
 * Generate a snake PNG from body, eyes, and mouth asset paths (full filesystem paths).
 */
export async function generateSnake(
  bodyPath: string,
  eyesPath: string,
  mouthPath: string,
  config: Partial<SnakeGeneratorConfig> = {}
): Promise<GenerateSnakeResult> {
  const skia = await loadSkiaCanvas();
  if (!skia) {
    throw new Error('skia-canvas is not installed. Install it with: npm install skia-canvas');
  }

  const cfg = { ...DEFAULT_CONFIG, ...config };

  const headInfo = await composeHead(bodyPath, eyesPath, mouthPath);

  const pathPoints = computeSnakePath(cfg);
  const scales = computeScales(cfg.bodySegments, cfg.tailScale);
  const tangents = computeTangents(pathPoints);

  const baseW = (headInfo.bodyTexture as { width: number }).width;
  const baseH = (headInfo.bodyTexture as { height: number }).height;
  const partScale = cfg.partScale || 1;
  const padding = cfg.padding ?? 0;
  const headScaleMultiplier = cfg.headScale ?? 1;
  const spacingScale = cfg.curve.segmentSpacingScale || 1;
  const effectiveLength = cfg.curve.totalLength * spacingScale;
  const amplitude = cfg.curve.amplitude || 0;

  const segmentScaleMultiplier = cfg.segmentScaleMultiplier ?? 1;
  const headHalfWidth = (baseW * partScale * headScaleMultiplier) / 2;
  const tailHalfWidth = (baseW * partScale * (cfg.tailScale ?? 0.25) * segmentScaleMultiplier) / 2;
  const requiredWidth = 2 * padding + effectiveLength + headHalfWidth + tailHalfWidth;
  const requiredHeight = 2 * padding + 2 * amplitude + baseH * partScale * segmentScaleMultiplier;
  const canvasWidth = Math.ceil(Math.max(cfg.canvas.width, requiredWidth));
  const canvasHeight = Math.ceil(Math.max(cfg.canvas.height, requiredHeight));

  const Canvas = skia.Canvas as new (w: number, h: number) => {
    getContext(ctx: string): DrawContext;
    toBuffer(format: string): Promise<Buffer>;
  };
  const canvas = new Canvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  const placement = drawBodySegments(
    ctx,
    { ...cfg, canvas: { width: canvasWidth, height: canvasHeight } },
    headInfo,
    pathPoints,
    scales,
    tangents
  );
  drawHead(ctx, headInfo, placement);

  const buffer = await canvas.toBuffer('png');
  return {
    buffer,
    traits: headInfo.traits,
    width: canvasWidth,
    height: canvasHeight,
  };
}

/**
 * Resolve body/eyes/mouth IDs (e.g. "Common/aqua.png") to full filesystem paths.
 */
export function getSkinPartPaths(bodyId: string, eyesId: string, mouthId: string): {
  bodyPath: string;
  eyesPath: string;
  mouthPath: string;
} {
  return {
    bodyPath: join(SKINS_BASE, 'Body', bodyId),
    eyesPath: join(SKINS_BASE, 'Eyes', eyesId),
    mouthPath: join(SKINS_BASE, 'Mouth', mouthId),
  };
}
