import { AgentInfo } from '../../shared/types.js';

const MOLTBOOK_API_URL = 'https://www.moltbook.com/api/v1';

// Cache verified agents for a short time to reduce API calls
const agentCache = new Map<string, { info: AgentInfo; expiry: number }>();
const CACHE_DURATION = 60 * 1000; // 1 minute

export async function verifyMoltbookAgent(apiKey: string): Promise<AgentInfo | null> {
  // Check cache first
  const cached = agentCache.get(apiKey);
  if (cached && cached.expiry > Date.now()) {
    return cached.info;
  }

  try {
    const response = await fetch(`${MOLTBOOK_API_URL}/agents/me`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      console.log(`Moltbook auth failed: ${response.status}`);
      return null;
    }

    const data = await response.json();
    
    // Extract agent info from Moltbook response
    const agentInfo: AgentInfo = {
      name: data.name || data.agent?.name || 'Unknown Agent',
      description: data.description || data.agent?.description,
      moltbookId: data.id || data.agent?.id,
    };

    // Cache the result
    agentCache.set(apiKey, {
      info: agentInfo,
      expiry: Date.now() + CACHE_DURATION,
    });

    return agentInfo;
  } catch (error) {
    console.error('Error verifying Moltbook agent:', error);
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

// Clean up old rate limit entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, limit] of rateLimits) {
    if (now - limit.windowStart > RATE_LIMIT_WINDOW * 2) {
      rateLimits.delete(key);
    }
  }
}, 10000);
