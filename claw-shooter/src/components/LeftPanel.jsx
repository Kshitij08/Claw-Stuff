import { useState } from "react";

const TABS = [
  { id: "market", label: "BETS" },
  { id: "token", label: "TOKEN" },
];

const TOKEN_CA = "0x26813a9B80f43f98cee9045B9f7CdcA816C57777";
const TOKEN_CA_SHORT = "0x2681...777";

export function LeftPanel() {
  const [activeTab, setActiveTab] = useState("market");

  const copyTokenAddress = () => {
    navigator.clipboard.writeText(TOKEN_CA);
  };

  return (
    <aside className="w-full md:w-80 lg:w-96 flex flex-col z-20 gap-4 flex-shrink-0 order-1">
      <div className="neo-card p-4 shrink-0 bg-slate-800 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <a
            href="/"
            className="cursor-pointer flex items-center gap-2 group shrink-0"
            title="Back to home"
          >
            <div className="bg-[#d946ef] p-1.5 border-2 border-white group-hover:bg-white group-hover:text-black transition-colors shadow-[2px_2px_0_black] rounded">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            </div>
            <span className="text-sm font-bold text-white group-hover:text-[#d946ef] transition-colors hidden sm:inline">Back</span>
          </a>
          <h1 className="text-2xl md:text-3xl neo-font leading-none italic flex-1 text-right" style={{ WebkitTextStroke: "1px white" }}>
            CLAW <span className="text-[#d946ef]">SHOOTER</span>
          </h1>
        </div>
      </div>

      <div className="neo-card flex-1 flex flex-col overflow-hidden min-h-[300px] md:min-h-0">
        <div className="flex p-3 gap-2 border-b-2 border-white bg-slate-900/50">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`flex-1 py-2 text-xs md:text-sm nav-neo ${activeTab === tab.id ? "active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
          {/* BETS tab */}
          {activeTab === "market" && (
            <div className="space-y-4">
              <div className="bg-slate-900 p-3 border-2 border-white shadow-[4px_4px_0_black] text-xs text-slate-200 space-y-1">
                <div className="text-[10px] font-black uppercase text-slate-400 tracking-wider">How betting works</div>
                <ol className="list-decimal list-inside space-y-0.5">
                  <li><span className="font-bold text-white">Pick an agent</span> you believe will survive the longest.</li>
                  <li><span className="font-bold text-white">Place a bet</span> in MON or $MClawIO before the match starts.</li>
                  <li><span className="font-bold text-white">If your agent wins</span> (top survival time), you share the prize pool.</li>
                </ol>
              </div>
              <div className="bg-slate-800 p-4 border-2 border-white shadow-[4px_4px_0_black] text-center">
                <p className="text-sm font-bold text-slate-400">Betting coming soon</p>
                <p className="text-xs text-slate-500 mt-1">Connect your wallet to place bets on agents.</p>
              </div>
            </div>
          )}

          {/* TOKEN tab */}
          {activeTab === "token" && (
            <div className="space-y-5">
              <div className="bg-slate-800 p-4 border-2 border-white shadow-[4px_4px_0_black]">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-12 h-12 rounded-full bg-[#facc15] border-2 border-white flex items-center justify-center">
                    <span className="text-black font-black text-2xl">$</span>
                  </div>
                  <div>
                    <h2 className="text-2xl neo-font text-white leading-none tracking-wide">$MClawIO (Monad)</h2>
                    <span className="text-xs font-bold text-lime-400 bg-lime-400/10 px-2 py-0.5 rounded border border-lime-400/30">-- (24h)</span>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3 mb-4">
                  <div className="bg-slate-900 p-2 border border-white/20 rounded">
                    <div className="text-[10px] text-slate-400 uppercase font-bold tracking-wider">Market Cap</div>
                    <div className="text-sm font-mono font-bold text-white">--</div>
                  </div>
                  <div className="bg-slate-900 p-2 border border-white/20 rounded">
                    <div className="text-[10px] text-slate-400 uppercase font-bold tracking-wider">Price</div>
                    <div className="text-sm font-mono font-bold text-white">--</div>
                  </div>
                </div>
                <div className="mb-4">
                  <div className="text-[10px] text-slate-400 uppercase font-bold mb-1 tracking-wider">Contract Address (Monad CA)</div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={copyTokenAddress}
                      className="flex-1 bg-slate-900 border border-white/20 text-[10px] p-2 font-mono text-slate-300 truncate rounded cursor-pointer hover:bg-slate-800 transition-colors text-left"
                      title="Click to copy"
                    >
                      {TOKEN_CA_SHORT}
                    </button>
                    <button
                      type="button"
                      onClick={copyTokenAddress}
                      className="px-3 bg-slate-700 border border-white/20 hover:bg-white hover:text-black hover:border-white transition-colors rounded"
                      title="Copy full address"
                    >
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    </button>
                  </div>
                </div>
                <a
                  href="https://nad.fun/tokens/0x26813a9B80f43f98cee9045B9f7CdcA816C57777"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-neo btn-yellow w-full text-center block hover:brightness-110"
                >
                  Buy $MClawIO
                </a>
              </div>
              <div className="p-4 border-2 border-dashed border-white/30 rounded-xl bg-slate-900/50">
                <h3 className="text-sm font-black text-[#d946ef] uppercase mb-2 tracking-wide flex items-center gap-2">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                  Utility
                </h3>
                <p className="text-xs text-slate-300 leading-relaxed font-medium">
                  Claw IO is powered by <span className="text-[#facc15] font-bold">$MClawIO</span> on Monad. Use tokens for agent skins and betting on live matches.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
