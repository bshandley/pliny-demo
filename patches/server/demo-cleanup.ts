import { getInfraPool } from './demo-session';

export function startDemoCleanup() {
  // Run every 30 minutes
  setInterval(cleanupExpiredSessions, 30 * 60 * 1000);

  // Also run once at startup (after a short delay)
  setTimeout(cleanupExpiredSessions, 5000);
}

async function cleanupExpiredSessions() {
  const infraPool = getInfraPool();
  try {
    // Find sessions last seen more than 2 hours ago
    const expired = await infraPool.query(`
      SELECT schema_name FROM demo_sessions
      WHERE last_seen_at < NOW() - INTERVAL '2 hours'
    `);

    for (const row of expired.rows) {
      const schema = row.schema_name;
      try {
        await infraPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await infraPool.query(
          'DELETE FROM demo_sessions WHERE schema_name = $1',
          [schema]
        );
        console.log(`Cleaned up demo session: ${schema}`);
      } catch (err) {
        console.error(`Failed to clean up ${schema}:`, err);
      }
    }

    if (expired.rows.length > 0) {
      console.log(`Demo cleanup: removed ${expired.rows.length} expired session(s)`);
    }
  } catch (err) {
    console.error('Demo cleanup error:', err);
  }
}
