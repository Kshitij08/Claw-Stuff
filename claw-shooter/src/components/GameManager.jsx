import { createContext, useContext, useState, useCallback, useRef, useEffect } from "react";
import { Vector3 } from "three";
import { GUN_TYPES, PLAYER_COUNT, WEAPON_RESPAWN_DELAY } from "../constants/weapons";

const GameManagerContext = createContext(null);

export function GameManagerProvider({ children }) {
  const [gamePhase, setGamePhase] = useState("lobby"); // lobby -> countdown -> playing -> ended
  const [countdown, setCountdown] = useState(0);
  const [weaponPickups, setWeaponPickups] = useState([]);
  const [finalRanking, setFinalRanking] = useState([]);
  const countdownRef = useRef(null);
  const spawnPositionsRef = useRef([]);

  const startMatch = useCallback(() => {
    if (gamePhase !== "lobby") return;
    setGamePhase("countdown");
    let remaining = 3;
    setCountdown(remaining);
    countdownRef.current = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(countdownRef.current);
        countdownRef.current = null;
        setCountdown(0);
        setGamePhase("playing");
      } else {
        setCountdown(remaining);
      }
    }, 1000);
  }, [gamePhase]);

  const takePickup = useCallback((pickupId) => {
    setWeaponPickups((prev) =>
      prev.map((p) => (p.id === pickupId ? { ...p, taken: true } : p))
    );
  }, []);

  const spawnWeaponPickups = useCallback((spawnPositions) => {
    if (!spawnPositions || spawnPositions.length === 0) return;
    spawnPositionsRef.current = spawnPositions;
    const positions = [...spawnPositions];
    shuffle(positions);
    const pickups = [];
    const count = Math.min(PLAYER_COUNT, positions.length);
    for (let i = 0; i < count; i++) {
      const weaponType = GUN_TYPES[i % GUN_TYPES.length];
      const pos = positions[i];
      pickups.push({
        id: `pickup-${i}-${Date.now()}`,
        weaponType,
        position: pos instanceof Vector3 ? pos : new Vector3(pos.x, pos.y, pos.z),
        taken: false,
      });
    }
    setWeaponPickups(pickups);
  }, []);

  /* Auto-respawn a new set of weapons once every pickup has been taken */
  useEffect(() => {
    if (weaponPickups.length === 0) return;
    if (!weaponPickups.every((p) => p.taken)) return;
    if (gamePhase !== "playing") return;
    const timer = setTimeout(() => {
      if (spawnPositionsRef.current.length > 0) {
        spawnWeaponPickups(spawnPositionsRef.current);
      }
    }, WEAPON_RESPAWN_DELAY);
    return () => clearTimeout(timer);
  }, [weaponPickups, gamePhase, spawnWeaponPickups]);

  const checkWinCondition = useCallback((players) => {
    if (gamePhase !== "playing") return;
    const alive = players.filter((p) => {
      const state = p.state;
      if (!state) return false;
      const eliminated = state.getState?.("eliminated") ?? state.eliminated;
      const lives = state.getState?.("lives") ?? state.lives ?? 3;
      const dead = state.getState?.("dead") ?? state.dead;
      return !eliminated && lives > 0 && !dead;
    });
    if (alive.length <= 1) {
      const ranking = [...players]
        .filter((p) => p.state)
        .sort((a, b) => {
          const ak = a.state.getState?.("kills") ?? a.state.kills ?? 0;
          const bk = b.state.getState?.("kills") ?? b.state.kills ?? 0;
          return bk - ak;
        })
        .map((p, i) => ({
          rank: i + 1,
          id: p.state?.id ?? p.id,
          name: p.state?.getProfile?.()?.name ?? p.state?.profile?.name ?? p.id,
          kills: p.state?.getState?.("kills") ?? p.state?.kills ?? 0,
          deaths: p.state?.getState?.("deaths") ?? p.state?.deaths ?? 0,
          personality: p.state?.getState?.("personality") ?? p.state?.personality ?? "?",
        }));
      setFinalRanking(ranking);
      setGamePhase("ended");
    }
  }, [gamePhase]);

  const restartRound = useCallback((spawnPositions) => {
    setGamePhase("playing");
    setFinalRanking([]);
    spawnWeaponPickups(spawnPositions);
  }, [spawnWeaponPickups]);

  const value = {
    gamePhase,
    setGamePhase,
    countdown,
    startMatch,
    weaponPickups,
    setWeaponPickups,
    takePickup,
    spawnWeaponPickups,
    checkWinCondition,
    restartRound,
    finalRanking,
  };

  return (
    <GameManagerContext.Provider value={value}>
      {children}
    </GameManagerContext.Provider>
  );
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function useGameManager() {
  const ctx = useContext(GameManagerContext);
  if (!ctx) throw new Error("useGameManager must be used within GameManagerProvider");
  return ctx;
}
