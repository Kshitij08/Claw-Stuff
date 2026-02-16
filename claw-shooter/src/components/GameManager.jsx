/**
 * GameManager – refactored to consume server state via Socket.IO.
 *
 * No local game logic: all state comes from the shooter server.
 * The context provides the latest spectator state, match end data,
 * betting state, and a selectedBotId for the follow camera.
 */

import { createContext, useContext, useState, useEffect, useRef, useCallback } from "react";
import { io } from "socket.io-client";

const GameManagerContext = createContext(null);

/** Resolve the Socket.IO server URL. In dev, connect to the Express server. */
function getServerUrl() {
  if (typeof window === "undefined") return "";
  return window.location.origin;
}

export function GameManagerProvider({ children }) {
  const [gameState, setGameState] = useState(null);
  const [matchStatus, setMatchStatus] = useState(null);
  const [matchEnd, setMatchEnd] = useState(null);
  const [shots, setShots] = useState([]);
  const [hits, setHits] = useState([]);
  const [selectedBotId, setSelectedBotId] = useState(null);
  const socketRef = useRef(null);
  const shotIdRef = useRef(0);
  const hitIdRef = useRef(0);

  // Betting state
  const [bettingStatus, setBettingStatus] = useState(null);
  const [currentMatchId, setCurrentMatchId] = useState(null);
  const [lastBetToast, setLastBetToast] = useState(null);
  const [bettingResolved, setBettingResolved] = useState(null);
  const [winningsDistributed, setWinningsDistributed] = useState(null);

  useEffect(() => {
    const url = getServerUrl();
    const socket = io(`${url}/shooter`, {
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 1000,
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      console.log("[ShooterClient] Connected to /shooter namespace");
    });

    socket.on("shooterState", (state) => {
      setGameState(state);
      setMatchEnd(null);
    });

    socket.on("shooterStatus", (status) => {
      setMatchStatus(status);
      if (status.currentMatch) {
        setCurrentMatchId(status.currentMatch.id);
      }
    });

    socket.on("shooterShot", (shot) => {
      const id = shotIdRef.current++;
      setShots((prev) => [...prev.slice(-12), { ...shot, _id: id }]);
    });

    socket.on("shooterHit", (hit) => {
      const id = hitIdRef.current++;
      setHits((prev) => [...prev.slice(-20), { ...hit, _id: id }]);
    });

    socket.on("shooterMatchEnd", (result) => {
      setMatchEnd(result);
    });

    socket.on("shooterLobbyOpen", (data) => {
      setMatchEnd(null);
      setGameState(null);
      setCurrentMatchId(data.matchId);
      setBettingStatus(null);
      setBettingResolved(null);
    });

    // ── Betting socket events ──────────────────────────────────────────
    socket.on("bettingPending", (data) => {
      setCurrentMatchId(data.matchId);
      if (data.agentNames && data.agentNames.length) {
        setBettingStatus({
          matchId: data.matchId,
          status: "pending",
          totalPool: "0",
          totalPoolMON: "0",
          agents: data.agentNames.map((name) => ({
            agentName: name,
            pool: "0",
            poolMON: "0",
            percentage: 0,
            multiplier: 0,
            bettorCount: 0,
          })),
          bettorCount: 0,
        });
      }
    });

    socket.on("bettingOpen", (data) => {
      setCurrentMatchId(data.matchId);
      if (data.agentNames && data.agentNames.length) {
        setBettingStatus({
          matchId: data.matchId,
          status: "open",
          totalPool: "0",
          totalPoolMON: "0",
          agents: data.agentNames.map((name) => ({
            agentName: name,
            pool: "0",
            poolMON: "0",
            percentage: 0,
            multiplier: 0,
            bettorCount: 0,
          })),
          bettorCount: 0,
        });
      }
    });

    socket.on("bettingAgentsUpdate", (data) => {
      setBettingStatus((prev) => {
        if (!prev || prev.matchId !== data.matchId) return prev;
        const existingNames = new Set(prev.agents.map((a) => a.agentName));
        const newAgents = (data.agentNames || [])
          .filter((n) => !existingNames.has(n))
          .map((name) => ({
            agentName: name,
            pool: "0",
            poolMON: "0",
            percentage: 0,
            multiplier: 0,
            bettorCount: 0,
          }));
        return { ...prev, agents: [...prev.agents, ...newAgents] };
      });
    });

    socket.on("bettingUpdate", (status) => {
      setBettingStatus(status);
    });

    socket.on("betPlaced", (data) => {
      setLastBetToast(data);
    });

    socket.on("bettingClosed", (data) => {
      setBettingStatus((prev) => {
        if (!prev || prev.matchId !== data.matchId) return prev;
        return { ...prev, status: "closed" };
      });
    });

    socket.on("bettingResolved", (data) => {
      setBettingResolved(data);
      setBettingStatus((prev) => {
        if (!prev || prev.matchId !== data.matchId) return prev;
        return { ...prev, status: "resolved" };
      });
    });

    socket.on("winningsDistributed", (data) => {
      setWinningsDistributed(data);
    });

    socket.on("disconnect", () => {
      console.log("[ShooterClient] Disconnected");
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  // Clean up old shots/hits quickly so trails don't persist
  useEffect(() => {
    if (shots.length === 0) return;
    const timer = setTimeout(() => {
      setShots((prev) => prev.slice(Math.max(0, prev.length - 4)));
    }, 200);
    return () => clearTimeout(timer);
  }, [shots.length]);

  useEffect(() => {
    if (hits.length === 0) return;
    const timer = setTimeout(() => {
      setHits((prev) => prev.slice(Math.max(0, prev.length - 5)));
    }, 800);
    return () => clearTimeout(timer);
  }, [hits.length]);

  // Derive phase from game state + match status
  const serverPhase = gameState?.phase || matchStatus?.currentMatch?.phase;
  const gamePhase = matchEnd
    ? "ended"
    : serverPhase === "active"
      ? "playing"
      : serverPhase === "countdown"
        ? "countdown"
        : "lobby";

  const value = {
    gameState,
    matchStatus,
    matchEnd,
    gamePhase,
    shots,
    hits,
    selectedBotId,
    setSelectedBotId,
    // Betting
    bettingStatus,
    setBettingStatus,
    currentMatchId,
    lastBetToast,
    bettingResolved,
    winningsDistributed,
    socketRef,
  };

  return (
    <GameManagerContext.Provider value={value}>
      {children}
    </GameManagerContext.Provider>
  );
}

export function useGameManager() {
  const ctx = useContext(GameManagerContext);
  if (!ctx) throw new Error("useGameManager must be used within GameManagerProvider");
  return ctx;
}
