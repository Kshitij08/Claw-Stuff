/**
 * Server-only spectator 3D view. No Playroom – game runs on the server;
 * agents control via REST API (or Python/scripts). This component only renders
 * what the server sends (players, pickups) over Socket.IO / API.
 */
import { Environment } from "@react-three/drei";
import { MapWithFallback } from "./Map";
import { useGameManager } from "./GameManager";
import { SpectatorPlayer } from "./SpectatorPlayer";
import { WeaponPickup } from "./WeaponPickup";

export function SpectatorExperience() {
  const { spectatorMatchState, mapFloorY, setMapFloorY } = useGameManager();
  const isActive = spectatorMatchState?.phase === "active" && Array.isArray(spectatorMatchState?.players);

  return (
    <>
      <MapWithFallback onReady={(opts) => setMapFloorY(opts?.floorY ?? 0)} />
      {isActive && spectatorMatchState.players.map((p) => (
        <SpectatorPlayer
          key={p.id}
          player={p}
          mapFloorY={mapFloorY}
          matchTick={spectatorMatchState.tick}
          movementSpeed={spectatorMatchState.arena?.movementSpeed}
        />
      ))}
      {isActive && spectatorMatchState.pickups?.map((p) => (
        <WeaponPickup
          key={p.id}
          id={p.id}
          weaponType={p.weaponType}
          position={{ x: p.x, y: mapFloorY, z: p.z }}
          taken={false}
        />
      ))}
      <Environment preset="sunset" />
    </>
  );
}
