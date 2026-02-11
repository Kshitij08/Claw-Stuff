/**
 * Claw IO – Betting / Prediction Market frontend logic.
 *
 * Handles:
 *  - MetaMask / injected wallet connection (Monad mainnet)
 *  - Placing bets on-chain via ClawBetting contract
 *  - Real-time odds updates via WebSocket
 *  - Toast notifications
 *  - My bets panel, claim flow, leaderboard
 */

/* ================================================================
   State
   ================================================================ */
let walletAddress = null;
let provider = null;      // ethers BrowserProvider
let signer = null;        // ethers Signer
let bettingContract = null;
let contractAddress = '';
let contractABI = [];
let currentBettingStatus = null; // latest BettingStatus from server
window.currentBettingStatus = null; // Expose globally for main.js
let currentMatchId = null;
// Most recently settled match (for results tab) – tracked via live events only.
let lastResolvedMatchId = null;
let currentBetToken = 'MON';     // 'MON' | 'MCLAW'

// Persist typed bet amounts per agent so that re-renders
// don't wipe all inputs when a single bet is placed.
const betInputValues = Object.create(null);

// Store bets locally by matchId for instant reward calculation
// Format: { [matchId]: [{ agentName, amountWei, token, txHash, timestamp }, ...] }
const localBetsByMatch = Object.create(null);
// Expose globally so main.js can access it
window.localBetsByMatch = localBetsByMatch;

// Load persisted bets from localStorage on init
try {
  const stored = localStorage.getItem('localBetsByMatch');
  if (stored) {
    const parsed = JSON.parse(stored);
    Object.assign(localBetsByMatch, parsed);
    Object.assign(window.localBetsByMatch, parsed);
  }
} catch (e) {
  console.warn('Failed to load local bets from localStorage:', e);
}

// $MClawIO token (Monad) – same CA as TOKEN tab
const MCLAW_TOKEN_ADDRESS = '0x26813a9B80f43f98cee9045B9f7CdcA816C57777';

const TOKEN_META = {
  MON:   { symbol: 'MON' },
  MCLAW: { symbol: 'MClawIO' },
};

const MONAD_MAINNET = {
  chainId: '0x8f',            // 143
  chainName: 'Monad',
  rpcUrls: ['https://rpc.monad.xyz'],
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  blockExplorerUrls: ['https://monadvision.com'],
};

/* ================================================================
   Wallet Connection
   ================================================================ */
window.connectWallet = async function connectWallet() {
  // Prefer Reown wallet connect modal when configured (may still be initializing)
  if (typeof window.openReownConnect === 'function') {
    window.openReownConnect();
    return;
  }
  // Reown loads async (fetch + dynamic import). Wait for it before falling back to MetaMask.
  if (window.reownReady === false && !window.reownInitFailed) {
    showToast('Loading wallet options…', 'info');
    try {
      await new Promise(function (resolve, reject) {
        const t = setTimeout(function () {
          reject(new Error('timeout'));
        }, 8000);
        window.addEventListener('reown-ready', function onReady() {
          clearTimeout(t);
          window.removeEventListener('reown-ready', onReady);
          resolve();
        }, { once: true });
      });
      if (typeof window.openReownConnect === 'function') {
        window.openReownConnect();
        return;
      }
    } catch (_) {
      window.reownInitFailed = true;
    }
  }

  if (!window.ethereum) {
    showToast('No wallet detected. Install MetaMask or another browser wallet.', 'error');
    return;
  }

  try {
    // Request accounts
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    walletAddress = accounts[0];

    // Ensure correct chain
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: MONAD_MAINNET.chainId }],
      });
    } catch (switchErr) {
      if (switchErr.code === 4902) {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [MONAD_MAINNET],
        });
      } else {
        throw switchErr;
      }
    }

    // Set up ethers
    provider = new ethers.BrowserProvider(window.ethereum);
    signer = await provider.getSigner();
    walletAddress = await signer.getAddress();

    // Load contract info from backend
    await loadContractInfo();

    // Update UI
    updateWalletUI();
    showToast(`Wallet connected: ${shortenAddr(walletAddress)}`, 'success');

    // Refresh betting data
    if (currentMatchId) {
      fetchBettingStatus(currentMatchId);
      fetchMyBets(currentMatchId);
    }
  } catch (err) {
    console.error('Wallet connection failed:', err);
    showToast('Wallet connection failed: ' + (err.message || err), 'error');
  }
};

async function loadContractInfo() {
  try {
    const res = await fetch('/api/betting/contract-info');
    const data = await res.json();
    contractAddress = data.contractAddress || '';
    contractABI = data.abi || [];
    if (contractAddress && contractABI.length && signer) {
      bettingContract = new ethers.Contract(contractAddress, contractABI, signer);
    }
  } catch (err) {
    console.error('Failed to load contract info:', err);
  }
}

function updateWalletUI() {
  const btn = document.getElementById('wallet-connect-btn');
  const disconnected = document.getElementById('betting-wallet-disconnected');
  const connected = document.getElementById('betting-wallet-connected');
  const addrEl = document.getElementById('betting-wallet-addr');
  const balEl = document.getElementById('betting-wallet-balance');
  const symEl = document.getElementById('betting-wallet-symbol');

  if (walletAddress) {
    if (btn) btn.textContent = shortenAddr(walletAddress);
    if (disconnected) disconnected.classList.add('hidden');
    if (connected) connected.classList.remove('hidden');
    if (addrEl) addrEl.textContent = shortenAddr(walletAddress);

    const tokenMeta = TOKEN_META[currentBetToken] || TOKEN_META.MON;
    if (symEl) symEl.textContent = tokenMeta.symbol;

    // Fetch balance for selected token
    if (provider && balEl) {
      if (currentBetToken === 'MON') {
        provider.getBalance(walletAddress).then(bal => {
          balEl.textContent = parseFloat(ethers.formatEther(bal)).toFixed(3);
        }).catch(() => {});
      } else {
        // MClawIO ERC-20 balance
        const erc20Abi = [
          'function balanceOf(address owner) view returns (uint256)',
        ];
        const mclaw = new ethers.Contract(MCLAW_TOKEN_ADDRESS, erc20Abi, provider);
        mclaw.balanceOf(walletAddress).then(bal => {
          balEl.textContent = parseFloat(ethers.formatUnits(bal, 18)).toFixed(3);
        }).catch(() => {});
      }
    }
  }
}

