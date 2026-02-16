/*
 * Player character using G_1.glb model.
 * Structure-agnostic: renders the full scene and plays animations by name.
 */

import React, { useEffect, useMemo, useRef } from "react";
import { useGLTF, useAnimations } from "@react-three/drei";
import { LoopOnce } from "three";
import { SkeletonUtils } from "three-stdlib";

const BASE = import.meta.env.BASE_URL;
/** Resolve model path from character name (e.g. G_1, G_2, … G_10). */
function getModelPath(character) {
  const name = character && /^G_\d+$/.test(character) ? character : "G_1";
  return `${BASE}${name}.glb`;
}

/**
 * G_1.glb animations → game state.
 * (From G_1.glb: Death, Idle, Idle_Shoot, Run, Run_Shoot.)
 * Death: play once and clamp.
 */
const ANIMATION_MAP = {
  Idle: ["Idle"],
  Run: ["Run"],
  Idle_Shoot: ["Idle_Shoot", "Idle_Shoot ", "Run_Shoot"],
  Run_Shoot: ["Run_Shoot"],
  Death: ["Death", "death"],
};

/**
 * G_1.glb gun node names → our weapon type.
 * (Updated model: Knife, Pistol, Smg, Shotgun, Rifle; older had SMG_G, Rifle_00.)
 * Only the gun matching current weapon is visible; others are hidden.
 */
const GUN_NAME_TO_WEAPON = {
  Knife: "knife",
  Pistol: "pistol",
  Smg: "smg",
  SMG_G: "smg",
  Shotgun: "shotgun",
  Rifle: "assault_rifle",
  Rifle_00: "assault_rifle",
};

function setGunVisibility(root, currentWeapon) {
  if (!root || !currentWeapon) return;
  root.traverse((obj) => {
    const weaponForChild = GUN_NAME_TO_WEAPON[obj.name];
    if (weaponForChild !== undefined) {
      obj.visible = weaponForChild === currentWeapon;
    }
  });
}

function findAction(actions, name) {
  if (actions[name]) return actions[name];
  const variants = ANIMATION_MAP[name];
  if (variants) {
    for (const v of variants) {
      if (actions[v]) return actions[v];
    }
  }
  return null;
}

/** No longer applying bloom/emissive to character body (bloom removed from characters). */
function applyBloomEmissive(_root) {
  /* intentionally no-op */
}

export function CharacterPlayer({
  character,
  animation = "Idle",
  weapon = "knife",
  bloom = true,
  ...props
}) {
  const group = useRef();
  const modelPath = getModelPath(character);
  const { scene, animations } = useGLTF(modelPath);

  const clone = useMemo(() => SkeletonUtils.clone(scene), [scene]);
  const { actions } = useAnimations(animations, group);

  /* Add emissive so bloom post-processing glows all G_*.glb characters */
  useEffect(() => {
    applyBloomEmissive(clone);
  }, [clone]);

  /* Show only the gun child that matches current weapon; hide the rest */
  useEffect(() => {
    setGunVisibility(clone, weapon);
  }, [clone, weapon]);

  useEffect(() => {
    const action = findAction(actions, animation);
    if (action) {
      if (animation === "Death") {
        action.setLoop(LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      action.reset().fadeIn(0.2).play();
      return () => action.fadeOut(0.2);
    }
    // No matching action (e.g. Death clip missing in model): hide character when dead
  }, [animation, actions]);

  const isDead = animation === "Death";
  const hasDeathAction = !!findAction(actions, "Death");
  const hideWhenDead = isDead && !hasDeathAction;

  return (
    <group ref={group} {...props} dispose={null} visible={!hideWhenDead}>
      <primitive object={clone} />
    </group>
  );
}

[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].forEach((i) => useGLTF.preload(getModelPath(`G_${i}`)));
