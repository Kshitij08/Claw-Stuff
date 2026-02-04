import { Router, Request, Response } from 'express';
import { MatchManager } from '../game/match.js';
import { getGlobalLeaderboard } from '../db.js';
import { verifyMoltbookAgent, createTestAgent, checkRateLimit } from './auth.js';
import {
  JoinRequest,
  ActionRequest,
  GameStateResponse,
} from '../../shared/types.js';
import { ARENA_WIDTH, ARENA_HEIGHT } from '../../shared/constants.js';

const DEV_MODE = process.env.NODE_ENV !== 'production';

export function createRoutes(matchManager: MatchManager): Router {
  const router = Router();

  // Middleware to extract API key
  const extractApiKey = (req: Request): string | null => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return null;
    }
    return authHeader.slice(7);
  };

  // GET /api/status - No auth required
  router.get('/status', (req: Request, res: Response) => {
    const status = matchManager.getStatus();
    res.json(status);
  });

  // POST /api/match/join - Requires Moltbook auth
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

    // Verify with Moltbook (or use test mode)
    let agentInfo;
    if (DEV_MODE && apiKey.startsWith('test_')) {
      // Allow test keys in dev mode
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

    const body = req.body as JoinRequest;
    const result = matchManager.joinMatch(apiKey, agentInfo, body.displayName, body.color);

    if (!result.success) {
      res.status(400).json(result);
      return;
    }

    res.json(result);
  });

  // GET /api/match/current - Requires auth
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

    const match = matchManager.getMatchState();
    if (!match) {
      res.status(404).json({
        success: false,
        error: 'NO_MATCH',
        message: 'No active match',
      });
      return;
    }

    // Find the player by API key
    const player = matchManager.getPlayerByApiKey(apiKey);
    const snake = player ? match.snakes.get(player.id) : undefined;

    const timeRemaining = Math.max(0, (match.endTime - Date.now()) / 1000);

    const response: GameStateResponse = {
      matchId: match.id,
      phase: match.phase,
      tick: match.tick,
      timeRemaining,
      arena: {
        width: ARENA_WIDTH,
        height: ARENA_HEIGHT,
      },
      you: snake
        ? {
            id: snake.id,
            alive: snake.alive,
            x: snake.segments[0]?.x ?? 0,
            y: snake.segments[0]?.y ?? 0,
            angle: snake.angle,
            speed: snake.speed,
            boosting: snake.boosting,
            length: snake.segments.length,
            score: snake.score,
            segments: snake.segments.map(s => [s.x, s.y] as [number, number]),
          }
        : undefined,
      players: Array.from(match.snakes.values())
        .filter(s => s.id !== snake?.id)
        .map(s => ({
          id: s.id,
          name: s.name,
          alive: s.alive,
          x: s.segments[0]?.x ?? 0,
          y: s.segments[0]?.y ?? 0,
          angle: s.angle,
          speed: s.speed,
          boosting: s.boosting,
          length: s.segments.length,
          score: s.score,
          segments: s.segments.map(seg => [seg.x, seg.y] as [number, number]),
          killedBy: s.killedBy,
          deathTick: s.deathTick,
        })),
      food: match.food.map(f => ({ x: f.x, y: f.y, value: f.value })),
      leaderboard: Array.from(match.snakes.values())
        .map(s => ({ id: s.id, name: s.name, score: s.score }))
        .sort((a, b) => b.score - a.score),
    };

    res.json(response);
  });

  // POST /api/match/action - Requires auth, rate limited
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

    // Check rate limit
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

    // Find the player
    const player = matchManager.getPlayerByApiKey(apiKey);
    if (!player) {
      res.status(400).json({
        success: false,
        error: 'NOT_IN_MATCH',
        message: 'You are not in an active match. Join first with POST /api/match/join',
      });
      return;
    }

    const body = req.body as ActionRequest;
    const result = matchManager.performAction(
      player.id,
      body.action,
      body.angle,
      body.angleDelta,
      body.boost,
      body.active
    );

    if (!result.success) {
      res.status(400).json(result);
      return;
    }

    res.json(result);
  });

  // GET /api/leaderboard - No auth required
  router.get('/leaderboard', (req: Request, res: Response) => {
    const leaderboard = matchManager.getLeaderboard();
    res.json(leaderboard);
  });

  // GET /api/global-leaderboard - No auth required
  router.get('/global-leaderboard', async (req: Request, res: Response) => {
    try {
      const data = await getGlobalLeaderboard();
      res.json(data);
    } catch (err) {
      console.error('[api] /api/global-leaderboard failed:', err);
      res.status(500).json({
        success: false,
        error: 'INTERNAL_ERROR',
        message: 'Failed to load global leaderboard',
      });
    }
  });

  return router;
}
