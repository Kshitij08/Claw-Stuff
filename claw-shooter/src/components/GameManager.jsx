import { createContext, useContext, useState, useCallback, useRef, useEffect } from "react";
import { Vector3 } from "three";
import { GUN_TYPES, PLAYER_COUNT, MAP_BOUNDS, MIN_DISTANCE_GUN_FROM_PLAYER_SPAWN, MIN_DISTANCE_GUN_FROM_GUN } from "../constants/weapons";

const GameManagerContext = createContext(null);

export function GameManagerProvider({ children }) {
  const [gamePhase, setGamePhase] = useState("lobby"); // lobby -> countdown -> playing -> ended
  const [countdown, setCountdown] = useState(0);
  const [weaponPickups, setWeaponPickups] = useState([]);
  const [finalRanking, setFinalRanking] = useState([]);
  const countdownRef = useRef(null);
  const spawnPositionsRef = useRef([]);
  /** Set by Experience: () => array of {x,y,z} currently occupied by bots (alive, not dead) */
  const getOccupiedBotPositionsRef = useRef(null);
  /** Ref to current weapon pickups so addWeaponPickup can avoid spawning on top of them */
  const weaponPickupsRef = useRef([]);
  useEffect(() => {
    weaponPickupsRef.current = weaponPickups;
  }, [weaponPickups]);

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

  /** Spawn a single weapon pickup at a random position (e.g. dropped on bot death). */
  const addWeaponPickup = useCallback((weaponType) => {
    const minDistFromGun = MIN_DISTANCE_GUN_FROM_GUN;
    const existing = weaponPickupsRef.current.filter((p) => !p.taken);
    const dist = (a, b) => {
      const ax = a?.x ?? 0, az = a?.z ?? 0;
      const bx = b?.x ?? 0, bz = b?.z ?? 0;
      return Math.sqrt((ax - bx) ** 2 + (az - bz) ** 2);
    };
    let positions = spawnPositionsRef.current;
    if (positions && positions.length > 0) {
      positions = positions.filter((p) =>
        existing.every((e) => dist(p, e.position) >= minDistFromGun)
      );
    }
    let position;
    if (positions && positions.length > 0) {
      const pos = positions[Math.floor(Math.random() * positions.length)];
      position =
        pos instanceof Vector3 ? pos : new Vector3(pos.x, pos.y ?? 0, pos.z);
    } else {
      position = new Vector3(
        MAP_BOUNDS.minX + Math.random() * (MAP_BOUNDS.maxX - MAP_BOUNDS.minX),
        0,
        MAP_BOUNDS.minZ + Math.random() * (MAP_BOUNDS.maxZ - MAP_BOUNDS.minZ)
      );
    }
    setWeaponPickups((prev) => [
      ...prev,
      {
        id: `drop-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        weaponType,
        position,
        taken: false,
      },
    ]);
  }, []);

  const spawnWeaponPickups = useCallback((spawnPositions) => {
    if (!spawnPositions || spawnPositions.length === 0) return;
    spawnPositionsRef.current = spawnPositions;
    const occupied = getOccupiedBotPositionsRef.current?.() ?? [];
    const minDistFromBot = MIN_DISTANCE_GUN_FROM_PLAYER_SPAWN;
    const minDistFromGun = MIN_DISTANCE_GUN_FROM_GUN;
    let positions = spawnPositions.filter((sp) => {
      const sx = sp.x ?? 0, sz = sp.z ?? 0;
      const tooClose = occupied.some((o) => {
        const ox = o?.x ?? 0, oz = o?.z ?? 0;
        const dx = sx - ox, dz = sz - oz;
        return Math.sqrt(dx * dx + dz * dz) < minDistFromBot;
      });
      return !tooClose;
    });
    if (positions.length === 0) return;
    shuffle(positions);
    const pickups = [];
    const count = Math.min(PLAYER_COUNT, positions.length);
    const chosen = [];
    for (let i = 0; i < count; i++) {
      const cx = (x) => x?.x ?? 0;
      const cz = (x) => x?.z ?? 0;
      const dist = (a, b) => Math.sqrt((cx(a) - cx(b)) ** 2 + (cz(a) - cz(b)) ** 2);
      positions = positions.filter((p) => chosen.every((c) => dist(p, c) >= minDistFromGun));
      if (positions.length === 0) break;
      const pos = positions[0];
      chosen.push(pos);
      const weaponType = GUN_TYPES[i % GUN_TYPES.length];
      pickups.push({
        id: `pickup-${i}-${Date.now()}`,
        weaponType,
        position: pos instanceof Vector3 ? pos : new Vector3(pos.x, pos.y ?? 0, pos.z),
        taken: false,
      });
    }
    setWeaponPickups(pickups);
  }, []);

  const checkWinCondition = useCallback((players) => {
    if (gamePhase !== "playing") return;
    /* Game ends when at most one bot still has lives left (each bot starts with 3 lives) */
    const withLivesLeft = players.filter((p) => {
      const state = p.state;
      if (!state) return false;
      const lives = state.getState?.("lives") ?? state.lives ?? 3;
      return lives > 0;
    });
    if (withLivesLeft.length <= 1) {
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
    addWeaponPickup,
    spawnWeaponPickups,
    checkWinCondition,
    restartRound,
    finalRanking,
    getOccupiedBotPositionsRef,
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
