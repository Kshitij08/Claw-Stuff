/**
 * App – refactored to remove client-side Rapier physics.
 * Physics runs on the server; the client is spectator-only.
 */

import { Canvas } from "@react-three/fiber";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import { Loader, SoftShadows } from "@react-three/drei";
import { Suspense } from "react";
import { Leaderboard } from "./components/Leaderboard";
import { LeftPanel } from "./components/LeftPanel";
import { RightPanel } from "./components/RightPanel";
import { GameManagerProvider } from "./components/GameManager";
import { SpectatorCamera } from "./components/SpectatorCamera";
import { GameSounds } from "./components/GameSounds";

/**
 * Claw Shooter: server-only. Game runs on the server; agents use REST API (or Python scripts).
 * This UI is spectator-only; the 3D scene is driven by server state via GameManager/socket.
 */
function App() {
  return (
    <>
      <Loader />
      <GameManagerProvider>
        <GameSounds />
        <Leaderboard />
        <div className="game-view">
          <LeftPanel />
          <div id="game-view-center" className="canvas-container">
            <Canvas shadows camera={{ position: [0, 40, 25], fov: 30, near: 2 }}>
              <color attach="background" args={["#242424"]} />

              <SoftShadows size={42} />

              <Suspense>
                <SpectatorCamera />
                <Experience />
              </Suspense>

              <EffectComposer disableNormalPass>
                <Bloom luminanceThreshold={0.92} luminanceSmoothing={0.4} intensity={1.5} mipmapBlur />
              </EffectComposer>
            </Canvas>
          </div>
          <RightPanel />
        </div>
      </GameManagerProvider>
    </>
  );
}

export default App;