// Reown: when user connects via the Reown modal, wire ethers and UI
window.addEventListener('reown-wallet-connected', async function (e) {
  const { provider: reownProvider, address } = e.detail || {};
  if (!reownProvider || !address) return;
  try {
    provider = new ethers.BrowserProvider(reownProvider);
    signer = await provider.getSigner();
    walletAddress = address;
    await loadContractInfo();
    updateWalletUI();
    showToast('Wallet connected: ' + shortenAddr(walletAddress), 'success');
    if (currentMatchId) {
      fetchBettingStatus(currentMatchId);
      fetchMyBets(currentMatchId);
    }
  } catch (err) {
    console.error('Reown wallet setup failed:', err);
    showToast('Wallet setup failed: ' + (err.message || err), 'error');
  }
});

window.addEventListener('reown-wallet-disconnected', function () {
  walletAddress = null;
  signer = null;
  provider = null;
  bettingContract = null;
  const btn = document.getElementById('wallet-connect-btn');
  if (btn) btn.textContent = 'Connect Wallet';
  const disconnected = document.getElementById('betting-wallet-disconnected');
  const connected = document.getElementById('betting-wallet-connected');
  if (disconnected) disconnected.classList.remove('hidden');
  if (connected) connected.classList.add('hidden');
});

// Listen for account/chain changes (when not using Reown)
if (window.ethereum) {
  window.ethereum.on('accountsChanged', (accounts) => {
    if (window.useReownConnect) return; // Reown handles connect/disconnect
    if (accounts.length === 0) {
      walletAddress = null;
      signer = null;
      bettingContract = null;
      const btn = document.getElementById('wallet-connect-btn');
      if (btn) btn.textContent = 'Connect Wallet';
      const disconnected = document.getElementById('betting-wallet-disconnected');
      const connected = document.getElementById('betting-wallet-connected');
      if (disconnected) disconnected.classList.remove('hidden');
      if (connected) connected.classList.add('hidden');
    } else {
      walletAddress = accounts[0];
      connectWallet();
    }
  });
  window.ethereum.on('chainChanged', () => { window.location.reload(); });
}

/* ================================================================
   Betting Sub-Tabs
   ================================================================ */
window.switchBetSubTab = function switchBetSubTab(tab) {
  ['agents', 'mybets', 'leaders', 'results'].forEach(id => {
    const panel = document.getElementById(`bet-panel-${id}`);
    const btn = document.getElementById(`bet-sub-${id}`);
    if (panel) panel.classList.add('hidden');
    if (btn) {
      btn.classList.remove('bg-[#d946ef]', 'text-white');
      btn.classList.add('bg-slate-700', 'text-slate-300');
    }
  });
  const panel = document.getElementById(`bet-panel-${tab}`);
  const btn = document.getElementById(`bet-sub-${tab}`);
  if (panel) panel.classList.remove('hidden');
  if (btn) {
    btn.classList.remove('bg-slate-700', 'text-slate-300');
    btn.classList.add('bg-[#d946ef]', 'text-white');
  }

  if (tab === 'leaders') fetchLeaderboard();
  if (tab === 'mybets' && currentMatchId) fetchMyBets(currentMatchId);
  if (tab === 'results') {
    const targetMatchId = lastResolvedMatchId || currentMatchId;
    if (targetMatchId) {
      fetchBettingResults(targetMatchId);
    }
  }
};

// Switch between MON and MClawIO betting pools
window.switchBetToken = function switchBetToken(token) {
  const normalized = token === 'MCLAW' ? 'MCLAW' : 'MON';
  currentBetToken = normalized;
  const btnMon = document.getElementById('bet-token-mon');
  const btnMclaw = document.getElementById('bet-token-mclaw');
  if (btnMon && btnMclaw) {
    if (normalized === 'MON') {
      btnMon.className = 'px-2 py-0.5 bg-black text-[#facc15]';
      btnMclaw.className = 'px-2 py-0.5 bg-transparent text-black/60';
    } else {
      btnMon.className = 'px-2 py-0.5 bg-transparent text-black/60';
      btnMclaw.className = 'px-2 py-0.5 bg-black text-[#facc15]';
    }
  }
  if (currentMatchId) {
    fetchBettingStatus(currentMatchId);
    // Refresh per-token views if their tabs are active
    const myBetsPanel = document.getElementById('bet-panel-mybets');
    if (myBetsPanel && !myBetsPanel.classList.contains('hidden')) {
      fetchMyBets(currentMatchId);
    }
    const leadersPanel = document.getElementById('bet-panel-leaders');
    if (leadersPanel && !leadersPanel.classList.contains('hidden')) {
      fetchLeaderboard();
    }
  }
  // Refresh wallet balance + symbol for selected token
  updateWalletUI();
};

/* ================================================================
   Betting Status & Odds
   ================================================================ */
async function fetchBettingStatus(matchId) {
  try {
    const res = await fetch(`/api/betting/status/${matchId}?token=${encodeURIComponent(currentBetToken)}`);
    const data = await res.json();
    currentBettingStatus = data;
    window.currentBettingStatus = data;
    renderBettingUI(data);
  } catch (err) {
    console.error('Failed to fetch betting status:', err);
  }
}

