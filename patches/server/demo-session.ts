import { AsyncLocalStorage } from 'async_hooks';
import { Request, Response, NextFunction } from 'express';
import { Pool, PoolClient } from 'pg';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { seedDemoData } from './demo-seeder';

interface DemoStore {
  client: PoolClient;
  schema: string;
}

interface GeoInfo {
  ip: string;
  country_code: string | null;
  country_name: string | null;
  city: string | null;
}

export const demoStorage = new AsyncLocalStorage<DemoStore>();

/** Separate unpatched pool for demo infrastructure queries (schema mgmt, session tracking). */
let infraPool: Pool;

export function getInfraPool(): Pool {
  return infraPool;
}

function generateSessionId(): string {
  return 'demo_' + crypto.randomBytes(4).toString('hex');
}

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const ips = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    return ips.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

async function lookupGeo(ip: string): Promise<GeoInfo> {
  const base: GeoInfo = { ip, country_code: null, country_name: null, city: null };

  // Skip loopback / private addresses
  if (!ip || ip === 'unknown' || ip.startsWith('127.') || ip.startsWith('::1') || ip.startsWith('10.') || ip.startsWith('192.168.')) {
    return base;
  }

  return new Promise((resolve) => {
    const req = https.get(
      `https://ipinfo.io/${ip}/json`,
      { timeout: 3000 },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.ip) {
              resolve({
                ip,
                country_code: json.country || null,
                country_name: null,
                city: json.city || null,
              });
            } else {
              resolve(base);
            }
          } catch {
            resolve(base);
          }
        });
      }
    );
    req.on('error', () => resolve(base));
    req.on('timeout', () => { req.destroy(); resolve(base); });
  });
}

/**
 * Patch pool.query and pool.connect so that within a request's
 * AsyncLocalStorage context, all queries route through the demo
 * session's schema-bound client.
 *
 * IMPORTANT: pg's Pool.query internally calls this.connect(callback).
 * We cannot save pool.query via .bind() and call it back — the internal
 * this.connect() would re-enter our patched connect (which is async/
 * promise-only and would drop the callback, causing a deadlock).
 *
 * Instead, all non-store fallback queries go through infraPool, a
 * separate unpatched Pool instance that never hits our patches.
 */
export function patchPoolForDemo(pool: Pool) {
  infraPool = new Pool({
    host: process.env.DB_HOST || 'db',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'pliny',
    user: process.env.DB_USER || 'pliny',
    password: process.env.DB_PASSWORD || 'dev-only-password',
  });

  // Patch pool.query: use the per-request client when inside a demo
  // session, otherwise forward to the unpatched infraPool.
  (pool as any).query = function (...args: any[]) {
    const store = demoStorage.getStore();
    if (store?.client) {
      return (store.client.query as Function)(...args);
    }
    return (infraPool.query as Function)(...args);
  };

  // Patch pool.connect: must handle both callback style (used internally
  // by Pool.query) and promise style (used by app code).
  (pool as any).connect = function (cb?: any) {
    if (cb) {
      return infraPool.connect(cb);
    }
    return infraPool.connect();
  };
}

