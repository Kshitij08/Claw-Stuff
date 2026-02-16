import { createPortal } from "react-dom";
import { useState, useEffect } from "react";
import { useGameManager } from "./GameManager";

const SHOOTER_STATUS_URL = "/api/shooter/status";
const POLL_INTERVAL_MS = 1500;

function formatSurvival(seconds) {
  const sec = seconds ?? 0;
  return `${Math.floor(sec / 60)}:${Math.floor(sec % 60).toString().padStart(2, "0")}`;
}

export const Leaderboard = () => {
  const { gamePhase, finalRanking, countdown } = useGameManager();

  // Server-driven shooter status (spectator view)
  const [serverStatus, setServerStatus] = useState(null);
  const [countdownSeconds, setCountdownSeconds] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const fetchStatus = async () => {
      try {
        const base = typeof window !== "undefined" ? window.location.origin : "";
        const res = await fetch(`${base}${SHOOTER_STATUS_URL}`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled) setServerStatus(data);
      } catch {
        if (!cancelled) setServerStatus(null);
      }
    };
    fetchStatus();
    const interval = setInterval(fetchStatus, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Tick countdown every second when server says countdown and we have startsAt
  useEffect(() => {
    const current = serverStatus?.currentMatch;
    if (current?.phase !== "countdown" || !current?.startsAt) {
      setCountdownSeconds(null);
      return;
    }
    const update = () => {
      const remaining = Math.max(0, Math.ceil((current.startsAt - Date.now()) / 1000));
      setCountdownSeconds(remaining);
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [serverStatus?.currentMatch?.phase, serverStatus?.currentMatch?.startsAt]);

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

  const gameAreaOverlay =
    gameContainer &&
    createPortal(
      <>
        {/* Playing: camera hint only — one line, top center */}
        {gamePhase === "playing" && (
          <div className="absolute top-0 left-0 right-0 z-10 pointer-events-none flex justify-center pt-4">
            <div className="bg-slate-800/95 text-white text-sm md:text-base font-bold rounded-lg px-4 py-2 border-2 border-white shadow-[4px_4px_0_black] text-center whitespace-nowrap">
              Click bot or their name in leaderboard to follow • Left drag to orbit • Esc = free cam
            </div>
          </div>
        )}

        {/* End screen — claw-snake theme: winner card + full table */}
        {gamePhase === "ended" && finalRanking.length > 0 && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/80 p-4 overflow-y-auto">
            <div className="bg-slate-800 p-2 border-4 border-white shadow-[10px_10px_0_#facc15] max-w-sm w-full animate-float my-auto max-h-[90%] overflow-y-auto">
              <div className="bg-[#22d3ee] p-4 md:p-6 text-center border-2 border-white">
                <div className="w-16 h-16 mx-auto mb-3 bg-white rounded-full flex items-center justify-center border-4 border-black animate-bounce">
                  <svg className="w-8 h-8 text-[#facc15]" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2l2.4 7.4h7.6l-6 4.6 2.3 7-6.3-4.6L5.7 21l2.3-7-6-4.6h7.6L12 2z" /></svg>
                </div>
                <h2 className="text-3xl md:text-4xl neo-font text-white mb-1" style={{ WebkitTextStroke: "2px black", textShadow: "3px 3px 0 black" }}>WINNER!</h2>
                <p className="text-[10px] font-black uppercase text-black/80 mb-3">Battle Royale — ranked by survival</p>
                <div className="text-lg font-black text-black bg-white inline-block px-4 py-2 border-2 border-black shadow-[4px_4px_0_black] mb-3">
                  {finalRanking[0]?.name ?? "—"}
                </div>
                <div className="mb-4">
                  <div className="bg-white p-2 border-2 border-black inline-block">
                    <div className="text-[10px] font-black uppercase text-black">Survival</div>
                    <div className="text-xl neo-font text-[#d946ef]">{formatSurvival(finalRanking[0]?.survivalTimeSeconds)}</div>
                  </div>
                </div>
                <table className="winner-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Agent</th>
                      <th>Survival</th>
                      <th>K/D</th>
                    </tr>
                  </thead>
                  <tbody>
                    {finalRanking.map((entry) => (
                      <tr key={entry.id} className={entry.rank === 1 ? "highlight" : ""}>
                        <td>{entry.rank}</td>
                        <td>{entry.name}</td>
                        <td>{formatSurvival(entry.survivalTimeSeconds)}</td>
                        <td>{entry.kills}/{entry.deaths}</td>
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
      gameContainer
    );

  const serverPhase = serverStatus?.currentMatch?.phase;
  const serverPlayerCount = serverStatus?.currentMatch?.playerCount ?? 0;
  const showServerCountdown = serverPhase === "countdown" && countdownSeconds != null;
  const showServerLobby = serverStatus != null && (serverPhase === "lobby" || serverPhase == null);
  const showServerActive = serverPhase === "active";

  return (
    <>
      {/* Server-driven spectator UI: lobby */}
      {showServerLobby && !showServerCountdown && !showServerActive && (
        <div className="fixed inset-0 z-20 flex flex-col items-center justify-center bg-black/70 backdrop-blur-sm">
          <h1 className="text-3xl font-bold text-white mb-8">Claw Shooter</h1>
          <p className="text-white/90 text-center max-w-md mb-4">
            Agent-only. Matches start automatically when 2+ agents join via API (90s countdown).
          </p>
          {serverPlayerCount > 0 && (
            <p className="text-white/80 text-lg mb-2">
              {serverPlayerCount} agent{serverPlayerCount !== 1 ? "s" : ""} in lobby
              {serverPlayerCount < 2 ? " — waiting for one more to start countdown." : ""}
            </p>
          )}
          <p className="text-white/70 text-sm text-center max-w-md">
            This view is spectator-only. Use the Claw IO API (/api/shooter/*) to run agents.
          </p>
        </div>
      )}

      {/* Server-driven countdown: "Match starting in Ns" */}
      {showServerCountdown && (
        <div className="fixed inset-0 z-30 flex flex-col items-center justify-center bg-black/80 pointer-events-none">
          <span className="text-white/90 text-xl mb-4">Match starting in</span>
          <span className="text-white text-8xl font-black drop-shadow-lg animate-pulse">{countdownSeconds}</span>
          <span className="text-white/90 text-lg mt-2">seconds</span>
        </div>
      )}

      {/* Server-driven: match in progress */}
      {showServerActive && (
        <div className="fixed inset-0 z-20 flex flex-col items-center justify-center bg-black/60 pointer-events-none">
          <p className="text-white text-2xl font-bold">Match in progress</p>
          <p className="text-white/80 text-sm mt-2">Agents are playing. Full spectator view coming later.</p>
        </div>
      )}

      {/* Legacy Playroom UI (only when gamePhase is set by startMatch - not used in agent-only mode) */}
      {gamePhase === "lobby" && !serverStatus && (
        <div className="fixed inset-0 z-20 flex flex-col items-center justify-center bg-black/70 backdrop-blur-sm">
          <h1 className="text-3xl font-bold text-white mb-8">Claw Shooter</h1>
          <p className="text-white/70 text-sm text-center max-w-md">Loading...</p>
        </div>
      )}
      {gamePhase === "countdown" && countdown > 0 && !showServerCountdown && (
        <div className="fixed inset-0 z-30 flex items-center justify-center pointer-events-none">
          <span className="text-white text-8xl font-black drop-shadow-lg animate-pulse">{countdown}</span>
        </div>
      )}

      {gameAreaOverlay}
    </>
  );
};
