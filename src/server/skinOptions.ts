import { readdirSync, existsSync } from 'fs';
import { join } from 'path';

const SKINS_BASE = join(process.cwd(), 'public', 'skins');
const BODY_DIR = join(SKINS_BASE, 'Body');
const EYES_DIR = join(SKINS_BASE, 'Eyes');
const MOUTH_DIR = join(SKINS_BASE, 'Mouth');

/** Recursively collect relative paths of .png files under dir (relative to category dir). */
function listPngPaths(dir: string, baseDir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    const rel = full.slice(baseDir.length + 1).replace(/\\/g, '/');
    if (e.isDirectory()) {
      listPngPaths(full, baseDir, out);
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.png')) {
      out.push(rel);
    }
  }
}

export interface SkinOptionsResponse {
  bodies: string[];
  eyes: string[];
  mouths: string[];
}

export function getSkinOptions(): SkinOptionsResponse {
  const bodies: string[] = [];
  const eyes: string[] = [];
  const mouths: string[] = [];
  listPngPaths(BODY_DIR, BODY_DIR, bodies);
  listPngPaths(EYES_DIR, EYES_DIR, eyes);
  listPngPaths(MOUTH_DIR, MOUTH_DIR, mouths);
  return { bodies, eyes, mouths };
}