export async function initDemoDb() {
  // Core sessions table
  await infraPool.query(`
    CREATE TABLE IF NOT EXISTS demo_sessions (
      schema_name  VARCHAR(255) PRIMARY KEY,
      created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ip_address   VARCHAR(45),
      country_code CHAR(2),
      country_name VARCHAR(100),
      city         VARCHAR(100)
    )
  `);

  // Add geo columns to existing deployments (idempotent)
  for (const col of [
    "ALTER TABLE demo_sessions ADD COLUMN IF NOT EXISTS ip_address   VARCHAR(45)",
    "ALTER TABLE demo_sessions ADD COLUMN IF NOT EXISTS country_code CHAR(2)",
    "ALTER TABLE demo_sessions ADD COLUMN IF NOT EXISTS country_name VARCHAR(100)",
    "ALTER TABLE demo_sessions ADD COLUMN IF NOT EXISTS city         VARCHAR(100)",
  ]) {
    await infraPool.query(col);
  }

  // Permanent analytics table — survives session cleanup
  await infraPool.query(`
    CREATE TABLE IF NOT EXISTS demo_analytics (
      id           SERIAL PRIMARY KEY,
      session_schema VARCHAR(255),
      ip_address   VARCHAR(45),
      country_code CHAR(2),
      country_name VARCHAR(100),
      city         VARCHAR(100),
      created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function sessionExists(schemaName: string): Promise<boolean> {
  const result = await infraPool.query(
    'SELECT 1 FROM demo_sessions WHERE schema_name = $1',
    [schemaName]
  );
  return result.rows.length > 0;
}

async function createDemoSchema(schemaName: string, geo: GeoInfo): Promise<void> {
  await infraPool.query(`CREATE SCHEMA "${schemaName}"`);

  const client: PoolClient = await infraPool.connect();
  try {
    await client.query(`SET search_path TO "${schemaName}"`);
    const schemaSQL = fs.readFileSync(
      path.join(__dirname, '..', 'migrations', 'schema.sql'),
      'utf-8'
    );
    await client.query(schemaSQL);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const migDir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(migDir)
      .filter((f: string) => /^\d{3}-.*\.sql$/.test(f))
      .sort();

    for (const file of files) {
      const sql = fs.readFileSync(path.join(migDir, file), 'utf-8');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        [file]
      );
    }
    await seedDemoData(client);
  } finally {
    await client.query('RESET search_path');
    client.release();
  }

  // Insert into live sessions table (with geo)
  await infraPool.query(
    `INSERT INTO demo_sessions (schema_name, ip_address, country_code, country_name, city)
     VALUES ($1, $2, $3, $4, $5)`,
    [schemaName, geo.ip, geo.country_code, geo.country_name, geo.city]
  );

  // Insert into permanent analytics table (skip loopback/private IPs)
  const isPrivateIp = !geo.ip || geo.ip === 'unknown'
    || geo.ip.startsWith('127.')
    || geo.ip.startsWith('::1')
    || geo.ip.startsWith('10.')
    || geo.ip.startsWith('192.168.');
  if (!isPrivateIp) {
    await infraPool.query(
      `INSERT INTO demo_analytics (session_schema, ip_address, country_code, country_name, city)
       VALUES ($1, $2, $3, $4, $5)`,
      [schemaName, geo.ip, geo.country_code, geo.country_name, geo.city]
    );
  }

  console.log(`New demo session: ${schemaName} | ${geo.ip} | ${geo.country_name || 'unknown'}, ${geo.city || 'unknown'}`);
}

export function createDemoMiddleware(pool: Pool) {
  return async function demoSessionMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ) {
    if (process.env.DEMO_MODE !== 'true') {
      return next();
    }

    try {
      let schemaName = req.cookies?.demo_session;

      if (schemaName && await sessionExists(schemaName)) {
        await infraPool.query(
          'UPDATE demo_sessions SET last_seen_at = NOW() WHERE schema_name = $1',
          [schemaName]
        );
      } else {
        schemaName = generateSessionId();
        const ip = getClientIp(req);
        const geo = await lookupGeo(ip);
        await createDemoSchema(schemaName, geo);
        res.cookie('demo_session', schemaName, {
          maxAge: 2 * 60 * 60 * 1000,
          httpOnly: true,
          path: '/',
          sameSite: 'lax',
        });
      }

      (req as any).demoSession = schemaName;

      const client: PoolClient = await infraPool.connect();
      await client.query(`SET search_path TO "${schemaName}", public`);

      let released = false;
      const releaseClient = () => {
        if (!released) {
          released = true;
          client.query('RESET search_path').finally(() => client.release());
        }
      };
      res.on('finish', releaseClient);
      res.on('close', releaseClient);

      demoStorage.run({ client, schema: schemaName }, () => {
        next();
      });
    } catch (err) {
      console.error('Demo session middleware error:', err);
      next(err);
    }
  };
}
