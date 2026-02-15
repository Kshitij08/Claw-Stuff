import { usePlayersList } from "playroomkit";
import { useGameManager } from "./GameManager";

export const Leaderboard = () => {
  const allPlayers = usePlayersList(true);
  const { gamePhase, finalRanking, countdown, startMatch } = useGameManager();

  /* Only show bots in the leaderboard – the local spectator/host is not a participant */
  const players = allPlayers.filter(
    (p) => p.state?.isBot?.() ?? p.isBot?.() ?? false
  );

  const aliveCount = players.filter((p) => {
    const state = p.state;
    const eliminated = state?.getState?.("eliminated") ?? state?.eliminated;
    const lives = state?.getState?.("lives") ?? state?.lives ?? 3;
    const dead = state?.getState?.("dead") ?? state?.dead;
    return !eliminated && lives > 0 && !dead;
  }).length;

  return (
    <>
      {/* Lobby: Start Match button */}
      {gamePhase === "lobby" && (
        <div className="fixed inset-0 z-20 flex flex-col items-center justify-center bg-black/70 backdrop-blur-sm">
          <h1 className="text-3xl font-bold text-white mb-8">Claw Shooter</h1>
          <button
            className="px-10 py-4 bg-green-500 hover:bg-green-400 text-white text-xl font-bold rounded-xl shadow-lg transition transform hover:scale-105"
            onClick={startMatch}
          >
            Start Match
          </button>
        </div>
      )}

      {/* Countdown overlay */}
      {gamePhase === "countdown" && countdown > 0 && (
        <div className="fixed inset-0 z-30 flex items-center justify-center pointer-events-none">
          <span className="text-white text-8xl font-black drop-shadow-lg animate-pulse">
            {countdown}
          </span>
        </div>
      )}

      {/* Playing: top bar with player stats */}
      {gamePhase === "playing" && (
        <div className="fixed top-0 left-0 right-0 p-4 flex z-10 gap-4 flex-wrap">
          <div className="bg-white/70 backdrop-blur-sm rounded-lg px-3 py-2 font-bold text-sm">
            Alive: {aliveCount} / {players.length}
          </div>
          {players.map((player) => {
            const state = player.state;
            const name =
              state?.getProfile?.()?.name ??
              state?.profile?.name ??
              state?.getState?.("profile")?.name ??
              player.id;
            const kills = state?.getState?.("kills") ?? state?.kills ?? 0;
            const deaths = state?.getState?.("deaths") ?? state?.deaths ?? 0;
            const lives = state?.getState?.("lives") ?? state?.lives ?? 3;
            const eliminated =
              state?.getState?.("eliminated") ?? state?.eliminated;
            const color =
              state?.getProfile?.()?.color?.hexString ??
              state?.profile?.color ??
              "#888";
            return (
              <div
                key={player.id}
                className={`bg-white/60 backdrop-blur-sm flex items-center rounded-lg gap-2 p-2 min-w-[120px] ${eliminated ? "opacity-50" : ""}`}
              >
                <div
                  className="w-8 h-8 rounded-full border-2 flex-shrink-0"
                  style={{ borderColor: color, backgroundColor: color }}
                />
                <div className="flex-grow min-w-0">
                  <h2 className="font-bold text-xs truncate">{name}</h2>
                  <div className="flex text-xs gap-2">
                    <span>K:{kills}</span>
                    <span>D:{deaths}</span>
                    <span>L:{lives}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* End screen */}
      {gamePhase === "ended" && finalRanking.length > 0 && (
        <div className="fixed inset-0 z-20 flex flex-col items-center justify-center bg-black/80 backdrop-blur-sm p-6">
          <h1 className="text-2xl font-bold text-white mb-6">
            Battle Royale Results
          </h1>
          <div className="bg-white/10 rounded-xl p-6 max-w-md w-full space-y-2 max-h-[70vh] overflow-y-auto">
            {finalRanking.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center justify-between gap-4 py-2 border-b border-white/20"
              >
                <span className="text-white font-mono w-8">
                  #{entry.rank}
                </span>
                <span className="text-white font-semibold flex-1 truncate">
                  {entry.name}
                </span>
                <span className="text-yellow-400">Kills: {entry.kills}</span>
                <span className="text-gray-400">Deaths: {entry.deaths}</span>
                <span className="text-sm text-gray-500">
                  {entry.personality}
                </span>
              </div>
            ))}
          </div>
          <button
            className="mt-8 px-8 py-3 bg-white text-black font-bold rounded-lg hover:bg-gray-200 transition"
            onClick={() => window.location.reload()}
          >
            Watch Again
          </button>
        </div>
      )}

      <button
        className="fixed top-4 right-4 z-10 text-white p-2 rounded bg-black/40 hover:bg-black/60"
        onClick={(e) => {
          if (document.fullscreenElement) {
            document.exitFullscreen();
          } else {
            document.documentElement.requestFullscreen();
          }
          e.currentTarget.blur();
        }}
        title="Toggle fullscreen"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
          className="w-6 h-6"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15"
          />
        </svg>
      </button>
    </>
  );
};
