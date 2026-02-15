import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { MatchManager } from './game/match.js';
import { createRoutes } from './api/routes.js';
import { createBettingRoutes } from './betting/routes.js';
import { createNftRoutes } from './nft/routes.js';
import { setEmitter } from './betting/service.js';
import { getProceduralBodyBuffer, getProceduralEyesBuffer, getProceduralMouthBuffer } from './snakeGenerator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 3000;
const DEV_MODE = process.env.NODE_ENV !== 'production';

// Initialize Express
const app = express();
const httpServer = createServer(app);

// Initialize Socket.IO for spectators – with memory-safe defaults
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: DEV_MODE ? '*' : undefined,
    methods: ['GET', 'POST'],
  },
  // ── Memory-safety settings ────────────────────────────────────────
  maxHttpBufferSize: 1e6,            // 1 MB max incoming message
  pingTimeout: 10_000,               // disconnect unresponsive clients faster
  pingInterval: 15_000,              // check liveness more often
  connectTimeout: 10_000,            // refuse slow handshakes
  perMessageDeflate: false,          // disable compression (CPU cost, can buffer)
  httpCompression: false,
  // Cap per-client write buffer: if a client falls behind, disconnect it
  // instead of buffering GBs of stale game state.
  connectionStateRecovery: { maxDisconnectionDuration: 30_000 },
});

// Middleware
app.use(cors());
app.use(express.json());

// Procedural skin images (must be before static so they take precedence)
function decodeProceduralAgent(agent: string): string {
  return decodeURIComponent(agent.replace(/\.png$/i, '')).replace(/[/\\]/g, '_') || 'agent';
}
app.get('/skins/Body/Procedural/:agent', async (req, res) => {
  try {
    const agentName = decodeProceduralAgent(req.params.agent);
    const buffer = await getProceduralBodyBuffer(agentName);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(buffer);
  } catch {
    res.status(404).send('Not found');
  }
});
app.get('/skins/Eyes/Procedural/:agent', async (req, res) => {
  try {
    const agentName = decodeProceduralAgent(req.params.agent);
    const buffer = await getProceduralEyesBuffer(agentName);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(buffer);
  } catch {
    res.status(404).send('Not found');
  }
});
app.get('/skins/Mouth/Procedural/:agent', async (req, res) => {
  try {
    const agentName = decodeProceduralAgent(req.params.agent);
    const buffer = await getProceduralMouthBuffer(agentName);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(buffer);
  } catch {
    res.status(404).send('Not found');
  }
});

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
app.use('/api/betting', createBettingRoutes());
app.use('/api', createNftRoutes());

// Wire betting service WebSocket emitter so betting events are broadcast to spectators
setEmitter((event: string, data: any) => {
  io.emit(event, data);
});

// ── Socket.IO memory protection ─────────────────────────────────────
const MAX_CONNECTIONS = 200;

// WebSocket connection for spectators
io.on('connection', (socket) => {
  // Enforce max connections to prevent unbounded memory growth
  const connectedCount = io.engine?.clientsCount ?? io.sockets.sockets.size;
  if (connectedCount > MAX_CONNECTIONS) {
    socket.disconnect(true);
    return;
  }

  // Send current state immediately
  const state = matchManager.getSpectatorState();
  if (state) {
    socket.emit('gameState', state);
  }

  // Send server status
  socket.emit('status', matchManager.getStatus());

  // Detect slow clients: if write buffer exceeds threshold, disconnect them.
  // This prevents a single slow client from accumulating GBs of buffered game state.
  const transport = (socket.conn as any);
  if (transport) {
    const origWrite = transport.send;
    if (typeof origWrite === 'function') {
      transport.send = function (...args: any[]) {
        if (transport.writeBuffer && transport.writeBuffer.length > 50) {
          // > 50 queued packets = client is severely behind; disconnect
          console.warn(`[ws] Disconnecting slow client ${socket.id} (${transport.writeBuffer.length} buffered packets)`);
          socket.disconnect(true);
          return;
        }
        return origWrite.apply(transport, args);
      };
    }
  }

  // Handle human bet notification (frontend sends this after successful on-chain tx)
  socket.on('humanBetPlaced', async (data: {
    matchId: string;
    bettorAddress: string;
    agentName: string;
    amountWei: string;
    txHash: string;
    token?: 'MON' | 'MCLAW';
  }) => {
    try {
      const { placeBet } = await import('./betting/service.js');
      await placeBet({
        bettorAddress: data.bettorAddress,
        bettorType: 'human',
        bettorName: null,
        matchId: data.matchId,
        agentName: data.agentName,
        amountWei: data.amountWei,
        token: data.token === 'MCLAW' ? 'MCLAW' : 'MON',
        txHash: data.txHash,
      });
    } catch (err) {
      console.error('[ws] humanBetPlaced handler failed:', err);
    }
  });

  socket.on('disconnect', () => {
    // no-op (removed verbose logging to reduce log volume)
  });
});

// Set up match manager callbacks
// Throttle gameState broadcasts to ~10 Hz (every other tick) to halve memory/egress.
// Use volatile.emit so Socket.IO drops frames for slow clients instead of buffering.
let tickCounter = 0;
matchManager.onStateUpdate((state) => {
  tickCounter++;
  if (tickCounter % 2 === 0) {
    io.volatile.emit('gameState', state);
  }
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
