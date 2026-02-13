import { AgentInfo } from '../../shared/types.js';

const MOLTBOOK_API_URL = 'https://www.moltbook.com/api/v1';

// Cache verified agents for a short time to reduce API calls
const agentCache = new Map<string, { info: AgentInfo; expiry: number }>();
const CACHE_DURATION = 60 * 1000; // 1 minute

// Cache failed auth briefly to avoid hammering Moltbook and spamming logs (e.g. bad house-bot key every 6s)
const failedAuthCache = new Map<string, number>();
const FAILED_AUTH_CACHE_MS = 5 * 60 * 1000; // 5 minutes
const FAILED_AUTH_LOG_INTERVAL_MS = 60 * 1000; // log at most once per key per minute
let lastFailedLogByKey = new Map<string, number>();

export async function verifyMoltbookAgent(apiKey: string): Promise<AgentInfo | null> {
  const now = Date.now();

  // Check success cache first
  const cached = agentCache.get(apiKey);
  if (cached && cached.expiry > now) {
    return cached.info;
  }

  // If we recently saw this key fail, return null without calling Moltbook or logging every time
  const failedExpiry = failedAuthCache.get(apiKey);
  if (failedExpiry != null && failedExpiry > now) {
    return null;
  }

  try {
    const response = await fetch(`${MOLTBOOK_API_URL}/agents/me`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      // IMPORTANT: Always consume or cancel the response body to free the underlying
      // socket/buffer. Leaving it unconsumed leaks native memory in Node.js fetch/undici.
      response.body?.cancel().catch(() => {});
      // Cache failure so we don't spam Moltbook and logs (e.g. house bots with bad key every 6s)
      failedAuthCache.set(apiKey, now + FAILED_AUTH_CACHE_MS);
      const lastLog = lastFailedLogByKey.get(apiKey) ?? 0;
      if (now - lastLog >= FAILED_AUTH_LOG_INTERVAL_MS) {
        console.warn(`Moltbook auth failed: ${response.status} (caching failure for ${FAILED_AUTH_CACHE_MS / 60000} min to reduce log spam)`);
        lastFailedLogByKey.set(apiKey, now);
      }
      return null;
    }

    const data = await response.json();

    // Extract agent info from Moltbook response
    const agentInfo: AgentInfo = {
      name: data.name || data.agent?.name || 'Unknown Agent',
      description: data.description || data.agent?.description,
      moltbookId: data.id || data.agent?.id,
    };

    // Cache the result and clear any previous failure for this key
    agentCache.set(apiKey, {
      info: agentInfo,
      expiry: now + CACHE_DURATION,
    });
    failedAuthCache.delete(apiKey);
    lastFailedLogByKey.delete(apiKey);

    return agentInfo;
  } catch (error) {
    failedAuthCache.set(apiKey, now + FAILED_AUTH_CACHE_MS);
    const lastLog = lastFailedLogByKey.get(apiKey) ?? 0;
    if (now - lastLog >= FAILED_AUTH_LOG_INTERVAL_MS) {
      console.error('Error verifying Moltbook agent:', error);
      lastFailedLogByKey.set(apiKey, now);
    }
    return null;
  }
}

// For development/testing without Moltbook
export function createTestAgent(name: string): AgentInfo {
  return {
    name,
    description: 'Test agent',
    moltbookId: `test_${Date.now()}`,
  };
}

// Rate limiting per API key
const rateLimits = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT_WINDOW = 1000; // 1 second
const MAX_REQUESTS_PER_WINDOW = 5;

export function checkRateLimit(apiKey: string): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  const limit = rateLimits.get(apiKey);

  if (!limit || now - limit.windowStart >= RATE_LIMIT_WINDOW) {
    // New window
    rateLimits.set(apiKey, { count: 1, windowStart: now });
    return { allowed: true };
  }

  if (limit.count >= MAX_REQUESTS_PER_WINDOW) {
    const retryAfterMs = RATE_LIMIT_WINDOW - (now - limit.windowStart);
    return { allowed: false, retryAfterMs };
  }

  limit.count++;
  return { allowed: true };
}

// Clean up old rate limit, agent cache, failed-auth cache, and log-throttle entries periodically (reduces memory growth)
const CLEANUP_INTERVAL_MS = 10 * 1000; // 10 seconds
setInterval(() => {
  const now = Date.now();
  for (const [key, limit] of rateLimits) {
    if (now - limit.windowStart > RATE_LIMIT_WINDOW * 2) {
      rateLimits.delete(key);
    }
  }
  for (const [key, entry] of agentCache) {
    if (entry.expiry <= now) agentCache.delete(key);
  }
  for (const [key, expiry] of failedAuthCache) {
    if (expiry <= now) failedAuthCache.delete(key);
  }
  for (const [key, lastLog] of lastFailedLogByKey) {
    if (now - lastLog > FAILED_AUTH_LOG_INTERVAL_MS * 2) lastFailedLogByKey.delete(key);
  }
}, CLEANUP_INTERVAL_MS);
