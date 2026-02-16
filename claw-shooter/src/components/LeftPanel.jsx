import { useState, useEffect, useRef, useCallback } from "react";
import { useGameManager } from "./GameManager";
import { ethers } from "ethers";

const TABS = [
  { id: "market", label: "BETS" },
  { id: "token", label: "TOKEN" },
];

const BET_SUB_TABS = [
  { id: "agents", label: "Place Bet" },
  { id: "mybets", label: "My Bets" },
  { id: "leaders", label: "Leaderboard" },
  { id: "results", label: "Results" },
];

const TOKEN_CA = "0x26813a9B80f43f98cee9045B9f7CdcA816C57777";
const TOKEN_CA_SHORT = "0x2681...777";

const MONAD_MAINNET = {
  chainId: "0x8f",
  chainName: "Monad",
  rpcUrls: ["https://rpc.monad.xyz"],
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  blockExplorerUrls: ["https://monadvision.com"],
};

const TOKEN_META = {
  MON: { symbol: "MON" },
  MCLAW: { symbol: "MClawIO" },
};

const AGENT_COLORS = [
  "#d946ef", "#22d3ee", "#facc15", "#a3e635", "#f97316",
  "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6", "#f59e0b",
];

function shortenAddr(addr) {
  if (!addr) return "";
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

function weiToMON(wei) {
  try {
    const n = BigInt(wei);
    const whole = n / 1000000000000000000n;
    const frac = n % 1000000000000000000n;
    const fracStr = frac.toString().padStart(18, "0").slice(0, 4);
    return fracStr.replace(/0+$/, "")
      ? `${whole}.${fracStr.replace(/0+$/, "")}`
      : whole.toString();
  } catch {
    return "0";
  }
}

// ── Toast System ──────────────────────────────────────────────────────
function ToastContainer({ toasts, onDismiss }) {
  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => onDismiss(t.id)}
          className={`pointer-events-auto border-2 shadow-[3px_3px_0_black] px-4 py-3 flex items-start gap-2 cursor-pointer transition-opacity ${
            t.type === "success" ? "bg-[#a3e635] text-black border-white" :
            t.type === "error" ? "bg-red-500 text-white border-white" :
            t.type === "gold" ? "bg-[#facc15] text-black border-white" :
            t.type === "neutral" ? "bg-slate-700 text-white border-slate-500" :
            "bg-[#22d3ee] text-black border-white"
          }`}
        >
          <span className="text-xs font-bold flex-1">{t.message}</span>
        </div>
      ))}
    </div>
  );
}