const AGENT_COLORS = ['#d946ef', '#22d3ee', '#facc15', '#a3e635', '#f97316', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f59e0b'];

function renderBettingUI(status) {
  // Phase badge
  const phaseEl = document.getElementById('betting-phase-badge');
  if (phaseEl) {
    const labels = { pending: 'OPENING…', open: 'OPEN', closed: 'LOCKED', resolved: 'SETTLED', cancelled: 'CANCELLED', none: '--' };
    phaseEl.textContent = labels[status.status] || '--';
  }

  // Match + betting status helper text
  const matchStatusEl = document.getElementById('betting-match-status');
  if (matchStatusEl) {
    let text = 'Waiting for next match…';
    if (status.status === 'pending') {
      // Keep only the badge; no helper text for pending.
      text = '';
    } else if (status.status === 'open') {
      // Keep only the badge; no helper text for open.
      text = '';
    } else if (status.status === 'closed') {
      //text = 'Betting locked – match in progress.';
      text = '';
    } else if (status.status === 'resolved') {
      //text = 'Match finished – check your bets below.';
      text = '';
    } else if (status.status === 'cancelled') {
      //text = 'Match cancelled – bets refunded.';
      text = '';
    }
    matchStatusEl.textContent = text;
  }

  // Total pool
  const poolEl = document.getElementById('total-pool-display');
  if (poolEl) poolEl.textContent = status.totalPoolMON || '0';
  const poolSymbolEl = document.getElementById('total-pool-symbol');
  if (poolSymbolEl) {
    const meta = TOKEN_META[status.token || currentBetToken] || TOKEN_META.MON;
    poolSymbolEl.textContent = meta.symbol;
  }

  // Bettor count
  const countEl = document.getElementById('betting-bettor-count');
  if (countEl) countEl.textContent = `${status.bettorCount || 0} bettors`;

  // Pool bar
  const bar = document.getElementById('pool-bar');
  if (bar && status.agents.length > 0) {
    bar.innerHTML = status.agents.map((a, i) => {
      const color = AGENT_COLORS[i % AGENT_COLORS.length];
      const w = Math.max(a.percentage, 2);
      return `<div class="h-full odds-bar-fill" style="width:${w}%;background:${color}" title="${a.agentName}: ${a.percentage.toFixed(1)}%"></div>`;
    }).join('');
  } else if (bar) {
    bar.innerHTML = '';
  }

  // Agent cards
  const list = document.getElementById('betting-list');
  if (!list) return;

  if (!status.agents.length) {
    if (status.status === 'none' || status.status === 'open' || status.status === 'pending') {
      list.innerHTML = '<div class="text-center text-sm font-bold text-slate-400 py-10 bg-slate-800 border-2 border-dashed border-slate-600">Waiting for players...</div>';
    }
    return;
  }

  list.innerHTML = status.agents.map((agent, i) => {
    const color = AGENT_COLORS[i % AGENT_COLORS.length];
    const isOpen = status.status === 'open';
    const multiplierText = agent.multiplier > 0 ? agent.multiplier.toFixed(2) + 'x' : '--';
    const winRateText = typeof agent.winRate === 'number'
      ? `${(agent.winRate * 100).toFixed(1)}% win`
      : 'win% --';
    const tokenMeta = TOKEN_META[status.token || currentBetToken] || TOKEN_META.MON;
    const payoutHint = agent.multiplier > 0 && agent.multiplier < 1
      ? ' (favorite – less than bet back if win)'
      : agent.multiplier > 0 ? ` (per 1 ${tokenMeta.symbol} bet back if win)` : '';

    return `
      <div class="bg-slate-800 border-2 border-white p-3 shadow-[3px_3px_0_black]">
        <div class="flex items-center justify-between mb-2">
          <div class="flex items-center gap-2">
            <div class="w-4 h-4 border-2 border-white" style="background:${color}"></div>
            <div class="flex flex-col">
              <span class="text-sm font-black text-white uppercase">${escHtml(agent.agentName)}</span>
              <span class="text-[10px] font-bold text-slate-400 leading-tight">${winRateText}</span>
            </div>
          </div>
          <div class="text-right" title="If this agent wins: you get this many ${tokenMeta.symbol} per 1 ${tokenMeta.symbol} bet${payoutHint}">
            <div class="text-[9px] font-bold text-slate-400 uppercase">Payout</div>
            <span class="bet-multiplier text-lg neo-font" style="color:${color}">${multiplierText}</span>
          </div>
        </div>
        <div class="flex items-center gap-2 mb-2">
          <div class="flex-1 h-2 bg-slate-900 border border-white/20 overflow-hidden">
            <div class="h-full odds-bar-fill" style="width:${Math.max(agent.percentage, 1)}%;background:${color}"></div>
          </div>
          <span class="text-[10px] font-bold text-slate-400 w-12 text-right" title="Share of total pool">${agent.percentage.toFixed(1)}% pool</span>
        </div>
        <div class="flex items-center justify-between text-[10px] text-slate-400 font-bold mb-2">
          <span>${agent.poolMON} ${tokenMeta.symbol} pooled</span>
          <span>${agent.bettorCount} bettor${agent.bettorCount !== 1 ? 's' : ''}</span>
        </div>
        ${isOpen ? `
        <div class="flex flex-col gap-1">
          <div class="flex gap-2">
            <input type="number" min="0.01" step="0.01" placeholder="${tokenMeta.symbol}" id="bet-input-${i}"
                   class="flex-1 bg-slate-900 border-2 border-white text-white text-sm px-2 py-1.5 font-mono focus:border-[#facc15] outline-none"
                   value="${escAttr(betInputValues[agent.agentName] || '')}"
                   style="max-width: 100px;" oninput="updateBetPayoutForAgent(${i})" />
            <button onclick="placeBetOnAgent('${escAttr(agent.agentName)}', ${i})"
                    class="flex-1 py-1.5 text-xs font-black uppercase border-2 border-white text-black shadow-[2px_2px_0_black] hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-[1px_1px_0_black] transition-all"
                    style="background:${color}">
              Bet
            </button>
          </div>
          <div class="text-[10px] font-bold text-slate-300" id="bet-payout-${i}"></div>
        </div>` : ''}
      </div>
    `;
  }).join('');
}

// Live payout helper: shows estimated return for the typed amount
window.updateBetPayoutForAgent = function updateBetPayoutForAgent(index) {
  if (!currentBettingStatus || !currentBettingStatus.agents || !currentBettingStatus.agents[index]) return;
  const input = document.getElementById(`bet-input-${index}`);
  const label = document.getElementById(`bet-payout-${index}`);
  if (!input || !label) return;

  const raw = input.value;
  const amount = parseFloat(raw || '0');
  const agent = currentBettingStatus.agents[index];
  const tokenMeta = TOKEN_META[currentBettingStatus.token || currentBetToken] || TOKEN_META.MON;

  if (!raw || isNaN(amount) || amount <= 0 || !agent) {
    if (agent && betInputValues[agent.agentName]) {
      delete betInputValues[agent.agentName];
    }
    label.textContent = '';
    return;
  }

  // Remember the typed value so it survives list re-renders.
  betInputValues[agent.agentName] = raw;

  // Calculate multiplier considering ALL bets in the pool INCLUDING this hypothetical new bet.
  // Formula: multiplier = (totalPool * 0.9) / agentPool
  // Where totalPool and agentPool include the new bet amount.
  let multiplier = 1;
  try {
    const currentTotalPoolWei = BigInt(currentBettingStatus.totalPool || '0');
    const currentAgentPoolWei = BigInt(agent.pool || '0');
    const newBetWei = ethers.parseEther(raw);
    
    // Add the new bet to both pools
    const newTotalPoolWei = currentTotalPoolWei + newBetWei;
    const newAgentPoolWei = currentAgentPoolWei + newBetWei;
    
    if (newTotalPoolWei > 0n && newAgentPoolWei > 0n) {
      // 90% goes to bettors (5% agents, 5% treasury)
      const bettorShare = (newTotalPoolWei * 9000n) / 10000n;
      multiplier = Number(bettorShare * 1000n / newAgentPoolWei) / 1000;
    } else if (agent.multiplier && agent.multiplier > 0) {
      // Fallback to backend multiplier if pools are empty
      multiplier = agent.multiplier;
    }
  } catch (err) {
    // Fallback to backend multiplier on error
    multiplier = agent.multiplier && agent.multiplier > 0 ? agent.multiplier : 1;
  }

  const payout = amount * multiplier;
  label.textContent = `If this bot wins: ~${payout.toFixed(3)} ${tokenMeta.symbol} back (after fees)`;
};

/* ================================================================
   Place Bet (on-chain)
   ================================================================ */
window.placeBetOnAgent = async function placeBetOnAgent(agentName, inputIndex) {
  if (!walletAddress || !bettingContract) {
    showToast('Connect your wallet first', 'error');
    return;
  }

  const input = document.getElementById(`bet-input-${inputIndex}`);
  if (!input || !input.value || parseFloat(input.value) <= 0) {
    showToast('Enter a valid bet amount', 'error');
    return;
  }

  const tokenUsed = currentBetToken; // capture at click time
  const amountTyped = input.value;
  const amountWei = ethers.parseEther(amountTyped);

  if (!currentMatchId) {
    showToast('No active match to bet on', 'error');
    return;
  }
  if (currentBettingStatus && currentBettingStatus.status !== 'open') {
    showToast('Betting is not open on-chain yet. Wait for the panel to show OPEN.', 'error');
    return;
  }

  try {
    const tokenMeta = TOKEN_META[tokenUsed] || TOKEN_META.MON;
    showToast(`Placing bet of ${amountTyped} ${tokenMeta.symbol} on ${agentName}...`, 'info');

    const matchIdB32 = ethers.encodeBytes32String(currentMatchId.length > 31 ? currentMatchId.slice(0, 31) : currentMatchId);
    const agentIdB32 = ethers.encodeBytes32String(agentName.length > 31 ? agentName.slice(0, 31) : agentName);

    let tx;
    if (tokenUsed === 'MON') {
      // Native MON bet
      tx = await bettingContract.placeBet(matchIdB32, agentIdB32, { value: amountWei });
    } else {
      // $MClawIO ERC-20 bet: ensure approval then call placeMclawBet
      const erc20Abi = [
        'function allowance(address owner, address spender) view returns (uint256)',
        'function approve(address spender, uint256 amount) returns (bool)',
      ];
      const mclaw = new ethers.Contract(MCLAW_TOKEN_ADDRESS, erc20Abi, signer);
      const allowance = await mclaw.allowance(walletAddress, contractAddress);
      if (allowance < amountWei) {
        showToast(`Approving ${tokenMeta.symbol} for betting contract...`, 'info');
        const approveTx = await mclaw.approve(contractAddress, amountWei);
        await approveTx.wait();
      }
      tx = await bettingContract.placeMclawBet(matchIdB32, agentIdB32, amountWei);
    }
    showToast(`Transaction submitted. Waiting for confirmation...`, 'info');

    const receipt = await tx.wait();
    showToast(`You bet ${amountTyped} ${TOKEN_META[tokenUsed].symbol} on ${agentName}`, 'success');

    // Store bet locally for instant reward calculation
    if (currentMatchId) {
      if (!localBetsByMatch[currentMatchId]) {
        localBetsByMatch[currentMatchId] = [];
      }
      localBetsByMatch[currentMatchId].push({
        agentName,
        amountWei: amountWei.toString(),
        token: tokenUsed,
        txHash: receipt.hash,
        timestamp: Date.now(),
      });
      // Persist to localStorage
      try {
        localStorage.setItem('localBetsByMatch', JSON.stringify(localBetsByMatch));
      } catch (e) {
        console.warn('Failed to persist bets to localStorage:', e);
      }
    }

    // Notify backend so it records the bet in DB
    if (window._bettingSocket) {
      window._bettingSocket.emit('humanBetPlaced', {
        matchId: currentMatchId,
        bettorAddress: walletAddress,
        agentName,
        amountWei: amountWei.toString(),
        token: tokenUsed,
        txHash: receipt.hash,
      });
    }

    input.value = '';
    if (betInputValues[agentName]) {
      delete betInputValues[agentName];
    }
    updateWalletUI();
    // Refresh my bets list
    if (currentMatchId) fetchMyBets(currentMatchId);
  } catch (err) {
    console.error('Bet failed:', err);
    const reason = err.reason || err.message || 'Transaction failed';
    showToast('Bet failed: ' + reason, 'error');
  }
};

/* ================================================================
   Claim Winnings
   ================================================================ */
window.claimWinnings = async function claimWinnings() {
  if (!walletAddress || !bettingContract || !currentMatchId) {
    showToast('Connect wallet first', 'error');
    return;
  }

  try {
    showToast('Claiming winnings...', 'info');
    const matchIdB32 = ethers.encodeBytes32String(currentMatchId.length > 31 ? currentMatchId.slice(0, 31) : currentMatchId);
    const tx = await bettingContract.claim(matchIdB32);
    const receipt = await tx.wait();
    showToast('Winnings claimed successfully!', 'success');
    updateWalletUI();

    // Hide claim section
    const claimSection = document.getElementById('claim-section');
    if (claimSection) claimSection.classList.add('hidden');
  } catch (err) {
    console.error('Claim failed:', err);
    showToast('Claim failed: ' + (err.reason || err.message), 'error');
  }
};

/* ================================================================
   My Bets
   ================================================================ */
async function fetchMyBets(matchId) {
  if (!walletAddress) {
    const list = document.getElementById('my-bets-list');
    if (list) list.innerHTML = '<div class="text-center text-sm font-bold text-slate-400 py-8 bg-slate-800 border-2 border-dashed border-slate-600">Connect wallet to see your bets</div>';
    return;
  }
  const list = document.getElementById('my-bets-list');
  if (!list) return;

  try {
    // Fetch bets and stats for BOTH tokens so we always show the correct token's data
    const res = await fetch(`/api/betting/bets-by-wallet/${walletAddress}`);
    const data = await res.json();
    const betsByToken = data.betsByToken || { MON: [], MCLAW: [] };
    const statsByToken = data.statsByToken || { MON: null, MCLAW: null };
    const allBets = betsByToken[currentBetToken] || [];
    const stats = statsByToken[currentBetToken] || null;

    // ── Stats banner: use stats for the selected token only (backend returns per-token) ──
    let html = '';
    if (stats) {
      const tokenMeta = TOKEN_META[currentBetToken] || TOKEN_META.MON;
      const totalBetWei = BigInt(stats.totalBet || '0');
      const totalPayoutWei = BigInt(stats.totalPayout || '0');
      const profitLossWei = totalPayoutWei - totalBetWei;
      const totalBetStr = weiToMON(totalBetWei.toString());
      const totalPayoutStr = weiToMON(totalPayoutWei.toString());
      const plAbs = profitLossWei >= 0n ? profitLossWei : -profitLossWei;
      const profitLossStr = weiToMON(plAbs.toString());
      const plColor = profitLossWei >= 0n ? (profitLossWei === 0n ? '#94a3b8' : '#22c55e') : '#ef4444';
      const plSign = profitLossWei > 0n ? '+' : (profitLossWei < 0n ? '-' : '');
      html += `
        <div class="grid grid-cols-3 gap-2 mb-3">
          <div class="bg-slate-800 border-2 border-white p-2 text-center">
            <div class="text-[9px] font-bold text-slate-400 uppercase">Total Bet</div>
            <div class="text-sm font-black text-[#facc15]">${escHtml(totalBetStr)} ${tokenMeta.symbol}</div>
          </div>
          <div class="bg-slate-800 border-2 border-white p-2 text-center">
            <div class="text-[9px] font-bold text-slate-400 uppercase">Total Won</div>
            <div class="text-sm font-black text-[#22d3ee]">${escHtml(totalPayoutStr)} ${tokenMeta.symbol}</div>
          </div>
          <div class="bg-slate-800 border-2 border-white p-2 text-center">
            <div class="text-[9px] font-bold text-slate-400 uppercase">P&L</div>
            <div class="text-sm font-black" style="color:${plColor}">${plSign}${escHtml(profitLossStr)} ${tokenMeta.symbol}</div>
          </div>
        </div>
        <div class="flex gap-3 mb-3 text-[10px] font-bold text-slate-400">
          <span>${stats.totalBets} bets</span>
          <span>${stats.totalWins} wins</span>
          <span>${stats.matchesPlayed} matches</span>
        </div>
      `;
    }

    if (!allBets.length) {
      html += '<div class="text-center text-sm font-bold text-slate-400 py-8 bg-slate-800 border-2 border-dashed border-slate-600">No bets placed yet</div>';
      list.innerHTML = html;
      return;
    }

    // ── Bet history grouped by match ──
    const byMatch = {};
    for (const b of allBets) {
      if (!byMatch[b.matchId]) byMatch[b.matchId] = [];
      byMatch[b.matchId].push(b);
    }

    for (const [mId, bets] of Object.entries(byMatch)) {
      const isCurrent = mId === currentMatchId;
      html += `<div class="text-[10px] font-black text-slate-400 uppercase mt-2 mb-1">${escHtml(mId)}${isCurrent ? ' (current)' : ''}</div>`;
      html += bets.map(b => {
        const amtMON = weiToMON(b.amount);
        const tokenMeta = TOKEN_META[currentBetToken] || TOKEN_META.MON;
        return `
          <div class="bg-slate-800 border-2 border-white p-2 flex items-center justify-between">
            <div>
              <span class="text-xs font-black text-[#facc15] uppercase">${escHtml(b.agentName)}</span>
              <span class="text-xs text-slate-400 ml-2">${amtMON} ${tokenMeta.symbol}</span>
            </div>
            ${b.txHash ? `<a href="https://monadvision.com/tx/${b.txHash}" target="_blank" class="text-[10px] text-[#22d3ee] font-mono hover:underline">${b.txHash.slice(0,8)}...</a>` : ''}
          </div>
        `;
      }).join('');
    }

    list.innerHTML = html;
  } catch (err) {
    console.error('Failed to fetch my bets:', err);
  }
}

/* ================================================================
   Leaderboard
   ================================================================ */
async function fetchLeaderboard() {
  const container = document.getElementById('betting-leaderboard');
  if (!container) return;

  try {
    const res = await fetch(`/api/betting/leaderboard?token=${encodeURIComponent(currentBetToken)}`);
    const data = await res.json();
    const leaders = data.leaderboard || [];

    if (!leaders.length) {
      container.innerHTML = '<div class="text-center text-sm font-bold text-slate-400 py-8 bg-slate-800 border-2 border-dashed border-slate-600">No bets placed yet</div>';
      return;
    }

    const tokenMeta = TOKEN_META[currentBetToken] || TOKEN_META.MON;
    container.innerHTML = leaders.slice(0, 20).map((e, i) => {
      const rank = i + 1;
      const rankColors = { 1: '#facc15', 2: '#94a3b8', 3: '#f97316' };
      const color = rankColors[rank] || '#64748b';
      return `
        <div class="bg-slate-800 border-2 border-white p-2 flex items-center gap-3">
          <div class="w-6 h-6 flex items-center justify-center font-black text-xs border-2 border-white" style="background:${color};color:black">${rank}</div>
          <div class="flex-1 min-w-0">
            <div class="text-xs font-black text-white truncate">${escHtml(e.bettorName || shortenAddr(e.bettorAddress))}</div>
            <div class="text-[10px] text-slate-400 font-mono">${shortenAddr(e.bettorAddress)}</div>
          </div>
          <div class="text-right">
            <div class="text-xs font-black text-[#facc15]">${e.totalVolumeMON} ${tokenMeta.symbol}</div>
            <div class="text-[10px] text-slate-400">${e.totalBets} bets / ${e.totalWins} wins</div>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Failed to fetch leaderboard:', err);
  }
}

/* ================================================================
   WebSocket event handlers
   ================================================================ */
function initBettingSocket() {
  // Wait for io to be available (loaded by socket.io script)
  const waitForIo = setInterval(() => {
    if (typeof io === 'undefined') return;
    clearInterval(waitForIo);

    const socket = io();
    window._bettingSocket = socket;

    // Track current match from status events
    socket.on('status', (status) => {
      if (status.currentMatch) {
        const prevMatchId = currentMatchId;
        currentMatchId = status.currentMatch.id;
        // Fetch betting status when match changes or on first load
        if (currentMatchId !== prevMatchId || !currentBettingStatus) {
          fetchBettingStatus(currentMatchId);
        }
      } else {
        currentMatchId = null;
      }

      // Update helper text tying betting state to match lifecycle
      const matchStatusEl = document.getElementById('betting-match-status');
      if (matchStatusEl) {
        if (!status.currentMatch) {
          matchStatusEl.textContent = 'Waiting for next match…';
        } else if (status.currentMatch.phase === 'lobby') {
          const count = status.currentMatch.playerCount || 0;
          matchStatusEl.textContent =
            count < 2
              ? 'Lobby forming – betting will open when 2 bots join.'
              : 'Lobby ready – betting opening shortly.';
        } else if (status.currentMatch.phase === 'active') {
          matchStatusEl.textContent = 'Match in progress – betting locked.';
        } else if (status.currentMatch.phase === 'finished') {
          matchStatusEl.textContent = 'Match finished – next lobby opening soon.';
        }
      }
    });

    socket.on('lobbyOpen', (data) => {
      currentMatchId = data.matchId;
      // Reset UI
      currentBettingStatus = null;
      window.currentBettingStatus = null;
      const list = document.getElementById('betting-list');
      if (list) list.innerHTML = '<div class="text-center text-sm font-bold text-slate-400 py-10 bg-slate-800 border-2 border-dashed border-slate-600">Waiting for players...</div>';
      const claimSection = document.getElementById('claim-section');
      if (claimSection) claimSection.classList.add('hidden');
    });

    // Betting opening (on-chain not confirmed yet – show agents, no bet button)
    socket.on('bettingPending', (data) => {
      currentMatchId = data.matchId;
      showToast('Opening betting… Place your bet once the panel shows OPEN.', 'info');
      if (data.agentNames && data.agentNames.length) {
        const placeholder = {
          matchId: data.matchId,
          status: 'pending',
          totalPool: '0',
          totalPoolMON: '0',
          agents: data.agentNames.map(name => ({
            agentName: name,
            pool: '0',
            poolMON: '0',
            percentage: 0,
            multiplier: 0,
            bettorCount: 0,
          })),
          bettorCount: 0,
        };
        currentBettingStatus = placeholder;
        renderBettingUI(placeholder);
      }
      setTimeout(() => fetchBettingStatus(data.matchId), 500);
    });

    // Betting opened on-chain – users can place bets
    socket.on('bettingOpen', (data) => {
      currentMatchId = data.matchId;
      showToast(`Betting is open for ${data.matchId}!`, 'info');
      if (data.agentNames && data.agentNames.length) {
        const placeholder = {
          matchId: data.matchId,
          status: 'open',
          totalPool: '0',
          totalPoolMON: '0',
          agents: data.agentNames.map(name => ({
            agentName: name,
            pool: '0',
            poolMON: '0',
            percentage: 0,
            multiplier: 0,
            bettorCount: 0,
          })),
          bettorCount: 0,
        };
        currentBettingStatus = placeholder;
        window.currentBettingStatus = placeholder;
        renderBettingUI(placeholder);
      }
      setTimeout(() => fetchBettingStatus(data.matchId), 500);
    });

    // New agent joined the pool (lobby)
    socket.on('bettingAgentsUpdate', (data) => {
      if (data.matchId === currentMatchId && data.agentNames) {
        // Refresh the betting status to include the new agent
        fetchBettingStatus(data.matchId);
      }
    });

    // Real-time odds update (after every bet)
    socket.on('bettingUpdate', (status) => {
      // Ignore updates for a different token than the one currently selected
      if (status.token && status.token !== currentBetToken) {
        return;
      }
      currentBettingStatus = status;
      window.currentBettingStatus = status;
      renderBettingUI(status);
    });

    // Individual bet placed (for toasts)
    socket.on('betPlaced', (data) => {
      // Don't toast our own bets (already handled)
      if (walletAddress && data.bettorAddress === walletAddress.toLowerCase()) return;
      const name = data.bettorName || shortenAddr(data.bettorAddress);
      const tokenMeta = TOKEN_META[data.token || 'MON'] || TOKEN_META.MON;
      showToast(`${name} bet ${data.amountMON} ${tokenMeta.symbol} on ${data.agentName}`, 'neutral');
    });

    // Betting closed
    socket.on('bettingClosed', (data) => {
      showToast('Betting is now locked! Match starting soon...', 'info');
      if (data.matchId === currentMatchId) fetchBettingStatus(currentMatchId);
    });

    // Betting resolved
    socket.on('bettingResolved', (data) => {
      const monPool = data.totalPoolMON || '0';
      const mclawPool = data.totalPoolMclawMON != null ? data.totalPoolMclawMON : (data.totalPoolMclaw ? weiToMON(data.totalPoolMclaw) : '0');
      const parts = [];
      if (parseFloat(monPool) > 0) parts.push(`${monPool} MON`);
      if (parseFloat(mclawPool) > 0) parts.push(`${mclawPool} MClawIO`);
      const poolStr = parts.length ? parts.join(', ') : '0';
      const msg = data.isDraw
        ? `Draw! ${data.winners.join(' & ')} tied. Pool: ${poolStr}`
        : `${data.winners[0]} wins! Pool: ${poolStr}`;
      showToast(msg, 'success');

      if (data.matchId === currentMatchId) {
        fetchBettingStatus(currentMatchId);
      }

      // Track last resolved match for the Results tab
      lastResolvedMatchId = data.matchId;

      // If the Results tab is currently active, refresh it to show this match.
      const resultsPanel = document.getElementById('bet-panel-results');
      if (resultsPanel && !resultsPanel.classList.contains('hidden')) {
        fetchBettingResults(data.matchId);
      }

      // Winnings are now auto-distributed by the server, no manual claim needed.
      // But still check after a delay in case auto-distribution hasn't completed yet.
      if (walletAddress && bettingContract && data.matchId) {
        setTimeout(() => checkClaimable(data.matchId), 10000);
      }

      // Clear generic banner here; center-screen winner overlay will show outcome
      const banner = document.getElementById('betting-result-banner');
      if (banner) {
        banner.classList.add('hidden');
        banner.textContent = '';
      }
    });

    // Auto-distribution: server sends winnings directly to winners
    socket.on('winningsDistributed', (data) => {
      if (walletAddress && data.bettorAddress === walletAddress.toLowerCase()) {
        const tokenMeta = TOKEN_META[data.token || 'MON'] || TOKEN_META.MON;
        const amountLabel = `${data.payoutMON} ${tokenMeta.symbol}`;
        showToast(`You won ${amountLabel}! Auto-sent to your wallet.`, 'success');
        updateWalletUI();
        // Hide claim section since it was auto-claimed
        const claimSection = document.getElementById('claim-section');
        if (claimSection) claimSection.classList.add('hidden');
      }
    });
  }, 200);
}

async function checkClaimable(matchId) {
  if (!bettingContract || !walletAddress) return;
  try {
    const matchIdB32 = ethers.encodeBytes32String(matchId.length > 31 ? matchId.slice(0, 31) : matchId);
    const res = await bettingContract.getClaimableAmounts(matchIdB32, walletAddress);
    const monAmount = res[0];
    const mclawAmount = res[1];
    const total = (monAmount || 0n) + (mclawAmount || 0n);
    if (total > 0n) {
      const parts = [];
      if (monAmount && monAmount > 0n) parts.push(parseFloat(ethers.formatEther(monAmount)).toFixed(4) + ' MON');
      if (mclawAmount && mclawAmount > 0n) parts.push(parseFloat(ethers.formatEther(mclawAmount)).toFixed(4) + ' MClawIO');
      const label = parts.join(' + ');
      const claimSection = document.getElementById('claim-section');
      const claimAmount = document.getElementById('claimable-amount');
      if (claimSection) claimSection.classList.remove('hidden');
      if (claimAmount) claimAmount.textContent = label;
      showToast(`You won ${label}! Claim now.`, 'gold');
    }
  } catch (err) {
    console.error('checkClaimable failed:', err);
  }
}

/* ================================================================
   Match Betting Results (per-wallet, per-token)
   ================================================================ */
async function fetchBettingResults(matchId, depth = 0) {
  const summaryEl = document.getElementById('betting-results-summary');
  const tableEl = document.getElementById('betting-results-table');
  if (!summaryEl || !tableEl) return;

  summaryEl.textContent = `Loading earnings for ${matchId}...`;
  tableEl.innerHTML = '';

  try {
    const res = await fetch(`/api/betting/history/${encodeURIComponent(matchId)}`);
    if (!res.ok) {
      // If this match has no betting history at all, try previous match (up to a small depth).
      if (depth < 10) {
        const prevId = getPreviousMatchId(matchId);
        if (prevId) {
          return fetchBettingResults(prevId, depth + 1);
        }
      }
      summaryEl.textContent = 'No betting data found in recent matches.';
      return;
    }
    const history = await res.json();
    const bets = Array.isArray(history.bets) ? history.bets : [];
    const settlements = Array.isArray(history.settlements) ? history.settlements : [];
    const pool = history.pool || null;
    const winnerNames = pool && pool.winner_agent_names
      ? (Array.isArray(pool.winner_agent_names) ? pool.winner_agent_names : [pool.winner_agent_names])
      : [];
    const winnerSet = new Set(winnerNames);

    const norm = (addr) => (addr || '').toLowerCase();

    // Aggregate per bettor + token (use normalized address so we match regardless of casing)
    const byKey = new Map();
    for (const b of bets) {
      const key = `${norm(b.bettor_address)}|${b.token || 'MON'}`;
      const entry = byKey.get(key) || {
        bettorAddress: (b.bettor_address || '').toLowerCase(),
        bettorName: b.bettor_name,
        token: b.token || 'MON',
        totalBet: 0n,
        totalPayout: 0n,
        betOnWinner: 0n,
      };
      const amt = BigInt(b.amount || '0');
      entry.totalBet += amt;
      if (winnerSet.has(b.agent_name)) entry.betOnWinner += amt;
      byKey.set(key, entry);
    }
    for (const s of settlements) {
      const key = `${norm(s.bettor_address)}|${s.token || 'MON'}`;
      const entry = byKey.get(key) || {
        bettorAddress: (s.bettor_address || '').toLowerCase(),
        bettorName: null,
        token: s.token || 'MON',
        totalBet: 0n,
        totalPayout: 0n,
        betOnWinner: 0n,
      };
      entry.totalPayout += BigInt(s.payout_amount || '0');
      byKey.set(key, entry);
    }

    // When settlements are empty, estimate payouts from bets + winner (90% share)
    if (settlements.length === 0 && winnerSet.size > 0 && bets.length > 0) {
      let monTotalPool = 0n;
      let mclawTotalPool = 0n;
      let monWinnerPool = 0n;
      let mclawWinnerPool = 0n;
      for (const b of bets) {
        const amt = BigInt(b.amount || '0');
        const onWinner = winnerSet.has(b.agent_name);
        if (b.token === 'MCLAW') {
          mclawTotalPool += amt;
          if (onWinner) mclawWinnerPool += amt;
        } else {
          monTotalPool += amt;
          if (onWinner) monWinnerPool += amt;
        }
      }
      for (const entry of byKey.values()) {
        if (entry.totalPayout > 0n) continue; // already from settlement
        const bettorShare = 9000n; // 90%
        if (entry.token === 'MCLAW' && entry.betOnWinner > 0n && mclawWinnerPool > 0n && mclawTotalPool > 0n) {
          entry.totalPayout = (entry.betOnWinner * (mclawTotalPool * bettorShare) / 10000n) / mclawWinnerPool;
        } else if (entry.token !== 'MCLAW' && entry.betOnWinner > 0n && monWinnerPool > 0n && monTotalPool > 0n) {
          entry.totalPayout = (entry.betOnWinner * (monTotalPool * bettorShare) / 10000n) / monWinnerPool;
        }
      }
    }

    if (byKey.size === 0) {
      // No bets on this match; walk back to previous match if possible.
      if (depth < 10) {
        const prevId = getPreviousMatchId(matchId);
        if (prevId) {
          return fetchBettingResults(prevId, depth + 1);
        }
      }
      summaryEl.textContent = 'No bets were placed in recent matches.';
      return;
    }

    const entries = Array.from(byKey.values());
    const formatWei = (n) => {
      const whole = n / 1000000000000000000n;
      const frac = n % 1000000000000000000n;
      const fracStr = frac.toString().padStart(18, '0').slice(0, 4).replace(/0+$/, '');
      return fracStr ? `${whole}.${fracStr}` : whole.toString();
    };

    let monTotal = 0n;
    let mclawTotal = 0n;
    for (const e of entries) {
      if (e.token === 'MCLAW') mclawTotal += e.totalPayout;
      else monTotal += e.totalPayout;
    }
    const baseSummary =
      `Total payouts — MON: ${monTotal > 0n ? formatWei(monTotal) : '--'} | ` +
      `$MClawIO: ${mclawTotal > 0n ? formatWei(mclawTotal) : '--'}`;

    // Agent 5% share (MON only, from betting_pools.agent_payout)
    let agentLine = '';
    if (history.pool && history.pool.agent_payout && history.pool.winner_agent_names && history.pool.winner_agent_names.length) {
      try {
        const agentWei = BigInt(history.pool.agent_payout || '0');
        if (agentWei > 0n) {
          const agentMon = formatWei(agentWei);
          const winnersLabel = Array.isArray(history.pool.winner_agent_names)
            ? history.pool.winner_agent_names.join(', ')
            : String(history.pool.winner_agent_names);
          const winnersSafe = escHtml(winnersLabel);
          agentLine =
            `<br/><span class="text-[10px]">Agent share (5% MON): ` +
            `<span class="font-bold text-[#facc15]">${agentMon} MON</span> → ${winnersSafe}</span>`;
        }
      } catch {
        // ignore formatting errors
      }
    }
    summaryEl.innerHTML = `${escHtml(baseSummary)}${agentLine}`;

    // Sort winners first (payout > 0), then by payout desc
    entries.sort((a, b) => {
      const aWin = a.totalPayout > 0n ? 1 : 0;
      const bWin = b.totalPayout > 0n ? 1 : 0;
      if (bWin !== aWin) return bWin - aWin;
      if (b.totalPayout !== a.totalPayout) return b.totalPayout > a.totalPayout ? 1 : -1;
      return 0;
    });

    tableEl.innerHTML = entries.map((e) => {
      const tokenMeta = TOKEN_META[e.token || 'MON'] || TOKEN_META.MON;
      const bettorLabel = e.bettorName || shortenAddr(e.bettorAddress);
      const betStr = e.totalBet > 0n ? formatWei(e.totalBet) : '0';
      const payoutStr = e.totalPayout > 0n ? formatWei(e.totalPayout) : '0';
      const multiplier = e.totalBet > 0n ? Number(e.totalPayout * 1000n / e.totalBet) / 1000 : 0;
      const multiStr = multiplier > 0 ? `${multiplier.toFixed(2)}x` : '--';
      const isWinner = e.totalPayout > 0n;
      return `
        <div class="bg-slate-800 border-2 border-white p-2 flex items-center justify-between text-[10px] ${isWinner ? 'shadow-[3px_3px_0_#facc15]' : 'shadow-[2px_2px_0_black]'}">
          <div class="flex flex-col min-w-0">
            <span class="font-black text-white truncate">${escHtml(bettorLabel)}</span>
            <span class="font-mono text-slate-400 truncate">${shortenAddr(e.bettorAddress)}</span>
          </div>
          <div class="text-right ml-2">
            <div class="text-slate-300">${betStr} ${tokenMeta.symbol} bet</div>
            <div class="text-slate-300">${payoutStr} ${tokenMeta.symbol} won</div>
            <div class="font-black text-[#facc15]">${multiStr}</div>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Failed to fetch betting results:', err);
    summaryEl.textContent = 'Failed to load match earnings.';
  }
}

// Helper: derive previous match ID (match_123 -> match_122), or null if not parseable.
function getPreviousMatchId(matchId) {
  const m = /^match_(\d+)$/.exec(matchId);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 1) return null;
  return `match_${n - 1}`;
}

/* ================================================================
   Toast Notification System
   ================================================================ */
const MAX_TOASTS = 3;
const TOAST_DURATION = 5000;

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  // Limit visible toasts
  while (container.children.length >= MAX_TOASTS) {
    container.removeChild(container.firstChild);
  }

  const colors = {
    success: 'bg-[#a3e635] text-black border-white',
    error:   'bg-red-500 text-white border-white',
    info:    'bg-[#22d3ee] text-black border-white',
    neutral: 'bg-slate-700 text-white border-slate-500',
    gold:    'bg-[#facc15] text-black border-white',
  };
  const icons = {
    success: '&#10003;',
    error:   '&#10007;',
    info:    '&#9432;',
    neutral: '&#8226;',
    gold:    '&#9733;',
  };

  const toast = document.createElement('div');
  toast.className = `toast ${colors[type] || colors.info} border-2 shadow-[3px_3px_0_black] px-4 py-3 flex items-start gap-2 cursor-pointer`;
  toast.innerHTML = `
    <span class="font-black text-sm flex-shrink-0">${icons[type] || icons.info}</span>
    <span class="text-xs font-bold flex-1">${escHtml(message)}</span>
  `;
  toast.onclick = () => dismissToast(toast);
  container.appendChild(toast);

  // Auto-dismiss
  setTimeout(() => dismissToast(toast), TOAST_DURATION);
}

function dismissToast(el) {
  if (!el || !el.parentNode) return;
  el.classList.add('toast-exit');
  setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
}

/* ================================================================
   Utilities
   ================================================================ */
function shortenAddr(addr) {
  if (!addr) return '';
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

function escHtml(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escAttr(s) {
  return escHtml(s).replace(/'/g, '&#39;');
}

function weiToMON(wei) {
  try {
    const n = BigInt(wei);
    const whole = n / 1000000000000000000n;
    const frac = n % 1000000000000000000n;
    const fracStr = frac.toString().padStart(18, '0').slice(0, 4);
    return fracStr.replace(/0+$/, '') ? `${whole}.${fracStr.replace(/0+$/, '')}` : whole.toString();
  } catch {
    return '0';
  }
}

// Make showToast globally available for other scripts
window.showToast = showToast;

/* ================================================================
   Init
   ================================================================ */
initBettingSocket();
