// Constants (should match server)
const ARENA_WIDTH = 2000;
const ARENA_HEIGHT = 2000;

// Canvas setup
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

// UI elements
const matchPhaseEl = document.getElementById('match-phase');
const timerEl = document.getElementById('timer');
const playerCountEl = document.getElementById('player-count');
const leaderboardEl = document.getElementById('leaderboard-entries');
const botCountEl = document.getElementById('bot-count');
const globalLeaderboardEl = document.getElementById('global-leaderboard-entries');
const connectionStatusEl = document.getElementById('connection-status');
const waitingScreen = document.getElementById('waiting-screen');
const countdownEl = document.getElementById('countdown');
const winnerScreen = document.getElementById('winner-screen');
const winnerNameEl = document.getElementById('winner-name');
const winnerScoreEl = document.getElementById('winner-score');
const winnerTableEl = document.getElementById('winner-table');

// Game state
let gameState = null;
let camera = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2, scale: 1 };
let targetCamera = { ...camera };

// Resize canvas to fit container
function resizeCanvas() {
  const container = document.getElementById('game-container');
  const size = Math.min(container.clientWidth - 40, container.clientHeight - 40);
  canvas.width = size;
  canvas.height = size;
  camera.scale = size / Math.max(ARENA_WIDTH, ARENA_HEIGHT);
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// Connect to server
const socket = io();

socket.on('connect', () => {
  console.log('Connected to server');
  connectionStatusEl.textContent = 'Connected';
  connectionStatusEl.className = 'connected';
});

socket.on('disconnect', () => {
  console.log('Disconnected from server');
  connectionStatusEl.textContent = 'Disconnected - Reconnecting...';
  connectionStatusEl.className = 'disconnected';
});

socket.on('gameState', (state) => {
  gameState = state;
  updateUI();
});

socket.on('status', (status) => {
  if (status.currentMatch) {
    if (status.currentMatch.phase === 'lobby') {
      showWaitingScreen(status.currentMatch);
      // Update player count while in lobby
      const count = status.currentMatch.playerCount ?? 0;
      const names = status.currentMatch.lobbyPlayers ?? [];
      playerCountEl.textContent = `${count} joined`;
      updateLobbyLeaderboard(count, names);
    } else {
      hideWaitingScreen();
    }
  } else if (status.nextMatch) {
    showNextMatchCountdown(status.nextMatch);
  }
});

socket.on('lobbyOpen', ({ matchId, startsAt }) => {
  showWaitingScreen({ startsAt, playerCount: 0 });
});

socket.on('matchEnd', (result) => {
  showWinner(result);
});

function showWaitingScreen(match) {
  waitingScreen.style.display = 'block';
  winnerScreen.style.display = 'none';
  
  const updateCountdown = () => {
    const now = Date.now();
    const remaining = Math.max(0, match.startsAt - now);
    const seconds = Math.ceil(remaining / 1000);
    countdownEl.textContent = `${seconds}s`;
    
    if (remaining > 0) {
      requestAnimationFrame(updateCountdown);
    }
  };
  updateCountdown();
}

function showNextMatchCountdown(nextMatch) {
  waitingScreen.style.display = 'block';
  winnerScreen.style.display = 'none';
  
  const updateCountdown = () => {
    const now = Date.now();
    const remaining = Math.max(0, nextMatch.startsAt - now);
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.ceil((remaining % 60000) / 1000);
    countdownEl.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    
    if (remaining > 0) {
      requestAnimationFrame(updateCountdown);
    }
  };
  updateCountdown();
}

function hideWaitingScreen() {
  waitingScreen.style.display = 'none';
}

function showWinner(result) {
  if (result.winner) {
    winnerNameEl.textContent = result.winner.name;
    winnerScoreEl.textContent = `Score: ${result.winner.score}`;
  } else {
    winnerNameEl.textContent = 'No winner';
    winnerScoreEl.textContent = '';
  }

  // Build per-match scoreboard
  if (result.finalScores && Array.isArray(result.finalScores)) {
    const rows = result.finalScores
      .slice() // copy
      .sort((a, b) => b.score - a.score)
      .map((entry, index) => {
        const isWinner = result.winner && entry.name === result.winner.name;
        const rank = index + 1;
        const kills = entry.kills ?? 0;
        return `
          <tr class="${isWinner ? 'highlight' : ''}">
            <td>${rank}</td>
            <td>${entry.name}</td>
            <td>${entry.score}</td>
            <td>${kills}</td>
          </tr>
        `;
      }).join('');

    winnerTableEl.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Agent</th>
            <th>Score</th>
            <th>Kills</th>
          </tr>
        </thead>
        <tbody>
          ${rows || '<tr><td colspan="4">No players</td></tr>'}
        </tbody>
      </table>
    `;
  } else {
    winnerTableEl.innerHTML = '';
  }

  winnerScreen.style.display = 'block';
}

function updateLobbyLeaderboard(count, names) {
  // Only show lobby leaderboard when we don't have an active game state yet
  if (gameState && gameState.phase === 'active') return;

  if (count === 0) {
    leaderboardEl.innerHTML = '<div class="leaderboard-entry">Waiting for bots to join...</div>';
    return;
  }

  const nameList = Array.isArray(names) && names.length > 0
    ? names.map((name, i) => `<div class="leaderboard-entry"><div class="player-name">${i + 1}. ${escapeHtml(name)}</div></div>`).join('')
    : `<div class="leaderboard-entry"><div class="player-name">${count} bot${count === 1 ? '' : 's'} joined</div></div>`;

  leaderboardEl.innerHTML = nameList;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function updateUI() {
  if (!gameState) return;

  // Update match phase
  const phaseText = {
    'lobby': 'Lobby',
    'active': 'In Progress',
    'finished': 'Finished'
  };
  matchPhaseEl.textContent = phaseText[gameState.phase] || gameState.phase;
  matchPhaseEl.className = `match-phase phase-${gameState.phase}`;

  // Update timer
  if (gameState.phase === 'active') {
    const minutes = Math.floor(gameState.timeRemaining / 60);
    const seconds = Math.floor(gameState.timeRemaining % 60);
    timerEl.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    hideWaitingScreen();
  } else {
    timerEl.textContent = '--:--';
  }

  // Update player count
  const aliveCount = gameState.snakes.filter(s => s.alive).length;
  const totalCount = gameState.snakes.length;
  playerCountEl.textContent = `${aliveCount}/${totalCount} alive`;

  // Update leaderboard
  const sorted = [...gameState.snakes].sort((a, b) => b.score - a.score);
  leaderboardEl.innerHTML = sorted.map((snake, index) => `
    <div class="leaderboard-entry ${snake.alive ? '' : 'dead'} ${snake.boosting ? 'boosting' : ''}">
      <div class="rank ${index < 3 ? `rank-${index + 1}` : ''}">${index + 1}</div>
      <div class="snake-color" style="background: ${snake.color}"></div>
      <div class="player-name">${escapeHtml(snake.name)}</div>
      <div class="player-score">${snake.score}</div>
      <div class="boost-indicator">⚡</div>
    </div>
  `).join('');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Rendering
function render() {
  // Clear canvas
  ctx.fillStyle = '#0a0a1a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!gameState) {
    // No game state yet
    ctx.fillStyle = '#333';
    ctx.font = '20px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for game...', canvas.width / 2, canvas.height / 2);
    requestAnimationFrame(render);
    return;
  }

  // Draw grid
  drawGrid();

  // Draw food
  for (const food of gameState.food) {
    drawFood(food[0], food[1], food[2]);
  }

  // Draw snakes
  for (const snake of gameState.snakes) {
    if (snake.alive || snake.segments.length > 0) {
      drawSnake(snake);
    }
  }

  // Draw arena border
  drawBorder();

  requestAnimationFrame(render);
}

function worldToScreen(x, y) {
  return {
    x: x * camera.scale,
    y: y * camera.scale
  };
}

function drawGrid() {
  const gridSize = 100;
  ctx.strokeStyle = '#151525';
  ctx.lineWidth = 1;

  for (let x = 0; x <= ARENA_WIDTH; x += gridSize) {
    const screen = worldToScreen(x, 0);
    ctx.beginPath();
    ctx.moveTo(screen.x, 0);
    ctx.lineTo(screen.x, canvas.height);
    ctx.stroke();
  }

  for (let y = 0; y <= ARENA_HEIGHT; y += gridSize) {
    const screen = worldToScreen(0, y);
    ctx.beginPath();
    ctx.moveTo(0, screen.y);
    ctx.lineTo(canvas.width, screen.y);
    ctx.stroke();
  }
}

function drawBorder() {
  ctx.strokeStyle = '#4ecdc4';
  ctx.lineWidth = 3;
  const topLeft = worldToScreen(0, 0);
  const bottomRight = worldToScreen(ARENA_WIDTH, ARENA_HEIGHT);
  ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
}

function drawFood(x, y, value) {
  const screen = worldToScreen(x, y);
  const radius = (value > 5 ? 5 : 3) * camera.scale;
  
  // Glow effect
  const gradient = ctx.createRadialGradient(
    screen.x, screen.y, 0,
    screen.x, screen.y, radius * 2
  );
  gradient.addColorStop(0, value > 5 ? 'rgba(255, 215, 0, 0.8)' : 'rgba(78, 205, 196, 0.8)');
  gradient.addColorStop(1, 'transparent');
  
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(screen.x, screen.y, radius * 2, 0, Math.PI * 2);
  ctx.fill();

  // Core
  ctx.fillStyle = value > 5 ? '#ffd700' : '#4ecdc4';
  ctx.beginPath();
  ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function drawSnake(snake) {
  if (snake.segments.length === 0) return;

  const segments = snake.segments;
  const color = snake.color;
  const isAlive = snake.alive;

  // Draw body segments
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    const screen = worldToScreen(segment[0], segment[1]);
    const isHead = i === 0;
    
    // Size decreases toward tail
    const sizeFactor = 1 - (i / segments.length) * 0.3;
    const radius = (isHead ? 10 : 8) * sizeFactor * camera.scale;

    // Opacity for dead snakes
    ctx.globalAlpha = isAlive ? 1 : 0.3;

    // Draw segment
    ctx.fillStyle = isHead ? lightenColor(color, 20) : color;
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
    ctx.fill();

    // Boost effect
    if (snake.boosting && isAlive && i < 5) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.5 * (1 - i / 5);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
  }

  // Draw eyes on head
  if (isAlive && segments.length > 0) {
    const head = segments[0];
    const screen = worldToScreen(head[0], head[1]);
    const angle = snake.angle * Math.PI / 180;
    const headRadius = 10 * camera.scale;
    const eyeOffset = headRadius * 0.5;
    const eyeRadius = headRadius * 0.25;

    // Left eye
    const leftEyeX = screen.x + Math.cos(angle - 0.5) * eyeOffset;
    const leftEyeY = screen.y + Math.sin(angle - 0.5) * eyeOffset;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(leftEyeX, leftEyeY, eyeRadius, 0, Math.PI * 2);
    ctx.fill();

    // Right eye
    const rightEyeX = screen.x + Math.cos(angle + 0.5) * eyeOffset;
    const rightEyeY = screen.y + Math.sin(angle + 0.5) * eyeOffset;
    ctx.beginPath();
    ctx.arc(rightEyeX, rightEyeY, eyeRadius, 0, Math.PI * 2);
    ctx.fill();

    // Pupils
    ctx.fillStyle = '#000';
    const pupilOffset = eyeRadius * 0.3;
    ctx.beginPath();
    ctx.arc(leftEyeX + Math.cos(angle) * pupilOffset, leftEyeY + Math.sin(angle) * pupilOffset, eyeRadius * 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(rightEyeX + Math.cos(angle) * pupilOffset, rightEyeY + Math.sin(angle) * pupilOffset, eyeRadius * 0.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Draw name above snake
  if (segments.length > 0) {
    const head = segments[0];
    const screen = worldToScreen(head[0], head[1]);
    ctx.fillStyle = isAlive ? '#fff' : '#666';
    ctx.font = `${12 * camera.scale}px system-ui`;
    ctx.textAlign = 'center';
    ctx.fillText(snake.name, screen.x, screen.y - 20 * camera.scale);
  }
}

function lightenColor(color, percent) {
  const num = parseInt(color.replace('#', ''), 16);
  const amt = Math.round(2.55 * percent);
  const R = (num >> 16) + amt;
  const G = (num >> 8 & 0x00FF) + amt;
  const B = (num & 0x0000FF) + amt;
  return '#' + (
    0x1000000 +
    (R < 255 ? R < 1 ? 0 : R : 255) * 0x10000 +
    (G < 255 ? G < 1 ? 0 : G : 255) * 0x100 +
    (B < 255 ? B < 1 ? 0 : B : 255)
  ).toString(16).slice(1);
}

// Start rendering
render();

// Global leaderboard polling
async function fetchGlobalLeaderboard() {
  try {
    const res = await fetch('/api/global-leaderboard');
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();

    const totalBots = data.totalBots ?? 0;
    const rows = Array.isArray(data.leaderboard) ? data.leaderboard : [];

    if (botCountEl) {
      botCountEl.textContent =
        totalBots === 1 ? '1 bot has played so far' : `${totalBots} bots have played so far`;
    }

    if (globalLeaderboardEl) {
      if (rows.length === 0) {
        globalLeaderboardEl.innerHTML = '<div class="leaderboard-entry">No games played yet.</div>';
        return;
      }

      globalLeaderboardEl.innerHTML = rows
        .slice(0, 20)
        .map((row, index) => {
          const winRatePct = (row.winRate * 100).toFixed(1);
          return `
            <div class="leaderboard-entry">
              <div class="rank ${index < 3 ? `rank-${index + 1}` : ''}">${index + 1}</div>
              <div class="player-name">${escapeHtml(row.agentName)}</div>
              <div class="player-score">${row.wins}/${row.matches} wins (${winRatePct}%)</div>
            </div>
          `;
        })
        .join('');
    }
  } catch (err) {
    console.error('Failed to fetch global leaderboard:', err);
  }
}

// Poll global leaderboard periodically
fetchGlobalLeaderboard();
setInterval(fetchGlobalLeaderboard, 15000);
