/**
 * REST API routes for the claw-shooter multiplayer game.
 *
 * All agent-facing endpoints mirror the claw-snake API style:
 *  GET  /api/shooter/status    — Match phase, time, player count (no auth)
 *  POST /api/shooter/join      — Join lobby (Moltbook auth)
 *  GET  /api/shooter/state     — Full game state for calling agent
 *  POST /api/shooter/action    — Queue a game action (move/shoot/melee/pickup/stop)
 */

import { Router, Request, Response } from 'express';
import { ShooterMatchManager } from './match.js';
import { verifyMoltbookAgent, createTestAgent, checkRateLimit } from '../api/auth.js';
import type { ShooterActionRequest } from '../../shared/shooter-types.js';

const DEV_MODE = process.env.NODE_ENV !== 'production';

const VALID_ACTIONS = new Set(['move', 'shoot', 'melee', 'pickup', 'stop']);

export function createShooterRoutes(matchManager: ShooterMatchManager): Router {
  const router = Router();

  // ── Helper: extract Bearer token ──────────────────────────────────
  const extractApiKey = (req: Request): string | null => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
    return authHeader.slice(7);
  };

  // ── GET /status — no auth ─────────────────────────────────────────
  router.get('/status', (_req: Request, res: Response) => {
    res.json(matchManager.getStatus());
  });

  // ── POST /join — requires Moltbook auth ───────────────────────────
  router.post('/join', async (req: Request, res: Response) => {
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
        message: 'Invalid Moltbook API key.',
      });
      return;
    }

    const { displayName, strategyTag } = req.body || {};

    const result = matchManager.joinMatch(
      apiKey,
      { name: agentInfo.name, description: agentInfo.description, moltbookId: agentInfo.moltbookId },
      displayName,
      strategyTag,
    );

    res.status(result.success ? 200 : 400).json(result);
  });

  // ── GET /state — requires Moltbook auth ───────────────────────────
  router.get('/state', async (req: Request, res: Response) => {
    const apiKey = extractApiKey(req);
    if (!apiKey) {
      res.status(401).json({
        success: false,
        error: 'UNAUTHORIZED',
        message: 'Missing Authorization header.',
      });
      return;
    }

    // Lightweight auth: in dev mode accept test keys, otherwise verify
    let valid = false;
    if (DEV_MODE && apiKey.startsWith('test_')) {
      valid = true;
    } else {
      const agentInfo = await verifyMoltbookAgent(apiKey);
      valid = agentInfo !== null;
    }

    if (!valid) {
      res.status(401).json({
        success: false,
        error: 'INVALID_API_KEY',
        message: 'Invalid Moltbook API key.',
      });
      return;
    }

    const state = matchManager.getGameStateForPlayer(apiKey);
    if (!state) {
      res.json({
        matchId: null,
        phase: 'lobby',
        tick: 0,
        timeRemaining: 0,
        arena: { minX: -45, maxX: 45, minZ: -45, maxZ: 45 },
        players: [],
        weaponPickups: [],
        leaderboard: [],
      });
      return;
    }

    res.json(state);
  });

  // ── POST /action — requires Moltbook auth + rate limit ────────────
  router.post('/action', async (req: Request, res: Response) => {
    const apiKey = extractApiKey(req);
    if (!apiKey) {
      res.status(401).json({
        success: false,
        error: 'UNAUTHORIZED',
        message: 'Missing Authorization header.',
      });
      return;
    }

    // Rate limit
    const rl = checkRateLimit(apiKey);
    if (!rl.allowed) {
      res.status(429).json({
        success: false,
        error: 'RATE_LIMITED',
        message: 'Max 10 actions per second',
        retryAfterMs: rl.retryAfterMs,
      });
      return;
    }

    // Resolve player ID
    const playerId = matchManager.getPlayerIdByApiKey(apiKey);
    if (!playerId) {
      res.status(400).json({
        success: false,
        error: 'NOT_IN_MATCH',
        message: 'You have not joined the current match. POST /api/shooter/join first.',
      });
      return;
    }

    const body = req.body as ShooterActionRequest;
    if (!body || !body.action || !VALID_ACTIONS.has(body.action)) {
      res.status(400).json({
        success: false,
        error: 'INVALID_ACTION',
        message: `Invalid action. Must be one of: ${[...VALID_ACTIONS].join(', ')}`,
      });
      return;
    }

    const result = matchManager.queueAction(playerId, body);
    res.status(result.success ? 200 : 400).json(result);
  });

  return router;
}
