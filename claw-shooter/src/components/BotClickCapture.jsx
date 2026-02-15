import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import { useGameManager } from "./GameManager";

/**
 * Listens to pointer down on the canvas, runs the raycaster, and if the hit
 * object (or any parent) has userData.botId, selects that bot for third-person camera.
 */
export function BotClickCapture() {
  const dom = useThree((s) => s.gl.domElement);
  const camera = useThree((s) => s.camera);
  const raycaster = useThree((s) => s.raycaster);
  const scene = useThree((s) => s.scene);
  const { selectedBotId, setSelectedBotId } = useGameManager();

  useEffect(() => {
    const handler = (e) => {
      const rect = dom.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera({ x, y }, camera);
      const hits = raycaster.intersectObjects(scene.children, true);
      const first = hits[0];
      if (first?.object) {
        let obj = first.object;
        while (obj) {
          if (obj.userData?.botId) {
            const botId = obj.userData.botId;
            setSelectedBotId(selectedBotId === botId ? null : botId);
            return;
          }
          obj = obj.parent;
        }
      }
    };
    dom.addEventListener("pointerdown", handler);
    return () => dom.removeEventListener("pointerdown", handler);
  }, [dom, camera, raycaster, scene, selectedBotId, setSelectedBotId]);

  return null;
}
