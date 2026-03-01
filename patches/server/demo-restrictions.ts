import { Request, Response, NextFunction } from 'express';
import pool from '../db';

const BLOCKED_ROUTES: [string[], string][] = [
  // [methods, path pattern]
  [['POST'], '/api/auth/register'],
  [['POST'], '/api/auth/forgot-password'],
  [['POST'], '/api/auth/reset-password'],

  // User management
  [['GET', 'POST', 'PUT', 'DELETE'], '/api/users'],

  // Webhooks
  [['POST', 'PUT', 'DELETE'], '/api/webhooks'],

  // API tokens
  [['POST', 'DELETE'], '/api/v1/tokens'],

  // 2FA / TOTP
  [['POST'], '/api/settings/totp/setup'],
  [['POST'], '/api/settings/totp/enable'],
  [['POST'], '/api/settings/totp/disable'],
  [['DELETE'], '/api/settings/totp'],

  // SSO / OIDC
  [['PUT'], '/api/settings/oidc'],
];

const DEMO_ERROR = { error: 'Not available in the demo' };

function matchesRoute(method: string, path: string): boolean {
  const upper = method.toUpperCase();

  for (const [methods, pattern] of BLOCKED_ROUTES) {
    if (!methods.includes(upper)) continue;

    // Exact match
    if (path === pattern) return true;

    // Match /api/users/:id, /api/webhooks/:id, /api/v1/tokens/:id, etc.
    if (path.startsWith(pattern + '/')) return true;
  }

  // DELETE /api/boards/:id — demo board must survive
  if (upper === 'DELETE' && /^\/api\/boards\/[^/]+$/.test(path)) {
    return true;
  }

  return false;
}

const MAX_BOARDS = 5;
const MAX_CARDS = 100;

export function createDemoRestrictions() {
  return async function demoRestrictionsMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ) {
    if (process.env.DEMO_MODE !== 'true') {
      return next();
    }

    // Hard blocks
    if (matchesRoute(req.method, req.path)) {
      return res.status(403).json(DEMO_ERROR);
    }

    // Soft limits — board creation
    if (req.method === 'POST' && req.path === '/api/boards') {
      try {
        const result = await pool.query('SELECT COUNT(*)::int AS count FROM boards');
        if (result.rows[0].count >= MAX_BOARDS) {
          return res.status(403).json({ error: 'Not available in the demo' });
        }
      } catch (err) {
        console.error('Demo restrictions: board count check failed', err);
      }
    }

    // Soft limits — card creation
    if (req.method === 'POST' && req.path === '/api/cards') {
      try {
        const result = await pool.query('SELECT COUNT(*)::int AS count FROM cards');
        if (result.rows[0].count >= MAX_CARDS) {
          return res.status(403).json({ error: 'Not available in the demo' });
        }
      } catch (err) {
        console.error('Demo restrictions: card count check failed', err);
      }
    }

    next();
  };
}
