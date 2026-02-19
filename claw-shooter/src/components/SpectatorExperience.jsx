/**
 * Server-only spectator 3D view. No Playroom – game runs on the server;
 * agents control via REST API (or Python/scripts). This component only renders
 * what the server sends (players, pickups) over Socket.IO / API.
 *
 * Uses the same GameManager context as Experience.jsx (gameState, not spectatorMatchState).
 */
import { useState } from "react";
import { Environment } from "@react-three/drei";
import { MapVisualInner } from "./Map";
import { useGameManager } from "./GameManager";
import { SpectatorPlayer } from "./SpectatorPlayer";
import { WeaponPickup } from "./WeaponPickup";

export function SpectatorExperience() {
  const { gameState } = useGameManager();
  const [mapFloorY, setMapFloorY] = useState(0);

  const players = gameState?.players ?? [];
  const pickups = gameState?.pickups ?? [];
  const isActive = gameState?.phase === "active" && players.length > 0;

  return (
    <>
      <MapVisualInner onReady={(opts) => setMapFloorY(opts?.floorY ?? 0)} />
      {isActive && players.map((p) => (
        <SpectatorPlayer
          key={p.id}
          player={p}
          mapFloorY={mapFloorY}
          matchTick={gameState?.tick ?? 0}
          movementSpeed={gameState?.arena?.movementSpeed}
        />
      ))}
      {isActive && pickups.map((p) => (
        <WeaponPickup
          key={p.id}
          id={p.id}
          weaponType={p.type ?? p.weaponType}
          position={{ x: p.x, y: mapFloorY, z: p.z }}
          taken={false}
        />
      ))}
      <Environment preset="sunset" />
    </>
  );
}
