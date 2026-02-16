import { usePlayersList } from "playroomkit";
import { useGameManager } from "./GameManager";
import { useState, useEffect } from "react";
import { WEAPON_LABELS } from "../constants/weapons";

function formatSeconds(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function RightPanel() {
  const allPlayers = usePlayersList(true);
  const { gamePhase, matchStartTimeRef, selectedBotId, setSelectedBotId } = useGameManager();
  const [elapsedTick, setElapsedTick] = useState(0);

  const bots = allPlayers.filter((p) => p.state?.isBot?.() ?? p.isBot?.() ?? false);

  const aliveCount = bots.filter((p) => {
    const state = p.state;
    const eliminated = state?.getState?.("eliminated") ?? state?.eliminated;
    const lives = state?.getState?.("lives") ?? state?.lives ?? 3;
    const dead = state?.getState?.("dead") ?? state?.dead;
    return !eliminated && lives > 0 && !dead;
  }).length;

  const getSurvivalSeconds = (p) => {
    const state = p.state;
    if (!state) return 0;
    const accumulated = state.getState?.("survivalTime") ?? state.survivalTime ?? 0;
    const aliveSince = state.getState?.("aliveSince") ?? state.aliveSince ?? Date.now();
    const lives = state.getState?.("lives") ?? state.lives ?? 0;
    const eliminated = state.getState?.("eliminated") ?? state.eliminated;
    const dead = state.getState?.("dead") ?? state.dead;
    if (lives > 0 && !eliminated && !dead) {
      return accumulated + (Date.now() - aliveSince) / 1000;
    }
    return accumulated;
  };

  const leaderboardEntries = [...bots]
    .map((p) => {
      const state = p.state;
      return {
        player: p,
        name: state?.getProfile?.()?.name ?? state?.profile?.name ?? state?.getState?.("profile")?.name ?? p.id,
        survivalSeconds: getSurvivalSeconds(p),
        kills: state?.getState?.("kills") ?? state?.kills ?? 0,
        deaths: state?.getState?.("deaths") ?? state?.deaths ?? 0,
        lives: state?.getState?.("lives") ?? state?.lives ?? 3,
        weapon: state?.getState?.("weapon") ?? state?.weapon ?? "knife",
        ammo: state?.getState?.("ammo") ?? state?.ammo ?? null,
        eliminated: state?.getState?.("eliminated") ?? state?.eliminated,
        color: state?.getProfile?.()?.color?.hexString ?? state?.profile?.color ?? "#888",
      };
    })
    .sort((a, b) => b.survivalSeconds - a.survivalSeconds);

  useEffect(() => {
    if (gamePhase !== "playing") return;
    const id = setInterval(() => setElapsedTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [gamePhase]);

  const matchElapsed =
    gamePhase === "playing" && matchStartTimeRef?.current
      ? (Date.now() - matchStartTimeRef.current) / 1000
      : null;

  const phaseClass =
    gamePhase === "lobby"
      ? "match-phase phase-lobby"
      : gamePhase === "playing"
        ? "match-phase phase-active"
        : "match-phase phase-finished";
  const phaseLabel = gamePhase === "lobby" ? "Waiting" : gamePhase === "playing" ? "In Progress" : "Finished";

  return (
    <aside className="w-full md:w-80 lg:w-96 flex flex-col z-20 gap-4 flex-shrink-0 order-3">
      {/* Status Widget */}
      <div className="neo-card p-4 md:p-5">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-black uppercase text-slate-400 tracking-wider">Status</h3>
          <span className={phaseClass}>{phaseLabel}</span>
        </div>
        <div className="flex items-center justify-between bg-slate-900 p-3 border-2 border-white">
          <div className="text-2xl md:text-3xl neo-font text-white tabular-nums">
            {matchElapsed != null ? formatSeconds(matchElapsed) : "--:--"}
          </div>
          <div className="text-right">
            <div className="text-xs font-bold text-slate-400 uppercase">Players</div>
            <div className="text-2xl font-black text-[#d946ef]">
              {aliveCount} / {bots.length}
            </div>
          </div>
        </div>
      </div>

      {/* Leaderboard Widget */}
      <div className="neo-card flex-1 flex flex-col overflow-hidden min-h-[250px] md:min-h-0">
        <div className="p-4 border-b-2 border-white bg-[#a3e635]">
          <h3 className="text-sm font-black uppercase text-black flex items-center gap-2">
            <svg className="w-4 h-4 text-black" fill="currentColor" viewBox="0 0 24 24">
              <path d="M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V19H7v2h10v-2h-4v-3.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z" />
            </svg>
            Leaderboard
          </h3>
        </div>
        <div className="flex-1 overflow-y-auto p-3 custom-scrollbar">
          <div className="text-[10px] font-bold text-slate-500 mb-2 px-0.5">Click a row to follow that bot</div>
          {leaderboardEntries.length === 0 ? (
            <p className="text-xs text-slate-500 text-center py-4">No agents yet</p>
          ) : (
            <div className="space-y-2">
              {leaderboardEntries.map((entry, i) => {
                const weaponLabel = WEAPON_LABELS[entry.weapon] || entry.weapon;
                const weaponAmmo = entry.weapon !== "knife" && entry.ammo != null ? ` (${entry.ammo})` : "";
                const isSelected = selectedBotId === entry.player.id;
                return (
                  <button
                    key={entry.player.id}
                    type="button"
                    onClick={() => setSelectedBotId(isSelected ? null : entry.player.id)}
                    className={`w-full text-left rounded-lg px-2 py-2 border-2 transition cursor-pointer select-none ${
                      entry.eliminated ? "opacity-50 bg-slate-800/60 border-slate-600" : "bg-slate-800/80 border-white/20 hover:border-white/40"
                    } ${isSelected ? "ring-2 ring-[#22d3ee] ring-offset-1 border-[#22d3ee]" : ""}`}
                  >
                    <div className="flex justify-between items-center gap-2">
                      <span className="font-bold text-white truncate flex items-center gap-1.5">
                        <span className="text-slate-500 w-5 flex-shrink-0">#{i + 1}</span>
                        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: entry.color }} />
                        {entry.name}
                      </span>
                      <span className="text-[#a3e635] font-mono tabular-nums text-xs whitespace-nowrap flex-shrink-0">
                        {formatSeconds(entry.survivalSeconds)}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-[10px] text-slate-400">
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
        <div className="p-3 bg-slate-900 text-white border-t-2 border-white flex flex-col gap-1 text-xs font-bold uppercase font-mono">
          <div className="text-slate-400">Ranked by survival time</div>
        </div>
      </div>

      {/* Hall of Fame Widget */}
      <div className="neo-card flex-1 flex flex-col overflow-hidden min-h-[250px] md:min-h-0">
        <div className="p-4 border-b-2 border-white bg-[#facc15]">
          <h3 className="text-sm font-black uppercase text-black flex items-center gap-2">
            <svg className="w-4 h-4 text-black" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2l2.4 7.4h7.6l-6 4.6 2.3 7-6.3-4.6L5.7 21l2.3-7-6-4.6h7.6L12 2z" />
            </svg>
            Hall of Fame
          </h3>
        </div>
        <div className="flex-1 overflow-y-auto p-3 custom-scrollbar">
          <div className="flex justify-between items-center text-[10px] font-bold text-slate-500 mb-2 px-0.5">
            <span>Agent</span>
            <span>Wins / Matches</span>
          </div>
          <p className="text-xs text-slate-500 text-center py-6">Global stats coming soon</p>
        </div>
        <div className="p-3 bg-slate-900 text-white border-t-2 border-white flex flex-col gap-1 text-sm font-bold uppercase font-mono">
          <div className="flex justify-between">
            <span className="text-slate-400">Bots</span>
            <span id="bot-count" className="text-[#a3e635]">{bots.length}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Total games</span>
            <span id="total-games" className="text-[#a3e635]">—</span>
          </div>
        </div>
      </div>
    </aside>
  );
}