export function LeftPanel() {
  const {
    bettingStatus,
    setBettingStatus,
    currentMatchId,
    lastBetToast,
    bettingResolved,
    winningsDistributed,
    socketRef,
    matchStatus,
  } = useGameManager();

  const [activeTab, setActiveTab] = useState("market");
  const [betSubTab, setBetSubTab] = useState("agents");
  const [currentBetToken, setCurrentBetToken] = useState("MON");

  // Wallet state
  const [walletAddress, setWalletAddress] = useState(null);
  const [walletBalance, setWalletBalance] = useState(null);
  const providerRef = useRef(null);
  const signerRef = useRef(null);
  const contractRef = useRef(null);
  const [contractAddress, setContractAddress] = useState("");

  // Bet inputs keyed by agentName
  const [betInputs, setBetInputs] = useState({});

  // My bets & leaderboard & results data
  const [myBets, setMyBets] = useState(null);
  const [leaderboard, setLeaderboard] = useState(null);
  const [resultsData, setResultsData] = useState(null);

  // Toast state
  const [toasts, setToasts] = useState([]);
  const toastIdRef = useRef(0);

  const showToast = useCallback((message, type = "info") => {
    const id = toastIdRef.current++;
    setToasts((prev) => [...prev.slice(-2), { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  }, []);

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // React to bet toast events from context
  useEffect(() => {
    if (!lastBetToast) return;
    if (walletAddress && lastBetToast.bettorAddress === walletAddress.toLowerCase()) return;
    const name = lastBetToast.bettorName || shortenAddr(lastBetToast.bettorAddress);
    const tokenMeta = TOKEN_META[lastBetToast.token || "MON"] || TOKEN_META.MON;
    showToast(`${name} bet ${lastBetToast.amountMON} ${tokenMeta.symbol} on ${lastBetToast.agentName}`, "neutral");
  }, [lastBetToast, walletAddress, showToast]);

  // React to betting resolved
  useEffect(() => {
    if (!bettingResolved) return;
    const monPool = bettingResolved.totalPoolMON || "0";
    const parts = [];
    if (parseFloat(monPool) > 0) parts.push(`${monPool} MON`);
    const poolStr = parts.length ? parts.join(", ") : "0";
    const msg = bettingResolved.isDraw
      ? `Draw! ${bettingResolved.winners.join(" & ")} tied. Pool: ${poolStr}`
      : `${bettingResolved.winners[0]} wins! Pool: ${poolStr}`;
    showToast(msg, "success");
  }, [bettingResolved, showToast]);

  // React to winnings distributed
  useEffect(() => {
    if (!winningsDistributed) return;
    if (walletAddress && winningsDistributed.bettorAddress === walletAddress.toLowerCase()) {
      const tokenMeta = TOKEN_META[winningsDistributed.token || "MON"] || TOKEN_META.MON;
      showToast(`You won ${winningsDistributed.payoutMON} ${tokenMeta.symbol}! Auto-sent to your wallet.`, "success");
      refreshBalance();
    }
  }, [winningsDistributed, walletAddress, showToast]);

  // Fetch betting status from API when matchId or token changes
  useEffect(() => {
    if (!currentMatchId) return;
    fetchBettingStatus(currentMatchId);
  }, [currentMatchId, currentBetToken]);

  async function fetchBettingStatus(matchId) {
    try {
      const res = await fetch(`/api/betting/status/${matchId}?token=${encodeURIComponent(currentBetToken)}`);
      const data = await res.json();
      setBettingStatus(data);
    } catch (err) {
      console.error("Failed to fetch betting status:", err);
    }
  }

  // ── Wallet ──────────────────────────────────────────────────────────

  // Ensure we have a live signer + contract ready (lazy — called before
  // any on-chain action like placing a bet). This is the ONLY place that
  // may trigger a MetaMask popup (chain switch / account request).
  async function ensureSignerReady() {
    if (signerRef.current && contractRef.current) return true;
    if (!window.ethereum) return false;
    try {
      // Make sure we're on Monad
      try {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: MONAD_MAINNET.chainId }],
        });
      } catch (switchErr) {
        if (switchErr.code === 4902) {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [MONAD_MAINNET],
          });
        }
      }
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const addr = await signer.getAddress();
      providerRef.current = provider;
      signerRef.current = signer;
      setWalletAddress(addr);
      try { localStorage.setItem("clawio_wallet_address", addr); } catch (_) {}
      await loadContractInfo(signer);
      refreshBalanceWith(provider, addr);
      return true;
    } catch (err) {
      console.warn("[ShooterBetting] ensureSignerReady failed:", err);
      return false;
    }
  }

  // Auto-connect on mount — ZERO popups. We do not touch window.ethereum at all.
  // Only read localStorage (set by Claw Snake when user connected there).
  // Any wallet API call (including eth_accounts) can trigger a popup in some wallets.
  useEffect(() => {
    if (walletAddress) return;
    try {
      const savedAddr = localStorage.getItem("clawio_wallet_address");
      if (savedAddr && typeof savedAddr === "string" && savedAddr.startsWith("0x")) {
        setWalletAddress(savedAddr);
        if (currentMatchId) fetchBettingStatus(currentMatchId);
      }
    } catch (_) {}
  }, []); // run once on mount

  // Manual connect (fallback if auto-connect didn't fire)
  async function connectWallet() {
    if (!window.ethereum) {
      showToast("No wallet detected. Install MetaMask.", "error");
      return;
    }
    try {
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      if (accounts && accounts.length > 0) {
        const addr = accounts[0];
        setWalletAddress(addr);
        try { localStorage.setItem("clawio_wallet_address", addr); } catch (_) {}
        await ensureSignerReady();
        showToast(`Wallet connected: ${shortenAddr(addr)}`, "success");
      }
    } catch (err) {
      console.error("Wallet connection failed:", err);
      showToast("Wallet connection failed: " + (err.message || err), "error");
    }
  }

  async function loadContractInfo(signer) {
    try {
      const res = await fetch("/api/betting/contract-info");
      const data = await res.json();
      setContractAddress(data.contractAddress || "");
      if (data.contractAddress && data.abi && signer) {
        contractRef.current = new ethers.Contract(data.contractAddress, data.abi, signer);
      }
    } catch (err) {
      console.error("Failed to load contract info:", err);
    }
  }

  function refreshBalance() {
    if (providerRef.current && walletAddress) {
      refreshBalanceWith(providerRef.current, walletAddress);
    }
  }

  async function refreshBalanceWith(provider, addr) {
    try {
      if (currentBetToken === "MON") {
        const bal = await provider.getBalance(addr);
        setWalletBalance(parseFloat(ethers.formatEther(bal)).toFixed(3));
      } else {
        const erc20Abi = ["function balanceOf(address owner) view returns (uint256)"];
        const mclaw = new ethers.Contract(TOKEN_CA, erc20Abi, provider);
        const bal = await mclaw.balanceOf(addr);
        setWalletBalance(parseFloat(ethers.formatUnits(bal, 18)).toFixed(3));
      }
    } catch {
      setWalletBalance(null);
    }
  }

  useEffect(() => {
    refreshBalance();
  }, [currentBetToken, walletAddress]);

  // ── Place Bet ──────────────────────────────────────────────────────
  async function placeBet(agentName) {
    if (!walletAddress) {
      showToast("Connect your wallet first", "error");
      return;
    }
    // Lazily set up signer + contract on first bet (this is the only
    // point where a chain-switch popup may appear — never on page load).
    if (!contractRef.current) {
      const ready = await ensureSignerReady();
      if (!ready || !contractRef.current) {
        showToast("Wallet setup failed. Try connecting manually.", "error");
        return;
      }
    }
    const amountTyped = betInputs[agentName];
    if (!amountTyped || parseFloat(amountTyped) <= 0) {
      showToast("Enter a valid bet amount", "error");
      return;
    }
    if (!currentMatchId) {
      showToast("No active match to bet on", "error");
      return;
    }
    if (bettingStatus && bettingStatus.status !== "open") {
      showToast("Betting is not open yet. Wait for OPEN status.", "error");
      return;
    }

    const tokenUsed = currentBetToken;
    const amountWei = ethers.parseEther(amountTyped);
    const tokenMeta = TOKEN_META[tokenUsed] || TOKEN_META.MON;

    try {
      showToast(`Placing bet of ${amountTyped} ${tokenMeta.symbol} on ${agentName}...`, "info");

      const matchIdB32 = ethers.encodeBytes32String(
        currentMatchId.length > 31 ? currentMatchId.slice(0, 31) : currentMatchId
      );
      const agentIdB32 = ethers.encodeBytes32String(
        agentName.length > 31 ? agentName.slice(0, 31) : agentName
      );

      let tx;
      if (tokenUsed === "MON") {
        tx = await contractRef.current.placeBet(matchIdB32, agentIdB32, { value: amountWei });
      } else {
        const erc20Abi = [
          "function allowance(address owner, address spender) view returns (uint256)",
          "function approve(address spender, uint256 amount) returns (bool)",
        ];
        const mclaw = new ethers.Contract(TOKEN_CA, erc20Abi, signerRef.current);
        const allowance = await mclaw.allowance(walletAddress, contractAddress);
        if (allowance < amountWei) {
          showToast(`Approving ${tokenMeta.symbol}...`, "info");
          const approveTx = await mclaw.approve(contractAddress, amountWei);
          await approveTx.wait();
        }
        tx = await contractRef.current.placeMclawBet(matchIdB32, agentIdB32, amountWei);
      }
      showToast("Transaction submitted. Waiting for confirmation...", "info");
      const receipt = await tx.wait();
      showToast(`You bet ${amountTyped} ${tokenMeta.symbol} on ${agentName}`, "success");

      // Notify backend
      if (socketRef.current) {
        socketRef.current.emit("humanBetPlaced", {
          matchId: currentMatchId,
          bettorAddress: walletAddress,
          agentName,
          amountWei: amountWei.toString(),
          token: tokenUsed,
          txHash: receipt.hash,
        });
      }

      setBetInputs((prev) => ({ ...prev, [agentName]: "" }));
      refreshBalance();
      if (currentMatchId) fetchBettingStatus(currentMatchId);
      if (betSubTab === "mybets") fetchMyBets();
    } catch (err) {
      console.error("Bet failed:", err);
      showToast("Bet failed: " + (err.reason || err.message || "Transaction failed"), "error");
    }
  }

  // ── My Bets ──────────────────────────────────────────────────────────
  async function fetchMyBets() {
    if (!walletAddress) return;
    try {
      const res = await fetch(`/api/betting/bets-by-wallet/${walletAddress}`);
      const data = await res.json();
      setMyBets(data);
    } catch (err) {
      console.error("Failed to fetch my bets:", err);
    }
  }

  useEffect(() => {
    if (betSubTab === "mybets" && walletAddress) fetchMyBets();
    if (betSubTab === "leaders") fetchLeaderboard();
    if (betSubTab === "results" && currentMatchId) fetchResults(currentMatchId);
  }, [betSubTab, walletAddress, currentMatchId]);

  // ── Leaderboard ──────────────────────────────────────────────────────
  async function fetchLeaderboard() {
    try {
      const res = await fetch(`/api/betting/leaderboard?token=${encodeURIComponent(currentBetToken)}`);
      const data = await res.json();
      setLeaderboard(data.leaderboard || []);
    } catch (err) {
      console.error("Failed to fetch leaderboard:", err);
    }
  }

  // ── Results ──────────────────────────────────────────────────────────
  async function fetchResults(matchId, depth = 0) {
    try {
      const res = await fetch(`/api/betting/history/${encodeURIComponent(matchId)}`);
      if (!res.ok) {
        if (depth < 5) {
          const prev = getPreviousShooterMatchId(matchId);
          if (prev) return fetchResults(prev, depth + 1);
        }
        setResultsData(null);
        return;
      }
      const data = await res.json();
      if (!data.bets?.length && depth < 5) {
        const prev = getPreviousShooterMatchId(matchId);
        if (prev) return fetchResults(prev, depth + 1);
      }
      setResultsData(data);
    } catch {
      setResultsData(null);
    }
  }

  function getPreviousShooterMatchId(matchId) {
    const m = /^shooter_(\d+)$/.exec(matchId);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    if (!Number.isFinite(n) || n <= 1) return null;
    return `shooter_${n - 1}`;
  }

  // Compute live payout estimate
  function getEstimatedPayout(agent, inputAmount) {
    if (!inputAmount || !bettingStatus) return null;
    const amount = parseFloat(inputAmount);
    if (isNaN(amount) || amount <= 0) return null;
    try {
      const totalPoolWei = BigInt(bettingStatus.totalPool || "0");
      const agentPoolWei = BigInt(agent.pool || "0");
      const newBetWei = ethers.parseEther(inputAmount);
      const newTotal = totalPoolWei + newBetWei;
      const newAgent = agentPoolWei + newBetWei;
      if (newTotal > 0n && newAgent > 0n) {
        const bettorShare = (newTotal * 9000n) / 10000n;
        const multiplier = Number(bettorShare * 1000n / newAgent) / 1000;
        return (amount * multiplier).toFixed(3);
      }
    } catch {}
    if (agent.multiplier > 0) return (amount * agent.multiplier).toFixed(3);
    return null;
  }

  const copyTokenAddress = () => navigator.clipboard.writeText(TOKEN_CA);

  const status = bettingStatus;
  const phaseLabels = { pending: "OPENING\u2026", open: "OPEN", closed: "LOCKED", resolved: "SETTLED", cancelled: "CANCELLED", none: "--" };
  const phaseLabel = phaseLabels[status?.status] || "--";
  const tokenMeta = TOKEN_META[currentBetToken] || TOKEN_META.MON;

  return (
    <>
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      <aside className="w-full md:w-80 lg:w-96 flex flex-col z-20 gap-4 flex-shrink-0 order-1">
        {/* Header */}
        <div className="neo-card p-4 shrink-0 bg-slate-800 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <a href="/" className="cursor-pointer flex items-center gap-2 group shrink-0" title="Back to home">
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

        {/* Main panel */}
        <div className="neo-card flex-1 flex flex-col overflow-hidden min-h-[300px] md:min-h-0">
          {/* Tab bar */}
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
            {/* ── BETS tab ────────────────────────────────────────── */}
            {activeTab === "market" && (
              <div className="space-y-3">
                {/* Wallet */}
                {!walletAddress ? (
                  <button onClick={connectWallet} className="w-full btn-neo btn-cyan text-sm py-2">
                    Connect Wallet
                  </button>
                ) : (
                  <div className="bg-slate-900 p-2 border-2 border-white shadow-[3px_3px_0_black] flex items-center justify-between text-xs">
                    <div>
                      <span className="font-bold text-[#22d3ee]">{shortenAddr(walletAddress)}</span>
                      {walletBalance != null && (
                        <span className="ml-2 text-slate-400">{walletBalance} {tokenMeta.symbol}</span>
                      )}
                    </div>
                    <button
                      onClick={() => {
                      setWalletAddress(null);
                      setWalletBalance(null);
                      providerRef.current = null;
                      signerRef.current = null;
                      contractRef.current = null;
                      try { localStorage.removeItem("clawio_wallet_address"); } catch (_) {}
                    }}
                      className="text-[10px] text-slate-500 hover:text-white"
                    >
                      Disconnect
                    </button>
                  </div>
                )}

                {/* Token selector */}
                <div className="flex gap-1 bg-[#facc15] border-2 border-white shadow-[2px_2px_0_black] text-[11px] font-black uppercase overflow-hidden">
                  <button
                    onClick={() => setCurrentBetToken("MON")}
                    className={`flex-1 py-1.5 transition-colors ${currentBetToken === "MON" ? "bg-black text-[#facc15]" : "bg-transparent text-black/60"}`}
                  >
                    MON
                  </button>
                  <button
                    onClick={() => setCurrentBetToken("MCLAW")}
                    className={`flex-1 py-1.5 transition-colors ${currentBetToken === "MCLAW" ? "bg-black text-[#facc15]" : "bg-transparent text-black/60"}`}
                  >
                    $MClawIO
                  </button>
                </div>

                {/* Pool summary */}
                <div className="bg-[#facc15] p-3 border-2 border-white shadow-[4px_4px_0_black] text-black">
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <div className="text-[10px] font-black uppercase opacity-60">Total Pool</div>
                      <div className="text-xl font-black">{status?.totalPoolMON || "0"} <span className="text-sm">{tokenMeta.symbol}</span></div>
                    </div>
                    <div className="text-right">
                      <span className="inline-block px-2 py-0.5 bg-black text-[#facc15] text-[10px] font-black uppercase">{phaseLabel}</span>
                      <div className="text-[10px] font-bold mt-0.5 opacity-60">{status?.bettorCount || 0} bettors</div>
                    </div>
                  </div>
                  {/* Pool bar */}
                  {status?.agents?.length > 0 && (
                    <div className="h-2 bg-black/20 flex overflow-hidden border border-black/30">
                      {status.agents.map((a, i) => (
                        <div
                          key={a.agentName}
                          className="h-full"
                          style={{ width: `${Math.max(a.percentage, 2)}%`, background: AGENT_COLORS[i % AGENT_COLORS.length] }}
                          title={`${a.agentName}: ${a.percentage.toFixed(1)}%`}
                        />
                      ))}
                    </div>
                  )}
                </div>

                {/* Sub-tabs */}
                <div className="flex gap-1">
                  {BET_SUB_TABS.map((st) => (
                    <button
                      key={st.id}
                      onClick={() => setBetSubTab(st.id)}
                      className={`flex-1 py-1.5 text-[10px] font-black uppercase border-2 transition-colors ${
                        betSubTab === st.id
                          ? "bg-[#d946ef] text-white border-white"
                          : "bg-slate-700 text-slate-300 border-slate-600 hover:border-white"
                      }`}
                    >
                      {st.label}
                    </button>
                  ))}
                </div>

                {/* ── Agents sub-tab ───────────────────────────────── */}
                {betSubTab === "agents" && (
                  <div className="space-y-2">
                    {!status?.agents?.length ? (
                      <div className="text-center text-sm font-bold text-slate-400 py-10 bg-slate-800 border-2 border-dashed border-slate-600">
                        Waiting for players...
                      </div>
                    ) : (
                      status.agents.map((agent, i) => {
                        const color = AGENT_COLORS[i % AGENT_COLORS.length];
                        const isOpen = status.status === "open";
                        const multiplierText = agent.multiplier > 0 ? agent.multiplier.toFixed(2) + "x" : "--";
                        const winRateText = typeof agent.winRate === "number"
                          ? `${(agent.winRate * 100).toFixed(1)}% win`
                          : "win% --";
                        const inputVal = betInputs[agent.agentName] || "";
                        const payout = getEstimatedPayout(agent, inputVal);

                        return (
                          <div key={agent.agentName} className="bg-slate-800 border-2 border-white p-3 shadow-[3px_3px_0_black]">
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2">
                                <div className="w-4 h-4 border-2 border-white" style={{ background: color }} />
                                <div className="flex flex-col">
                                  <span className="text-sm font-black text-white uppercase">{agent.agentName}</span>
                                  <span className="text-[10px] font-bold text-slate-400 leading-tight">{winRateText}</span>
                                </div>
                              </div>
                              <div className="text-right" title="Payout multiplier">
                                <div className="text-[9px] font-bold text-slate-400 uppercase">Payout</div>
                                <span className="text-lg neo-font" style={{ color }}>{multiplierText}</span>
                              </div>
                            </div>
                            <div className="flex items-center gap-2 mb-2">
                              <div className="flex-1 h-2 bg-slate-900 border border-white/20 overflow-hidden">
                                <div className="h-full" style={{ width: `${Math.max(agent.percentage, 1)}%`, background: color }} />
                              </div>
                              <span className="text-[10px] font-bold text-slate-400 w-12 text-right">{agent.percentage.toFixed(1)}%</span>
                            </div>
                            <div className="flex items-center justify-between text-[10px] text-slate-400 font-bold mb-2">
                              <span>{agent.poolMON} {tokenMeta.symbol} pooled</span>
                              <span>{agent.bettorCount} bettor{agent.bettorCount !== 1 ? "s" : ""}</span>
                            </div>
                            {isOpen && (
                              <div className="flex flex-col gap-1">
                                <div className="flex gap-2">
                                  <input
                                    type="number"
                                    min="0.01"
                                    step="0.01"
                                    placeholder={tokenMeta.symbol}
                                    value={inputVal}
                                    onChange={(e) => setBetInputs((prev) => ({ ...prev, [agent.agentName]: e.target.value }))}
                                    className="flex-1 bg-slate-900 border-2 border-white text-white text-sm px-2 py-1.5 font-mono focus:border-[#facc15] outline-none"
                                    style={{ maxWidth: 100 }}
                                  />
                                  <button
                                    onClick={() => placeBet(agent.agentName)}
                                    className="flex-1 py-1.5 text-xs font-black uppercase border-2 border-white text-black shadow-[2px_2px_0_black] hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-[1px_1px_0_black] transition-all"
                                    style={{ background: color }}
                                  >
                                    Bet
                                  </button>
                                </div>
                                {payout && (
                                  <div className="text-[10px] font-bold text-slate-300">
                                    If this bot wins: ~{payout} {tokenMeta.symbol} back (after fees)
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                )}

                {/* ── My Bets sub-tab ──────────────────────────────── */}
                {betSubTab === "mybets" && (
                  <div className="space-y-2">
                    {!walletAddress ? (
                      <div className="text-center text-sm font-bold text-slate-400 py-8 bg-slate-800 border-2 border-dashed border-slate-600">
                        Connect wallet to see your bets
                      </div>
                    ) : !myBets ? (
                      <div className="text-center text-sm text-slate-400 py-4">Loading...</div>
                    ) : (
                      <>
                        {myBets.statsByToken?.[currentBetToken] && (() => {
                          const stats = myBets.statsByToken[currentBetToken];
                          const totalBetWei = BigInt(stats.totalBet || "0");
                          const totalPayoutWei = BigInt(stats.totalPayout || "0");
                          const profitLoss = totalPayoutWei - totalBetWei;
                          const plColor = profitLoss >= 0n ? (profitLoss === 0n ? "#94a3b8" : "#22c55e") : "#ef4444";
                          const plSign = profitLoss > 0n ? "+" : profitLoss < 0n ? "-" : "";
                          const plAbs = profitLoss >= 0n ? profitLoss : -profitLoss;
                          return (
                            <>
                              <div className="grid grid-cols-3 gap-2">
                                <div className="bg-slate-800 border-2 border-white p-2 text-center">
                                  <div className="text-[9px] font-bold text-slate-400 uppercase">Total Bet</div>
                                  <div className="text-sm font-black text-[#facc15]">{weiToMON(totalBetWei.toString())} {tokenMeta.symbol}</div>
                                </div>
                                <div className="bg-slate-800 border-2 border-white p-2 text-center">
                                  <div className="text-[9px] font-bold text-slate-400 uppercase">Total Won</div>
                                  <div className="text-sm font-black text-[#22d3ee]">{weiToMON(totalPayoutWei.toString())} {tokenMeta.symbol}</div>
                                </div>
                                <div className="bg-slate-800 border-2 border-white p-2 text-center">
                                  <div className="text-[9px] font-bold text-slate-400 uppercase">P&L</div>
                                  <div className="text-sm font-black" style={{ color: plColor }}>
                                    {plSign}{weiToMON(plAbs.toString())} {tokenMeta.symbol}
                                  </div>
                                </div>
                              </div>
                              <div className="flex gap-3 text-[10px] font-bold text-slate-400">
                                <span>{stats.totalBets} bets</span>
                                <span>{stats.totalWins} wins</span>
                                <span>{stats.matchesPlayed} matches</span>
                              </div>
                            </>
                          );
                        })()}
                        {(() => {
                          const bets = myBets.betsByToken?.[currentBetToken] || [];
                          if (!bets.length) {
                            return (
                              <div className="text-center text-sm font-bold text-slate-400 py-8 bg-slate-800 border-2 border-dashed border-slate-600">
                                No bets placed yet
                              </div>
                            );
                          }
                          return bets.map((b, i) => (
                            <div key={i} className="bg-slate-800 border-2 border-white p-2 flex items-center justify-between">
                              <div>
                                <span className="text-xs font-black text-[#facc15] uppercase">{b.agentName}</span>
                                <span className="text-xs text-slate-400 ml-2">{weiToMON(b.amount)} {tokenMeta.symbol}</span>
                              </div>
                              {b.txHash && (
                                <a href={`https://monadvision.com/tx/${b.txHash}`} target="_blank" rel="noopener noreferrer"
                                  className="text-[10px] text-[#22d3ee] font-mono hover:underline"
                                >
                                  {b.txHash.slice(0, 8)}...
                                </a>
                              )}
                            </div>
                          ));
                        })()}
                      </>
                    )}
                  </div>
                )}

                {/* ── Leaderboard sub-tab ──────────────────────────── */}
                {betSubTab === "leaders" && (
                  <div className="space-y-2">
                    {!leaderboard || leaderboard.length === 0 ? (
                      <div className="text-center text-sm font-bold text-slate-400 py-8 bg-slate-800 border-2 border-dashed border-slate-600">
                        No bets placed yet
                      </div>
                    ) : (
                      leaderboard.slice(0, 20).map((e, i) => {
                        const rank = i + 1;
                        const rankColors = { 1: "#facc15", 2: "#94a3b8", 3: "#f97316" };
                        const rc = rankColors[rank] || "#64748b";
                        return (
                          <div key={i} className="bg-slate-800 border-2 border-white p-2 flex items-center gap-3">
                            <div className="w-6 h-6 flex items-center justify-center font-black text-xs border-2 border-white" style={{ background: rc, color: "black" }}>{rank}</div>
                            <div className="flex-1 min-w-0">
                              <div className="text-xs font-black text-white truncate">{e.bettorName || shortenAddr(e.bettorAddress)}</div>
                              <div className="text-[10px] text-slate-400 font-mono">{shortenAddr(e.bettorAddress)}</div>
                            </div>
                            <div className="text-right">
                              <div className="text-xs font-black text-[#facc15]">{e.totalVolumeMON} {tokenMeta.symbol}</div>
                              <div className="text-[10px] text-slate-400">{e.totalBets} bets / {e.totalWins} wins</div>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                )}

                {/* ── Results sub-tab ──────────────────────────────── */}
                {betSubTab === "results" && (
                  <div className="space-y-2">
                    {!resultsData || !resultsData.bets?.length ? (
                      <div className="text-center text-sm font-bold text-slate-400 py-8 bg-slate-800 border-2 border-dashed border-slate-600">
                        No betting results yet
                      </div>
                    ) : (() => {
                      const bets = resultsData.bets || [];
                      const settlements = resultsData.settlements || [];
                      const pool = resultsData.pool;
                      const winnerNames = pool?.winner_agent_names || [];
                      const winnerSet = new Set(winnerNames);

                      // Aggregate per bettor
                      const byAddr = new Map();
                      for (const b of bets) {
                        const key = (b.bettor_address || "").toLowerCase();
                        const entry = byAddr.get(key) || { addr: key, name: b.bettor_name, totalBet: 0n, totalPayout: 0n, betOnWinner: 0n };
                        const amt = BigInt(b.amount || "0");
                        entry.totalBet += amt;
                        if (winnerSet.has(b.agent_name)) entry.betOnWinner += amt;
                        byAddr.set(key, entry);
                      }
                      for (const s of settlements) {
                        const key = (s.bettor_address || "").toLowerCase();
                        const entry = byAddr.get(key) || { addr: key, name: null, totalBet: 0n, totalPayout: 0n, betOnWinner: 0n };
                        entry.totalPayout += BigInt(s.payout_amount || "0");
                        byAddr.set(key, entry);
                      }

                      const entries = Array.from(byAddr.values()).sort((a, b) =>
                        b.totalPayout > a.totalPayout ? 1 : b.totalPayout < a.totalPayout ? -1 : 0
                      );

                      return entries.map((e, i) => {
                        const isWinner = e.totalPayout > 0n;
                        return (
                          <div
                            key={i}
                            className={`bg-slate-800 border-2 border-white p-2 flex items-center justify-between text-[10px] ${
                              isWinner ? "shadow-[3px_3px_0_#facc15]" : "shadow-[2px_2px_0_black]"
                            }`}
                          >
                            <div className="flex flex-col min-w-0">
                              <span className="font-black text-white truncate">{e.name || shortenAddr(e.addr)}</span>
                              <span className="font-mono text-slate-400 truncate">{shortenAddr(e.addr)}</span>
                            </div>
                            <div className="text-right ml-2">
                              <div className="text-slate-300">{weiToMON(e.totalBet.toString())} {tokenMeta.symbol} bet</div>
                              <div className="text-slate-300">{weiToMON(e.totalPayout.toString())} {tokenMeta.symbol} won</div>
                              <div className="font-black text-[#facc15]">
                                {e.totalBet > 0n ? (Number(e.totalPayout * 1000n / e.totalBet) / 1000).toFixed(2) + "x" : "--"}
                              </div>
                            </div>
                          </div>
                        );
                      });
                    })()}
                  </div>
                )}
              </div>
            )}

            {/* ── TOKEN tab ───────────────────────────────────────── */}
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
    </>
  );
}
