import { Canvas } from "@react-three/fiber";
import { Experience } from "./components/Experience";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import { Loader, PerformanceMonitor, SoftShadows } from "@react-three/drei";
import { Suspense, useState } from "react";
import { Physics } from "@react-three/rapier";
import { Leaderboard } from "./components/Leaderboard";
import { GameManagerProvider } from "./components/GameManager";
import { SpectatorCamera } from "./components/SpectatorCamera";

function App() {
  const [downgradedPerformance, setDowngradedPerformance] = useState(false);

  return (
    <>
      <Loader />
      <GameManagerProvider>
        <Leaderboard />
        <Canvas shadows camera={{ position: [0, 40, 25], fov: 30, near: 2 }}>
          <color attach="background" args={["#242424"]} />

          <SoftShadows size={42} />

          <PerformanceMonitor
            onDecline={(fps) => setDowngradedPerformance(true)}
          />

          <Suspense>
            <Physics>
              <SpectatorCamera />
              <Experience downgradedPerformance={downgradedPerformance} />
            </Physics>
          </Suspense>

          {!downgradedPerformance && (
            <EffectComposer disableNormalPass>
              <Bloom luminanceThreshold={1} intensity={1} mipmapBlur />
            </EffectComposer>
          )}
        </Canvas>
      </GameManagerProvider>
    </>
  );
}

export default App;
