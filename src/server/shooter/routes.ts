/**
 * REST routes for Claw Shooter (agent-only). Mounted at /api/shooter
 */
import { Router, Request, Response } from 'express';
import { verifyMoltbookAgent, createTestAgent, checkRateLimit } from '../api/auth.js';
import type { ShooterMatchManager } from './match.js';
import { MOVEMENT_SPEED } from './constants.js';

const DEV_MODE = process.env.NODE_ENV !== 'production';

export function createShooterRoutes(shooterMatchManager: ShooterMatchManager): Router {
  const router = Router();

  // Cache building bboxes (static per map, computed once)
  let cachedObstacles: Array<{ minX: number; maxX: number; minZ: number; maxZ: number }> | null = null;
  const getObstacles = () => {
    if (!cachedObstacles) {
      cachedObstacles = shooterMatchManager.getBuildingBBoxes();
    }
    return cachedObstacles;
  };

  const extractApiKey = (req: Request): string | null => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
    return authHeader.slice(7);
  };

  // GET /api/shooter/status - No auth
  router.get('/status', (_req: Request, res: Response) => {
    res.json(shooterMatchManager.getStatus());
  });

  // GET /api/shooter/match/spectator - No auth; read-only state for spectator UI (players, pickups, leaderboard)
  router.get('/match/spectator', (_req: Request, res: Response) => {
    const match = shooterMatchManager.getMatchState();
    if (!match) {
      res.status(404).json({
        success: false,
        error: 'NO_MATCH',
        message: 'No active shooter match',
      });
      return;
    }
    const timeRemaining =
      match.phase === 'active' ? Math.max(0, (match.endTime - Date.now()) / 1000) : 0;
    const playersList = Array.from(match.players.values()).map((p) => ({
      id: p.id,
      name: p.name,
      alive: p.alive,
      x: p.x,
      z: p.z,
      angle: p.angle,
      health: p.health,
      lives: p.lives,
      weapon: p.weapon,
      ammo: p.ammo,
      kills: p.kills,
      score: p.score,
      characterId: p.characterId,
      moving: p.moving,
    }));
    const leaderboard = Array.from(match.players.values())
      .map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score,
        kills: p.kills,
        lives: p.lives,
        alive: p.alive,
      }))
      .sort((a, b) => {
        if (a.alive !== b.alive) return a.alive ? -1 : 1;
        if (b.score !== a.score) return b.score - a.score;
        return b.kills - a.kills;
      });
    res.json({
      matchId: match.id,
      phase: match.phase,
      tick: match.tick,
      timeRemaining,
      arena: { width: 90, height: 90, movementSpeed: MOVEMENT_SPEED * 1000 },
      players: playersList,
      pickups: match.pickups.filter((p) => !p.taken).map((p) => ({ id: p.id, x: p.x, z: p.z, weaponType: p.weaponType })),
      leaderboard,
      obstacles: getObstacles(),
    });
  });

  // POST /api/shooter/match/join - Auth required
  router.post('/match/join', async (req: Request, res: Response) => {
    const apiKey = extractApiKey(req);
    if (!apiKey) {
      res.status(401).json({
        success: false,
        error: 'UNAUTHORIZED',
        message: 'Missing or invalid Authorization header. Use: Bearer YOUR_MOLTBOOK_API_KEY',
      });
      return;
    }

    let agentInfo;
    if (DEV_MODE && apiKey.startsWith('test_')) {
      agentInfo = createTestAgent(apiKey.replace('test_', ''));
    } else {
      agentInfo = await verifyMoltbookAgent(apiKey);
    }

    if (!agentInfo) {
      res.status(401).json({
        success: false,
        error: 'INVALID_API_KEY',
        message: 'Invalid Moltbook API key. Register at https://www.moltbook.com',
      });
      return;
    }

    const body = req.body as { displayName?: string; characterId?: string };
    const result = shooterMatchManager.joinMatch(
      apiKey,
      agentInfo,
      body.displayName,
      body.characterId
    );

    if (!result.success) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  });

  // GET /api/shooter/match/current - Auth required
  router.get('/match/current', async (req: Request, res: Response) => {
    const apiKey = extractApiKey(req);
    if (!apiKey) {
      res.status(401).json({
        success: false,
        error: 'UNAUTHORIZED',
        message: 'Missing Authorization header',
      });
      return;
    }

    const match = shooterMatchManager.getMatchState();
    if (!match) {
      res.status(404).json({
        success: false,
        error: 'NO_MATCH',
        message: 'No active shooter match',
      });
      return;
    }

    const playerInfo = shooterMatchManager.getPlayerByApiKey(apiKey);
    const youPlayer = playerInfo ? match.players.get(playerInfo.id) : undefined;
    const timeRemaining =
      match.phase === 'active' ? Math.max(0, (match.endTime - Date.now()) / 1000) : 0;

    const playersList = Array.from(match.players.values())
      .filter((p) => p.id !== youPlayer?.id)
      .map((p) => ({
        id: p.id,
        name: p.name,
        alive: p.alive,
        x: p.x,
        z: p.z,
        angle: p.angle,
        health: p.health,
        lives: p.lives,
        weapon: p.weapon,
        ammo: p.ammo,
        kills: p.kills,
        score: p.score,
        characterId: p.characterId,
      }));

    const leaderboard = Array.from(match.players.values())
      .map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score,
        kills: p.kills,
        lives: p.lives,
        alive: p.alive,
      }))
      .sort((a, b) => {
        if (a.alive !== b.alive) return a.alive ? -1 : 1;
        if (b.score !== a.score) return b.score - a.score;
        return b.kills - a.kills;
      });

    const you = youPlayer
      ? {
          id: youPlayer.id,
          bodyId: youPlayer.characterId,
          eyesId: '',
          mouthId: '',
          alive: youPlayer.alive,
          x: youPlayer.x,
          z: youPlayer.z,
          angle: youPlayer.angle,
          health: youPlayer.health,
          lives: youPlayer.lives,
          weapon: youPlayer.weapon,
          ammo: youPlayer.ammo,
          kills: youPlayer.kills,
          score: youPlayer.score,
          characterId: youPlayer.characterId,
        }
      : undefined;

    res.json({
      matchId: match.id,
      phase: match.phase,
      tick: match.tick,
      timeRemaining,
      arena: { width: 90, height: 90, movementSpeed: MOVEMENT_SPEED * 1000 },
      you,
      players: playersList,
      pickups: match.pickups.filter((p) => !p.taken).map((p) => ({ id: p.id, x: p.x, z: p.z, weaponType: p.weaponType })),
      leaderboard,
      obstacles: getObstacles(),
    });
  });

  // POST /api/shooter/match/action - Auth required, rate limited
  router.post('/match/action', async (req: Request, res: Response) => {
    const apiKey = extractApiKey(req);
    if (!apiKey) {
      res.status(401).json({
        success: false,
        error: 'UNAUTHORIZED',
        message: 'Missing Authorization header',
      });
      return;
    }

    const rateCheck = checkRateLimit(apiKey);
    if (!rateCheck.allowed) {
      res.status(429).json({
        success: false,
        error: 'RATE_LIMITED',
        message: 'Max 5 actions per second',
        retryAfterMs: rateCheck.retryAfterMs,
      });
      return;
    }

    const playerInfo = shooterMatchManager.getPlayerByApiKey(apiKey);
    if (!playerInfo) {
      res.status(400).json({
        success: false,
        error: 'NOT_IN_MATCH',
        message: 'You are not in an active match. Join first with POST /api/shooter/match/join',
      });
      return;
    }

    const body = req.body as { angle?: number; shoot?: boolean; move?: boolean };
    const action: { angle?: number; shoot?: boolean; move?: boolean } = {};
    if (typeof body.angle === 'number') action.angle = body.angle;
    if (typeof body.shoot === 'boolean') action.shoot = body.shoot;
    if (typeof body.move === 'boolean') action.move = body.move;

    const result = shooterMatchManager.performAction(playerInfo.id, action);
    if (!result.success) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  });

  return router;
}
