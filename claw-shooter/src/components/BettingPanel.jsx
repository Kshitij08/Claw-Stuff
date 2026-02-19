/**
 * Betting panel for Claw Shooter – same contract and API as claw snake.
 * Uses /api/shooter/status for current match, /api/betting/* for contract and odds.
 */
import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import { io } from "socket.io-client";

const SHOOTER_STATUS_URL = "/api/shooter/status";
const BETTING_STATUS_POLL_MS = 5000;
const MONAD_CHAIN_ID = "0x8f"; // 143
const MONAD_MAINNET = {
  chainId: MONAD_CHAIN_ID,
  chainName: "Monad",
  rpcUrls: ["https://rpc.monad.xyz"],
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  blockExplorerUrls: ["https://monadvision.com"],
};
const MCLAW_TOKEN_ADDRESS = "0x26813a9B80f43f98cee9045B9f7CdcA816C57777";
const TOKEN_META = { MON: { symbol: "MON" }, MCLAW: { symbol: "MClawIO" } };
const AGENT_COLORS = ["#d946ef", "#22d3ee", "#facc15", "#a3e635", "#f97316", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6", "#f59e0b"];

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

function shortenAddr(addr) {
  if (!addr) return "";
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

export function BettingPanel() {
  const [apiBase] = useState(() => getApiBase());
  const [matchId, setMatchId] = useState(null);
  const [bettingStatus, setBettingStatus] = useState(null);
  const [walletAddress, setWalletAddress] = useState(null);
  const [provider, setProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [contract, setContract] = useState(null);
  const [contractAddress, setContractAddress] = useState("");
  const [contractABI, setContractABI] = useState([]);
  const [currentToken, setCurrentToken] = useState("MON");
  const [message, setMessage] = useState(null);
  const [messageType, setMessageType] = useState("info");
  const [betInputs, setBetInputs] = useState({});
  const [loading, setLoading] = useState(false);

  const showMsg = useCallback((msg, type = "info") => {
    setMessage(msg);
    setMessageType(type);
    if (msg && type !== "info") setTimeout(() => setMessage(null), 5000);
  }, []);

  // Poll shooter status for current match id
  useEffect(() => {
    let cancelled = false;
    const fetchStatus = async () => {
      try {
        const res = await fetch(`${apiBase}${SHOOTER_STATUS_URL}`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled && data?.currentMatch?.id) setMatchId(data.currentMatch.id);
        else if (!cancelled) setMatchId(null);
      } catch {
        if (!cancelled) setMatchId(null);
      }
    };
    fetchStatus();
    const interval = setInterval(fetchStatus, 2500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [apiBase]);

  // When matchId exists, fetch contract info once and poll betting status
  useEffect(() => {
    if (!matchId) {
      setBettingStatus(null);
      return;
    }
    let cancelled = false;
    const loadContract = async () => {
      try {
        const res = await fetch(`${apiBase}/api/betting/contract-info`);
        const data = await res.json();
        if (cancelled) return;
        if (data?.contractAddress && Array.isArray(data?.abi) && data.abi.length) {
          setContractAddress(data.contractAddress);
          setContractABI(data.abi);
        }
      } catch (e) {
        if (!cancelled) console.warn("Betting contract-info failed", e);
      }
    };
    loadContract();

    const fetchBetting = async () => {
      try {
        const res = await fetch(`${apiBase}/api/betting/status/${encodeURIComponent(matchId)}?token=${currentToken}&game=shooter`);
        const data = await res.json();
        if (!cancelled) setBettingStatus(data);
      } catch {
        if (!cancelled) setBettingStatus(null);
      }
    };
    fetchBetting();
    const interval = setInterval(fetchBetting, BETTING_STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [matchId, apiBase, currentToken]);

  // Wallet: restore existing account (eth_accounts) and listen for accountsChanged
  useEffect(() => {
    if (typeof window === "undefined" || !window.ethereum) return;
    const connect = async (request = false) => {
      try {
        const method = request ? "eth_requestAccounts" : "eth_accounts";
        const accounts = await window.ethereum.request({ method });
        if (!accounts?.[0]) return;
        const prov = new ethers.BrowserProvider(window.ethereum);
        const sig = await prov.getSigner();
        const addr = await sig.getAddress();
        setWalletAddress(addr);
        setProvider(prov);
        setSigner(sig);
        if (request) {
          try {
            await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: MONAD_CHAIN_ID }] });
          } catch (switchErr) {
            if (switchErr?.code === 4902) {
              await window.ethereum.request({ method: "wallet_addEthereumChain", params: [MONAD_MAINNET] });
            }
          }
        }
      } catch (e) {
        console.warn("Wallet connect failed", e);
      }
    };
    connect(false);
    const handleAccountsChanged = (accounts) => {
      if (!accounts?.length) {
        setWalletAddress(null);
        setSigner(null);
        setProvider(null);
        setContract(null);
      } else {
        connect(false);
      }
    };
    window.ethereum.on("accountsChanged", handleAccountsChanged);
    return () => {
      window.ethereum.removeListener("accountsChanged", handleAccountsChanged);
    };
  }, []);

  // Build contract instance when we have signer + address + ABI
  useEffect(() => {
    if (!signer || !contractAddress || !contractABI.length) {
      setContract(null);
      return;
    }
    setContract(new ethers.Contract(contractAddress, contractABI, signer));
  }, [signer, contractAddress, contractABI]);

  const connectWallet = async () => {
    if (!window.ethereum) {
      showMsg("No wallet detected. Install MetaMask or another browser wallet.", "error");
      return;
    }
    setLoading(true);
    try {
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      if (!accounts?.[0]) {
        showMsg("No account selected", "error");
        return;
      }
      try {
        await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: MONAD_CHAIN_ID }] });
      } catch (switchErr) {
        if (switchErr?.code === 4902) {
          await window.ethereum.request({ method: "wallet_addEthereumChain", params: [MONAD_MAINNET] });
        } else throw switchErr;
      }
      const prov = new ethers.BrowserProvider(window.ethereum);
      const sig = await prov.getSigner();
      const addr = await sig.getAddress();
      setWalletAddress(addr);
      setProvider(prov);
      setSigner(sig);
      setContract(contractAddress && contractABI.length ? new ethers.Contract(contractAddress, contractABI, sig) : null);
      showMsg(`Connected: ${shortenAddr(addr)}`, "success");
    } catch (err) {
      showMsg("Connection failed: " + (err?.message || err), "error");
    } finally {
      setLoading(false);
    }
  };

  const placeBet = async (agentName, amountStr) => {
    if (!walletAddress || !contract) {
      showMsg("Connect your wallet first", "error");
      return;
    }
    const amount = parseFloat(amountStr);
    if (!amountStr || isNaN(amount) || amount <= 0) {
      showMsg("Enter a valid bet amount", "error");
      return;
    }
    if (!matchId) {
      showMsg("No active match to bet on", "error");
      return;
    }
    if (bettingStatus?.status !== "open") {
      showMsg("Betting is not open yet. Wait for OPEN.", "error");
      return;
    }
    const amountWei = ethers.parseEther(String(amount));
    const tokenMeta = TOKEN_META[currentToken] || TOKEN_META.MON;
    setLoading(true);
    try {
      showMsg(`Placing ${amount} ${tokenMeta.symbol} on ${agentName}...`, "info");
      const matchIdB32 = ethers.encodeBytes32String(matchId.length > 31 ? matchId.slice(0, 31) : matchId);
      const agentIdB32 = ethers.encodeBytes32String(agentName.length > 31 ? agentName.slice(0, 31) : agentName);
      let tx;
      if (currentToken === "MON") {
        tx = await contract.placeBet(matchIdB32, agentIdB32, { value: amountWei });
      } else {
        const erc20 = new ethers.Contract(
          MCLAW_TOKEN_ADDRESS,
          ["function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"],
          signer
        );
        const allowance = await erc20.allowance(walletAddress, contractAddress);
        if (allowance < amountWei) {
          showMsg(`Approving ${tokenMeta.symbol}...`, "info");
          const approveTx = await erc20.approve(contractAddress, amountWei);
          await approveTx.wait();
        }
        tx = await contract.placeMclawBet(matchIdB32, agentIdB32, amountWei);
      }
      const receipt = await tx.wait();
      showMsg(`Bet placed: ${amount} ${tokenMeta.symbol} on ${agentName}`, "success");
      setBetInputs((prev) => ({ ...prev, [agentName]: "" }));
      // Notify backend so it records the bet (same as claw snake)
      try {
        const base = apiBase || (typeof window !== "undefined" ? window.location.origin : "");
        if (base) {
          const socket = io(base);
          socket.emit("humanBetPlaced", {
            matchId,
            bettorAddress: walletAddress,
            agentName,
            amountWei: amountWei.toString(),
            token: currentToken,
            txHash: receipt.hash,
          });
          socket.close();
        }
      } catch (e) {
        console.warn("Socket notify failed", e);
      }
      // Refresh status
      const res = await fetch(`${apiBase}/api/betting/status/${encodeURIComponent(matchId)}?token=${currentToken}&game=shooter`);
      const data = await res.json();
      setBettingStatus(data);
    } catch (err) {
      const reason = err.reason || err.message || "Transaction failed";
      showMsg("Bet failed: " + reason, "error");
    } finally {
      setLoading(false);
    }
  };

  const PHASE_LABELS = { pending: "OPENING…", open: "OPEN", closed: "LOCKED", resolved: "SETTLED", cancelled: "CANCELLED", none: "—" };
  const phaseLabel = bettingStatus?.status ? (PHASE_LABELS[bettingStatus.status] || "—") : "—";
  const agents = bettingStatus?.agents ?? [];
  const isOpen = bettingStatus?.status === "open";
  const tokenMeta = TOKEN_META[currentToken] || TOKEN_META.MON;

  return (
    <div className="space-y-4">
      {message && (
        <div
          className={`text-xs font-bold px-3 py-2 border-2 rounded ${
            messageType === "error" ? "bg-red-500/20 text-red-200 border-red-400" : messageType === "success" ? "bg-lime-500/20 text-lime-200 border-lime-400" : "bg-slate-700 text-slate-200 border-slate-500"
          }`}
        >
          {message}
        </div>
      )}

      {!walletAddress ? (
        <div className="bg-slate-800 p-4 border-2 border-white shadow-[4px_4px_0_black] text-center">
          <p className="text-sm font-bold text-slate-300 mb-2">Connect wallet to place bets</p>
          <button
            type="button"
            onClick={connectWallet}
            disabled={loading}
            className="btn-neo btn-yellow w-full py-2 text-sm font-black uppercase disabled:opacity-50"
          >
            {loading ? "Connecting…" : "Connect Wallet"}
          </button>
        </div>
      ) : (
        <div className="bg-slate-800 p-3 border-2 border-white shadow-[4px_4px_0_black]">
          <div className="flex items-center justify-between gap-2 mb-2">
            <span className="text-[10px] font-black uppercase text-slate-400">Wallet</span>
            <span className="text-xs font-mono text-white">{shortenAddr(walletAddress)}</span>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setCurrentToken("MON")}
              className={`flex-1 py-1 text-xs font-black ${currentToken === "MON" ? "bg-black text-[#facc15]" : "bg-slate-700 text-slate-400"}`}
            >
              MON
            </button>
            <button
              type="button"
              onClick={() => setCurrentToken("MCLAW")}
              className={`flex-1 py-1 text-xs font-black ${currentToken === "MCLAW" ? "bg-black text-[#facc15]" : "bg-slate-700 text-slate-400"}`}
            >
              $MClawIO
            </button>
          </div>
        </div>
      )}

      {matchId && (
        <>
          <div className="bg-slate-800 p-3 border-2 border-white shadow-[4px_4px_0_black] flex items-center justify-between">
            <span className="text-[10px] font-black uppercase text-slate-400">Phase</span>
            <span className="text-sm font-black text-white">{phaseLabel}</span>
          </div>
          {bettingStatus && (
            <>
              <div className="bg-slate-800 p-3 border-2 border-white shadow-[4px_4px_0_black]">
                <div className="text-[10px] font-black uppercase text-slate-400 mb-1">Total pool</div>
                <div className="text-lg font-black text-[#facc15]">
                  {bettingStatus.totalPoolMON ?? "0"} {tokenMeta.symbol}
                </div>
                <div className="text-[10px] text-slate-400">{bettingStatus.bettorCount ?? 0} bettors</div>
              </div>
              {agents.length === 0 ? (
                <div className="text-center text-sm font-bold text-slate-400 py-6 bg-slate-800 border-2 border-dashed border-slate-600">
                  Waiting for players…
                </div>
              ) : (
                <div className="space-y-3">
                  {agents.map((agent, i) => {
                    const color = AGENT_COLORS[i % AGENT_COLORS.length];
                    const val = betInputs[agent.agentName] ?? "";
                    return (
                      <div key={agent.agentName} className="bg-slate-800 border-2 border-white p-3 shadow-[3px_3px_0_black]">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <div className="w-4 h-4 border-2 border-white shrink-0" style={{ background: color }} />
                            <div>
                              <span className="text-sm font-black text-white uppercase">{agent.agentName}</span>
                              <div className="text-[10px] font-bold text-slate-400">
                                Payout: {agent.multiplier > 0 ? agent.multiplier.toFixed(2) + "x" : "—"}
                              </div>
                            </div>
                          </div>
                          <span className="text-[10px] font-bold text-slate-400">{agent.percentage.toFixed(1)}% pool</span>
                        </div>
                        <div className="h-2 bg-slate-900 border border-white/20 overflow-hidden mb-2">
                          <div className="h-full" style={{ width: `${Math.max(agent.percentage, 1)}%`, background: color }} />
                        </div>
                        {isOpen && (
                          <div className="flex gap-2">
                            <input
                              type="number"
                              min="0.01"
                              step="0.01"
                              placeholder={tokenMeta.symbol}
                              value={val}
                              onChange={(e) => setBetInputs((prev) => ({ ...prev, [agent.agentName]: e.target.value }))}
                              className="flex-1 bg-slate-900 border-2 border-white text-white text-sm px-2 py-1.5 font-mono focus:border-[#facc15] outline-none min-w-0"
                            />
                            <button
                              type="button"
                              onClick={() => placeBet(agent.agentName, val)}
                              disabled={loading || !val || parseFloat(val) <= 0}
                              className="py-1.5 px-3 text-xs font-black uppercase border-2 border-white text-black shadow-[2px_2px_0_black] hover:translate-x-[1px] hover:translate-y-[1px] disabled:opacity-50"
                              style={{ background: color }}
                            >
                              Bet
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </>
      )}

      {!matchId && (
        <div className="text-center text-sm font-bold text-slate-400 py-4 bg-slate-800 border-2 border-dashed border-slate-600">
          Waiting for next match…
        </div>
      )}
    </div>
  );
}
