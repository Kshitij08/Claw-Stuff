import { Canvas } from "@react-three/fiber";
import { Experience } from "./components/Experience";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import { Loader, SoftShadows } from "@react-three/drei";
import { Suspense } from "react";
import { Physics } from "@react-three/rapier";
import { Leaderboard } from "./components/Leaderboard";
import { GameManagerProvider } from "./components/GameManager";
import { SpectatorCamera } from "./components/SpectatorCamera";

function App() {
  return (
    <>
      <Loader />
      <GameManagerProvider>
        <Leaderboard />
        <Canvas shadows camera={{ position: [0, 40, 25], fov: 30, near: 2 }}>
          <color attach="background" args={["#242424"]} />

          <SoftShadows size={42} />

          <Suspense>
            <Physics>
              <SpectatorCamera />
              <Experience />
            </Physics>
          </Suspense>

          <EffectComposer disableNormalPass>
            <Bloom luminanceThreshold={1} intensity={1} mipmapBlur />
          </EffectComposer>
        </Canvas>
      </GameManagerProvider>
    </>
  );
}

export default App;
