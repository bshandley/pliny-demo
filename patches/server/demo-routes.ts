import { Router, Request, Response } from 'express';
import pool from '../db';
import { generateToken } from '../middleware/auth';
import { getInfraPool } from './demo-session';

const router = Router();

// GET /api/demo/status — session info for the banner
router.get('/status', async (req: Request, res: Response) => {
  const schemaName = (req as any).demoSession;
  if (!schemaName) {
    return res.status(404).json({ error: 'No demo session' });
  }

  try {
    // demo_sessions is in public schema — use infraPool (unpatched)
    const session = await getInfraPool().query(
      'SELECT created_at, last_seen_at FROM demo_sessions WHERE schema_name = $1',
      [schemaName]
    );

    if (session.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const createdAt = new Date(session.rows[0].created_at);
    const expiresAt = new Date(createdAt.getTime() + 2 * 60 * 60 * 1000);

    // boards table is in the demo schema
    const board = await pool.query('SELECT id FROM boards LIMIT 1');
    const boardId = board.rows[0]?.id || null;

    res.json({
      sessionId: schemaName,
      expiresAt: expiresAt.toISOString(),
      boardId,
    });
  } catch (err) {
    console.error('Demo status error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/demo/auto-login — returns JWT for the demo admin user
router.get('/auto-login', async (req: Request, res: Response) => {
  if (process.env.DEMO_MODE !== 'true') {
    return res.status(404).json({ error: 'Not found' });
  }

  try {
    // Get the first user (admin) from the demo schema
    const result = await pool.query(
      "SELECT id, username, role FROM users ORDER BY created_at ASC LIMIT 1"
    );

    if (result.rows.length === 0) {
      return res.status(500).json({ error: 'No demo users found' });
    }

    const user = result.rows[0];
    const token = generateToken({
      id: user.id,
      username: user.username,
      role: user.role,
    });

    res.json({
      token,
      user: { id: user.id, username: user.username, role: user.role },
    });
  } catch (err) {
    console.error('Demo auto-login error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

export default router;
