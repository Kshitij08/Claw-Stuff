import { useRef, useEffect } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { usePlayersList } from "playroomkit";
import { Vector3 } from "three";
import { useGameManager } from "./GameManager";

const PAN_SPEED = 15;
const keyState = { forward: false, back: false, left: false, right: false };
const MAP_CENTER = new Vector3(0, 0, 0);

/** Third-person offset: camera behind and above the bot (world space). */
const THIRD_PERSON_OFFSET = new Vector3(0, 6, 10);
const THIRD_PERSON_LOOK_AT_Y = 1.5;
/** Smoothing factor for follow camera: 1 = instant, lower = smoother (reduces jitter). */
const FOLLOW_SMOOTH = 12;

export function SpectatorCamera() {
  const controlsRef = useRef();
  const { camera } = useThree();
  const { selectedBotId, setSelectedBotId } = useGameManager();
  const players = usePlayersList(true);
  const followPosRef = useRef(new Vector3());
  const followTargetRef = useRef(new Vector3());
  const followInitializedRef = useRef(false);
  const leftMouseDownRef = useRef(false);
  const userHasRotatedRef = useRef(false);

  const applyCameraOverMap = () => {
    if (!controlsRef.current) return;
    controlsRef.current.target.copy(MAP_CENTER);
    camera.position.set(0, 40, 25);
    camera.lookAt(MAP_CENTER);
    controlsRef.current.update();
  };

  useEffect(() => {
    applyCameraOverMap();
    const t = setTimeout(applyCameraOverMap, 800);
    return () => clearTimeout(t);
  }, [camera]);

  useEffect(() => {
    if (selectedBotId === null) {
      applyCameraOverMap();
    }
  }, [selectedBotId]);

  useEffect(() => {
    const onPointerDown = (e) => {
      if (e.button === 0) {
        leftMouseDownRef.current = true;
        if (selectedBotId) userHasRotatedRef.current = true;
      }
    };
    const onPointerUp = (e) => {
      if (e.button === 0) leftMouseDownRef.current = false;
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [selectedBotId]);

  useEffect(() => {
    const onKeyDown = (e) => {
      const k = e.key.toLowerCase();
      if (k === "escape") {
        setSelectedBotId(null);
        return;
      }
      if (k === "w" || e.key === "ArrowUp") keyState.forward = true;
      if (k === "s" || e.key === "ArrowDown") keyState.back = true;
      if (k === "a" || e.key === "ArrowLeft") keyState.left = true;
      if (k === "d" || e.key === "ArrowRight") keyState.right = true;
    };
    const onKeyUp = (e) => {
      const k = e.key.toLowerCase();
      if (k === "w" || e.key === "ArrowUp") keyState.forward = false;
      if (k === "s" || e.key === "ArrowDown") keyState.back = false;
      if (k === "a" || e.key === "ArrowLeft") keyState.left = false;
      if (k === "d" || e.key === "ArrowRight") keyState.right = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [setSelectedBotId]);

  useFrame((_, delta) => {
    const controls = controlsRef.current;
    if (!controls) return;

    if (selectedBotId) {
      const bot = players.find((p) => p.id === selectedBotId);
      const pos = bot?.state?.pos ?? bot?.state?.getState?.("pos");
      if (pos) {
        const bx = pos.x ?? 0;
        const by = pos.y ?? 0;
        const bz = pos.z ?? 0;
        const wantCam = new Vector3(bx + THIRD_PERSON_OFFSET.x, by + THIRD_PERSON_OFFSET.y, bz + THIRD_PERSON_OFFSET.z);
        const wantTgt = new Vector3(bx, by + THIRD_PERSON_LOOK_AT_Y, bz);
        if (!followInitializedRef.current) {
          followPosRef.current.copy(wantCam);
          followTargetRef.current.copy(wantTgt);
          followInitializedRef.current = true;
        }
        const isRotating = leftMouseDownRef.current;
        const keepUserAngle = userHasRotatedRef.current;
        if (isRotating || keepUserAngle) {
          followTargetRef.current.lerp(wantTgt, Math.min(1, FOLLOW_SMOOTH * delta));
          controls.target.copy(followTargetRef.current);
          followPosRef.current.copy(camera.position);
        } else {
          followPosRef.current.lerp(wantCam, Math.min(1, FOLLOW_SMOOTH * delta));
          followTargetRef.current.lerp(wantTgt, Math.min(1, FOLLOW_SMOOTH * delta));
          camera.position.copy(followPosRef.current);
          controls.target.copy(followTargetRef.current);
        }
        controls.update();
      }
      return;
    }
    followInitializedRef.current = false;
    userHasRotatedRef.current = false;

    const target = controls.target;
    const cam = camera;
    const forward = new Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    forward.y = 0;
    forward.normalize();
    const right = new Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    right.y = 0;
    right.normalize();
    const move = PAN_SPEED * delta;
    if (keyState.forward) target.addScaledVector(forward, -move);
    if (keyState.back) target.addScaledVector(forward, move);
    if (keyState.left) target.addScaledVector(right, -move);
    if (keyState.right) target.addScaledVector(right, move);
  });

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      target={[0, 0, 0]}
      enablePan={!selectedBotId}
      enableZoom={!selectedBotId}
      enableRotate
      minDistance={8}
      maxDistance={120}
      maxPolarAngle={Math.PI / 2 - 0.1}
    />
  );
}
