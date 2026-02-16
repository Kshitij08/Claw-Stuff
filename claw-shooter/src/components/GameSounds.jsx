/**
 * GameSounds – BGM + one-shot SFX.
 * Files: bg music.mp3, death1.mp3, knife stab.mp3, pistol.mp3 (used for all guns, combo by type).
 */

import { useEffect, useRef } from "react";
import { useGameManager } from "./GameManager";

const SOUNDS_BASE = "/claw-shooter/sounds";

const sound = (name) => `${SOUNDS_BASE}/${encodeURIComponent(name)}`;
const BGM_URL = sound("bg music.mp3");
const DEATH_URL = sound("death1.mp3");
const KNIFE_STAB_URL = sound("knife stab.mp3");
const PISTOL_SHOT_URL = sound("pistol.mp3");

/** SFX at 200% (BGM stays low). */
const SFX_VOLUME = 2;
const gunshotVol = Math.min(1, 0.5 * SFX_VOLUME);
const deathVol = Math.min(1, 0.7 * SFX_VOLUME);
const knifeVol = Math.min(1, 0.6 * SFX_VOLUME);

/** Play gunshot(s): pistol = 1, smg = 1, shotgun = 2 quick, assault_rifle = 1. All use pistol.mp3. */
function playGunshot(weapon, volume = gunshotVol) {
  if (!PISTOL_SHOT_URL) return;
  try {
    const play = () => {
      const a = new Audio(PISTOL_SHOT_URL);
      a.volume = volume;
      a.play().catch(() => {});
    };
    play();
    if (weapon === "shotgun") setTimeout(play, 80);
  } catch (_) {}
}

function playOneShot(url, volume = knifeVol) {
  if (!url) return;
  try {
    const a = new Audio(url);
    a.volume = volume;
    a.play().catch(() => {});
  } catch (_) {}
}

export function GameSounds() {
  const { shots, hits } = useGameManager();
  const bgRef = useRef(null);
  const prevShotsLen = useRef(0);
  const prevHitsLen = useRef(0);

  // BGM – bg music.mp3 (with autoplay resume on first user gesture)
  useEffect(() => {
    const audio = new Audio(BGM_URL);
    audio.loop = true;
    audio.volume = 0.4;
    bgRef.current = audio;

    let started = false;
    const tryPlay = () => {
      if (started || !bgRef.current) return;
      bgRef.current.play().then(() => {
        started = true;
        window.removeEventListener("click", tryPlay);
        window.removeEventListener("keydown", tryPlay);
        window.removeEventListener("pointerdown", tryPlay);
      }).catch(() => {});
    };

    // Try immediately (works if autoplay allowed)
    tryPlay();
    // Fallback: resume on first user gesture
    window.addEventListener("click", tryPlay);
    window.addEventListener("keydown", tryPlay);
    window.addEventListener("pointerdown", tryPlay);

    return () => {
      audio.pause();
      bgRef.current = null;
      window.removeEventListener("click", tryPlay);
      window.removeEventListener("keydown", tryPlay);
      window.removeEventListener("pointerdown", tryPlay);
    };
  }, []);

  // New shots → pistol.mp3 per gun (shotgun = double tap). Keep prevShotsLen in sync when array is trimmed.
  useEffect(() => {
    if (!Array.isArray(shots)) return;
    if (shots.length === 0) {
      prevShotsLen.current = 0;
      return;
    }
    if (shots.length <= prevShotsLen.current) {
      prevShotsLen.current = shots.length;
      return;
    }
    const from = prevShotsLen.current;
    prevShotsLen.current = shots.length;
    for (let i = from; i < shots.length; i++) {
      const weapon = shots[i]?.weapon;
      if (weapon === "knife") continue;
      playGunshot(weapon || "pistol", gunshotVol);
    }
  }, [shots?.length, shots]);

  // New hits → death1.mp3 (if killed), knife stab.mp3 (if knife)
  useEffect(() => {
    if (!Array.isArray(hits)) return;
    if (hits.length === 0) {
      prevHitsLen.current = 0;
      return;
    }
    if (hits.length <= prevHitsLen.current) {
      prevHitsLen.current = hits.length;
      return;
    }
    const from = prevHitsLen.current;
    prevHitsLen.current = hits.length;
    for (let i = from; i < hits.length; i++) {
      const hit = hits[i];
      if (hit.killed) playOneShot(DEATH_URL, deathVol);
      if (hit.weapon === "knife") playOneShot(KNIFE_STAB_URL, knifeVol);
    }
  }, [hits?.length, hits]);

  return null;
}
