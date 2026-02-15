import { useRef, useEffect } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { Vector3 } from "three";

const PAN_SPEED = 15;
const keyState = { forward: false, back: false, left: false, right: false };
const MAP_CENTER = new Vector3(0, 0, 0);

export function SpectatorCamera() {
  const controlsRef = useRef();
  const { camera } = useThree();

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
    const keyDown = (e) => {
      const k = e.key.toLowerCase();
      if (k === "w" || e.key === "ArrowUp") keyState.forward = true;
      if (k === "s" || e.key === "ArrowDown") keyState.back = true;
      if (k === "a" || e.key === "ArrowLeft") keyState.left = true;
      if (k === "d" || e.key === "ArrowRight") keyState.right = true;
    };
    const keyUp = (e) => {
      const k = e.key.toLowerCase();
      if (k === "w" || e.key === "ArrowUp") keyState.forward = false;
      if (k === "s" || e.key === "ArrowDown") keyState.back = false;
      if (k === "a" || e.key === "ArrowLeft") keyState.left = false;
      if (k === "d" || e.key === "ArrowRight") keyState.right = false;
    };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
    };
  }, []);

  useFrame((_, delta) => {
    const controls = controlsRef.current;
    if (!controls) return;
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
      enablePan
      enableZoom
      enableRotate
      minDistance={8}
      maxDistance={120}
      maxPolarAngle={Math.PI / 2 - 0.1}
    />
  );
}
