import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { MatchManager } from './game/match.js';
import { createRoutes } from './api/routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 3000;
const DEV_MODE = process.env.NODE_ENV !== 'production';

// Initialize Express
const app = express();
const httpServer = createServer(app);

// Initialize Socket.IO for spectators
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: DEV_MODE ? '*' : undefined,
    methods: ['GET', 'POST'],
  },
});

// Middleware
app.use(cors());
app.use(express.json());

// Serve OpenClaw skill documentation so agents can discover rules/controls
app.get('/skill.md', (req, res) => {
  res.type('text/markdown');
  res.sendFile(join(__dirname, '../../SKILL.md'));
});

// Serve static files (spectator frontend)
app.use(express.static(join(__dirname, '../../public')));

// Initialize match manager
const matchManager = new MatchManager();

// API routes
app.use('/api', createRoutes(matchManager));

// WebSocket connection for spectators
io.on('connection', (socket) => {
  console.log(`Spectator connected: ${socket.id}`);

  // Send current state immediately
  const state = matchManager.getSpectatorState();
  if (state) {
    socket.emit('gameState', state);
  }

  // Send server status
  socket.emit('status', matchManager.getStatus());

  socket.on('disconnect', () => {
    console.log(`Spectator disconnected: ${socket.id}`);
  });
});

// Set up match manager callbacks
matchManager.onStateUpdate((state) => {
  io.emit('gameState', state);
});

matchManager.onMatchEndEvent((result) => {
  io.emit('matchEnd', result);
});

matchManager.onLobbyOpen((matchId, startsAt) => {
  io.emit('lobbyOpen', { matchId, startsAt });
  io.emit('status', matchManager.getStatus());
});

// Emit updated status whenever something about the lobby/match changes (e.g. players join)
matchManager.onStatusChange(() => {
  io.emit('status', matchManager.getStatus());
});

// Start server
httpServer.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                          🐍 CLAW IO 🐍                         ║
╠══════════════════════════════════════════════════════════════╣
║  Server running on http://localhost:${PORT}                      ║
║                                                              ║
║  Spectator view: http://localhost:${PORT}                        ║
║  API Status:     http://localhost:${PORT}/api/status             ║
║                                                              ║
║  Mode: ${DEV_MODE ? 'DEVELOPMENT (test keys allowed)' : 'PRODUCTION'}                       ║
╚══════════════════════════════════════════════════════════════╝
  `);

  // Start the match scheduler (async initialization)
  matchManager.start().catch((err) => {
    console.error('Failed to start match manager:', err);
  });

  // When RUN_HOUSE_BOTS is set, spawn the house-bots script so the lobby always has 5 bots (no separate process needed on deploy)
  const runHouseBots = process.env.RUN_HOUSE_BOTS === 'true' || process.env.RUN_HOUSE_BOTS === '1';
  if (runHouseBots) {
    const scriptPath = join(process.cwd(), 'scripts', 'run-house-bots.js');
    const houseBotsUrl = process.env.HOUSE_BOTS_BASE_URL || process.env.BASE_URL || `http://127.0.0.1:${PORT}`;
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, BASE_URL: houseBotsUrl, HOUSE_BOTS_QUIET: '1' },
      stdio: 'inherit',
    });
    child.on('error', (err) => console.error('[House bots] Failed to start:', err));
    child.on('exit', (code) => console.warn('[House bots] Exited with code', code));
    console.log(`[House bots] Started (BASE_URL=${houseBotsUrl})`);
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  matchManager.stop();
  httpServer.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
