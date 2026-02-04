import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
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
║                    🐍 AGENT SLITHER ARENA 🐍                   ║
╠══════════════════════════════════════════════════════════════╣
║  Server running on http://localhost:${PORT}                      ║
║                                                              ║
║  Spectator view: http://localhost:${PORT}                        ║
║  API Status:     http://localhost:${PORT}/api/status             ║
║                                                              ║
║  Mode: ${DEV_MODE ? 'DEVELOPMENT (test keys allowed)' : 'PRODUCTION'}                       ║
╚══════════════════════════════════════════════════════════════╝
  `);

  // Start the match scheduler
  matchManager.start();
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
