/**
 * Leaderboard overlay – refactored to use server state.
 *
 * Shows lobby, countdown, camera hints during play, and end screen.
 */

import { createPortal } from "react-dom";
import { useState, useEffect } from "react";
import { useGameManager } from "./GameManager";

const BASE = import.meta.env.BASE_URL || "/";

function CountdownOverlay({ playerCount, startsAt }) {
  const [secondsLeft, setSecondsLeft] = useState(null);

  useEffect(() => {
    if (!startsAt) return;
    const update = () => {
      const remaining = Math.max(0, Math.ceil((startsAt - Date.now()) / 1000));
      setSecondsLeft(remaining);
    };
    update();
    const interval = setInterval(update, 500);
    return () => clearInterval(interval);
  }, [startsAt]);

  return (
    <div className="fixed inset-0 z-20 flex flex-col items-center justify-center bg-black/60 backdrop-blur-sm">
      <h1 className="text-3xl font-bold text-white mb-4">Claw Shooter</h1>
      {secondsLeft != null && secondsLeft > 0 ? (
        <p className="text-white text-4xl font-black animate-pulse">{secondsLeft}s</p>
      ) : (
        <p className="text-white text-xl animate-pulse">Starting...</p>
      )}
      <p className="text-white/50 text-sm mt-2">{playerCount} agents ready</p>
    </div>
  );
}

function formatSurvival(seconds) {
  const sec = seconds ?? 0;
  return `${Math.floor(sec / 60)}:${Math.floor(sec % 60).toString().padStart(2, "0")}`;
}

export const Leaderboard = () => {
  const { gamePhase, matchEnd, matchStatus } = useGameManager();

  const gameContainer = typeof document !== "undefined" ? document.getElementById("game-view-center") : null;

  const fullscreenButton = (
    <button
      className="absolute top-4 right-4 z-20 text-white p-2 rounded bg-black/40 hover:bg-black/60 border-2 border-white/50"
      onClick={(e) => {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen();
        e.currentTarget.blur();
      }}
      title="Toggle fullscreen"
    >
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
      </svg>
    </button>
  );

  const finalRanking = matchEnd?.finalRanking ?? [];

  const gameAreaOverlay =
    gameContainer &&
    createPortal(
      <>
        {/* Playing: camera hint */}
        {gamePhase === "playing" && (
          <div className="absolute top-0 left-0 right-0 z-10 pointer-events-none flex justify-center pt-4">
            <div className="bg-slate-800/95 text-white text-sm md:text-base font-bold rounded-lg px-4 py-2 border-2 border-white shadow-[4px_4px_0_black] text-center whitespace-nowrap">
              Click a bot (or name in leaderboard) to follow &bull; Left drag to orbit &bull; Esc = free cam
            </div>
          </div>
        )}

        {/* End screen */}
        {gamePhase === "ended" && finalRanking.length > 0 && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/80 p-4 overflow-y-auto">
            <div className="bg-slate-800 p-2 border-4 border-white shadow-[10px_10px_0_#facc15] max-w-sm w-full animate-float my-auto max-h-[90%] overflow-y-auto">
              <div className="bg-[#22d3ee] p-4 md:p-6 text-center border-2 border-white">
                <div className="w-20 h-20 mx-auto mb-3 bg-white rounded-full flex items-center justify-center border-4 border-black animate-bounce overflow-hidden">
                  {(finalRanking[0]?.character || finalRanking[0]?.id) ? (
                    <img
                      src={`${BASE}skins/${finalRanking[0].character || finalRanking[0].id || "G_1"}.png`}
                      alt={finalRanking[0]?.name ?? "Winner"}
                      className="w-full h-full object-contain"
                      onError={(e) => {
                        e.target.style.display = "none";
                        const fallback = e.target.parentElement.querySelector(".winner-trophy");
                        if (fallback) fallback.classList.remove("hidden");
                      }}
                    />
                  ) : null}
                  <svg className={`winner-trophy w-8 h-8 text-[#facc15] ${(finalRanking[0]?.character || finalRanking[0]?.id) ? "hidden" : ""}`} fill="currentColor" viewBox="0 0 24 24"><path d="M12 2l2.4 7.4h7.6l-6 4.6 2.3 7-6.3-4.6L5.7 21l2.3-7-6-4.6h7.6L12 2z" /></svg>
                </div>
                <h2 className="text-3xl md:text-4xl neo-font text-white mb-1" style={{ WebkitTextStroke: "2px black", textShadow: "3px 3px 0 black" }}>WINNER!</h2>
                <p className="text-[10px] font-black uppercase text-black/80 mb-3">Battle Royale — ranked by survival</p>
                <div className="text-lg font-black text-black bg-white inline-block px-4 py-2 border-2 border-black shadow-[4px_4px_0_black] mb-3">
                  {finalRanking[0]?.name ?? "—"}
                </div>
                <div className="mb-4">
                  <div className="bg-white p-2 border-2 border-black inline-block">
                    <div className="text-[10px] font-black uppercase text-black">Survival</div>
                    <div className="text-xl neo-font text-[#d946ef]">{formatSurvival(finalRanking[0]?.survivalTime)}</div>
                  </div>
                </div>
                <table className="winner-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Agent</th>
                      <th>Survival</th>
                      <th>K/D/KDA</th>
                    </tr>
                  </thead>
                  <tbody>
                    {finalRanking.map((entry) => (
                      <tr key={entry.rank} className={entry.rank === 1 ? "highlight" : ""}>
                        <td>{entry.rank}</td>
                        <td>{entry.name}</td>
                        <td>{formatSurvival(entry.survivalTime)}</td>
                        <td>{entry.kills}/{entry.deaths} ({entry.kills - entry.deaths >= 0 ? "+" : ""}{entry.kills - entry.deaths})</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button
                  className="mt-4 w-full btn-neo btn-cyan"
                  onClick={() => window.location.reload()}
                >
                  Watch Again
                </button>
              </div>
            </div>
          </div>
        )}

        {(gamePhase === "playing" || (gamePhase === "ended" && finalRanking.length > 0)) && fullscreenButton}
      </>,
      gameContainer,
    );

  const playerCount = matchStatus?.currentMatch?.playerCount ?? 0;

  return (
    <>
      {/* Lobby screen */}
      {gamePhase === "lobby" && (
        <div className="fixed inset-0 z-20 flex flex-col items-center justify-center bg-black/70 backdrop-blur-sm">
          <h1 className="text-3xl font-bold text-white mb-4">Claw Shooter</h1>
          <p className="text-white/70 text-lg mb-2">Waiting for agents to join...</p>
          <p className="text-white/50 text-sm">
            {playerCount} player{playerCount !== 1 ? "s" : ""} in lobby.
            Match starts when 2+ agents join.
          </p>
        </div>
      )}

      {/* Countdown screen */}
      {gamePhase === "countdown" && (
        <CountdownOverlay playerCount={playerCount} startsAt={matchStatus?.currentMatch?.startsAt} />
      )}

      {gameAreaOverlay}
    </>
  );
};
