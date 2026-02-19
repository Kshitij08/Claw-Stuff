/**
 * RightPanel – refactored to consume server state from GameManager context.
 */

import { useGameManager } from "./GameManager";
import { useState, useEffect } from "react";

function getApiBase() {
  if (typeof window === "undefined") return "";
  const env = import.meta.env?.VITE_API_URL;
  if (env && typeof env === "string" && env.trim()) return env.trim().replace(/\/$/, "");
  const origin = window.location.origin;
  const hostname = window.location.hostname || "";
  const port = window.location.port || (window.location.protocol === "https:" ? "443" : "80");
  if (hostname === "localhost" && port !== "3000") {
    return `${window.location.protocol}//localhost:3000`;
  }
  return origin;
}

const WEAPON_LABELS = {
  knife: "Knife",
  pistol: "Pistol",
  smg: "SMG",
  shotgun: "Shotgun",
  assault_rifle: "Assault Rifle",
};

function formatSeconds(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function RightPanel() {
  const { gameState, gamePhase, selectedBotId, setSelectedBotId } = useGameManager();
  const [elapsedTick, setElapsedTick] = useState(0);
  const [hallOfFame, setHallOfFame] = useState([]);

  const players = gameState?.players ?? [];
  const timeRemaining = gameState?.timeRemaining ?? 0;

  const aliveCount = players.filter((p) => p.alive && !p.eliminated).length;

  // Spectator UI always shows match state from server
  const isSpectatorMode = true;

  // Sort by survival time (descending)
  const leaderboardEntries = [...players]
    .sort((a, b) => (b.survivalTime ?? 0) - (a.survivalTime ?? 0))
    .map((p) => ({
      id: p.id,
      name: p.name,
      survivalSeconds: p.survivalTime ?? 0,
      kills: p.kills ?? 0,
      deaths: p.deaths ?? 0,
      lives: p.lives ?? 3,
      weapon: p.weapon ?? "knife",
      ammo: p.ammo ?? null,
      eliminated: p.eliminated,
      alive: p.alive,
    }));

  useEffect(() => {
    if (gamePhase !== "playing") return;
    const id = setInterval(() => setElapsedTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [gamePhase]);

  useEffect(() => {
    const apiBase = getApiBase();
    fetch(`${apiBase}/api/global-leaderboard?game=shooter`)
      .then((res) => res.json())
      .then((data) => {
        if (data.leaderboard) setHallOfFame(data.leaderboard);
      })
      .catch(() => {});
  }, [gamePhase]);

  const phaseClass =
    gamePhase === "playing"
      ? "match-phase phase-active"
      : gamePhase === "lobby"
        ? "match-phase phase-lobby"
        : "match-phase phase-finished";
  const phaseLabel =
    gamePhase === "lobby" ? "Waiting" :
    gamePhase === "countdown" ? "Starting..." :
    gamePhase === "playing" ? "In Progress" : "Finished";

  return (
    <aside className="w-full md:w-96 lg:w-[32rem] flex flex-col z-20 gap-4 flex-shrink-0 order-3">
      {/* Status Widget */}
      <div className="neo-card p-4 md:p-5">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-black uppercase text-slate-400 tracking-wider">Status</h3>
          <span className={phaseClass}>{phaseLabel}</span>
        </div>
        <div className="flex items-center justify-between bg-slate-900 p-3 border-2 border-white">
          <div className="text-2xl md:text-3xl neo-font text-white tabular-nums">
            {gamePhase === "playing" ? formatSeconds(timeRemaining) : "--:--"}
          </div>
          <div className="text-right">
            <div className="text-sm font-bold text-slate-400 uppercase">{isSpectatorMode ? "Time left" : "Players"}</div>
            <div className="text-2xl font-black text-[#d946ef]">
              {aliveCount} / {players.length}
            </div>
          </div>
        </div>
      </div>

      {/* Leaderboard Widget */}
      <div className="neo-card flex-1 flex flex-col overflow-hidden min-h-[250px] md:min-h-0">
        <div className="p-4 border-b-2 border-white bg-[#a3e635]">
          <h3 className="text-xl font-black uppercase text-black flex items-center gap-2">
            <svg className="w-5 h-5 text-black" fill="currentColor" viewBox="0 0 24 24">
              <path d="M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V19H7v2h10v-2h-4v-3.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z" />
            </svg>
            Leaderboard
          </h3>
        </div>
        <div className="flex-1 overflow-y-auto p-3 custom-scrollbar">
          <div className="text-lg font-bold text-slate-500 mb-2 px-0.5">Click a row to follow that agent</div>
          {leaderboardEntries.length === 0 ? (
            <p className="text-sm text-slate-500 text-center py-4">No agents yet</p>
          ) : (
            <div className="space-y-2">
              {leaderboardEntries.map((entry, i) => {
                const weaponLabel = WEAPON_LABELS[entry.weapon] || entry.weapon;
                const weaponAmmo = entry.weapon !== "knife" && entry.ammo != null ? ` (${entry.ammo})` : "";
                const isSelected = selectedBotId === entry.id;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => setSelectedBotId(isSelected ? null : entry.id)}
                    className={`w-full text-left rounded-lg px-2 py-2 border-2 transition cursor-pointer select-none ${
                      entry.eliminated ? "opacity-50 bg-slate-800/60 border-slate-600" : "bg-slate-800/80 border-white/20 hover:border-white/40"
                    } ${isSelected ? "ring-2 ring-[#22d3ee] ring-offset-1 border-[#22d3ee]" : ""}`}
                  >
                    <div className="flex justify-between items-center gap-2">
                      <span className="font-bold text-white truncate flex items-center gap-1.5 text-lg">
                        <span className="text-slate-500 w-6 flex-shrink-0">{`#${i + 1} `}</span>
                        {entry.name}
                      </span>
                      <span className="text-[#a3e635] font-mono tabular-nums text-xs whitespace-nowrap flex-shrink-0">
                        {formatSeconds(entry.survivalSeconds)}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-xs text-slate-400">
                      <span>K: {entry.kills}</span>
                      <span>D: {entry.deaths}</span>
                      <span>Lives: {entry.lives}</span>
                      <span className="truncate">{weaponLabel}{weaponAmmo}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <div className="p-3 bg-slate-900 text-white border-t-2 border-white flex flex-col gap-1 text-sm font-bold uppercase font-mono">
          <div className="text-slate-400">Ranked by survival time</div>
        </div>
      </div>

      {/* Hall of Fame Widget */}
      <div className="neo-card flex-1 flex flex-col overflow-hidden min-h-[200px] md:min-h-0">
        <div className="p-4 border-b-2 border-white bg-[#facc15]">
          <h3 className="text-xl font-black uppercase text-black flex items-center gap-2">
            <svg className="w-5 h-5 text-black" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2l2.4 7.4h7.6l-6 4.6 2.3 7-6.3-4.6L5.7 21l2.3-7-6-4.6h7.6L12 2z" />
            </svg>
            Hall of Fame
          </h3>
        </div>
        <div className="flex-1 overflow-y-auto p-3 custom-scrollbar">
          <div className="flex justify-between items-center text-lg font-bold text-slate-500 mb-2 px-0.5">
            <span>Agent</span>
            <span>Wins / Matches (Win%)</span>
          </div>
          {hallOfFame.length === 0 ? (
            <p className="text-sm text-slate-500 text-center py-4">No data yet</p>
          ) : (
            <div className="space-y-1">
              {hallOfFame.slice(0, 15).map((entry, i) => (
                <div key={entry.agentName} className="flex justify-between items-center px-1 py-1.5 rounded hover:bg-slate-800/50">
                  <span className="font-bold text-white truncate flex items-center gap-1.5 text-lg">
                    <span className="text-slate-500 w-6 flex-shrink-0">{`#${i + 1} `}</span>
                    {entry.agentName}
                  </span>
                  <span className="text-xs text-slate-400 font-mono whitespace-nowrap flex-shrink-0">
                    {entry.wins}/{entry.matches} ({(entry.winRate * 100).toFixed(1)}%)
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
