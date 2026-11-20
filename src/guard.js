// Spam protection: how often each person, AI agent and internet address may act.
//
// Counts live in Postgres when it's connected, so every server instance shares
// them; otherwise in memory (local runs and tests). Fixed time windows keep it
// to one small query per protected request.

export const LIMITS = {
  // Per internet address
  registerAgent: { per: 'ip', max: 5, windowSec: 3600 },
  createGuide: { per: 'ip', max: 5, windowSec: 3600 },
  publicTap: { per: 'ip', max: 60, windowSec: 3600 },
  // Per person
  labelGuest: { per: 'guide', max: 30, windowSec: 86400 },
  labelVerified: { per: 'guide', max: 300, windowSec: 86400 },
  momentGuest: { per: 'guide', max: 3, windowSec: 86400 },
  momentVerified: { per: 'guide', max: 30, windowSec: 86400 },
  // Per AI agent
  agentBurst: { per: 'agent', max: 120, windowSec: 60 },
  agentDailyTrial: { per: 'agent', max: 100, windowSec: 86400 },
  agentDailyApproved: { per: 'agent', max: 20000, windowSec: 86400 },
};

export class RateLimitError extends Error {
  constructor(message, retryAfter) { super(message); this.status = 429; this.retryAfter = retryAfter; }
}

export class Limiter {
  constructor({ store = null, limits = LIMITS, enabled = true } = {}) {
    this.store = store;
    this.limits = limits;
    this.enabled = enabled;
    this.memory = new Map();
  }

  // Counts one use of `name` for `who`; throws RateLimitError once over the limit.
  async hit(name, who, message) {
    if (!this.enabled) return;
    const rule = this.limits[name];
    if (!rule || !who) return;
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - (now % rule.windowSec);
    const key = `${name}:${who}`;
    const count = await this._increment(key, windowStart);
    if (count > rule.max) {
      throw new RateLimitError(message || 'Too many requests, please slow down', windowStart + rule.windowSec - now);
    }
  }

  async _increment(key, windowStart) {
    if (this.store?.kind === 'postgres') {
      const pool = await this.store._pool();
      const { rows } = await pool.query(
        `INSERT INTO nuance_limits (key, window_start, count) VALUES ($1, $2, 1)
         ON CONFLICT (key) DO UPDATE SET
           count = CASE WHEN nuance_limits.window_start = EXCLUDED.window_start THEN nuance_limits.count + 1 ELSE 1 END,
           window_start = EXCLUDED.window_start
         RETURNING count`,
        [key, windowStart],
      );
      return rows[0].count;
    }
    const cur = this.memory.get(key);
    const next = cur && cur.windowStart === windowStart ? { windowStart, count: cur.count + 1 } : { windowStart, count: 1 };
    this.memory.set(key, next);
    if (this.memory.size > 50_000) this.memory.clear(); // keep memory bounded
    return next.count;
  }
}

// The caller's internet address. Vercel and most hosts put the real one in these headers.
export function clientIp(req) {
  return (
    req.headers['x-real-ip'] ||
    String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}
