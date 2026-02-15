/*
 * Player character using G_1.glb model.
 * Structure-agnostic: renders the full scene and plays animations by name.
 */

import React, { useEffect, useMemo, useRef } from "react";
import { useGLTF, useAnimations } from "@react-three/drei";
import { SkeletonUtils } from "three-stdlib";

/** Load from app root (same folder as index.html). Put G_1.glb in claw-shooter/public/ so it is copied to public/claw-shooter/ on build. */
const MODEL_PATH = `${import.meta.env.BASE_URL}G_1.glb`;

/**
 * G_1.glb contains: Idle, Run, Run_Shoot.
 * Idle_Shoot uses Run_Shoot; Death = character hidden (no animation).
 */
const ANIMATION_MAP = {
  Idle: ["Idle"],
  Run: ["Run"],
  Idle_Shoot: ["Run_Shoot"],
  Run_Shoot: ["Run_Shoot"],
  Death: [],
};

/**
 * G_1.glb gun node names → our weapon type.
 * (From G_1.glb: root weapon nodes are Knife, Pistol, SMG_G, Shotgun, Rifle_00; rest are internals.)
 * Only the gun matching current weapon is visible; others are hidden.
 */
const GUN_NAME_TO_WEAPON = {
  Knife: "knife",
  Pistol: "pistol",
  SMG_G: "smg",
  Shotgun: "shotgun",
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

export function CharacterPlayer({
  character,
  animation = "Idle",
  weapon = "knife",
  ...props
}) {
  const group = useRef();
  const { scene, animations } = useGLTF(MODEL_PATH);

  const clone = useMemo(() => SkeletonUtils.clone(scene), [scene]);
  const { actions } = useAnimations(animations, group);

  /* Show only the gun child that matches current weapon; hide the rest */
  useEffect(() => {
    setGunVisibility(clone, weapon);
  }, [clone, weapon]);

  useEffect(() => {
    if (animation === "Death") return; // Death = invisible, no animation
    const action = findAction(actions, animation);
    if (action) {
      action.reset().fadeIn(0.2).play();
      return () => action.fadeOut(0.2);
    }
  }, [animation, actions]);

  const isDead = animation === "Death";

  return (
    <group ref={group} {...props} dispose={null} visible={!isDead}>
      <primitive object={clone} />
    </group>
  );
}

useGLTF.preload(MODEL_PATH);
