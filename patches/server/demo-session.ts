import { AsyncLocalStorage } from 'async_hooks';
import { Request, Response, NextFunction } from 'express';
import { Pool, PoolClient } from 'pg';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { seedDemoData } from './demo-seeder';

interface DemoStore {
  client: PoolClient;
  schema: string;
}

export const demoStorage = new AsyncLocalStorage<DemoStore>();

function generateSessionId(): string {
  return 'demo_' + crypto.randomBytes(4).toString('hex');
}

function getOriginalQuery(pool: Pool): Function {
  return (pool as any).__originalQuery;
}

function getOriginalConnect(pool: Pool): Function {
  return (pool as any).__originalConnect;
}

export function patchPoolForDemo(pool: Pool) {
  (pool as any).__originalQuery = pool.query.bind(pool);
  (pool as any).__originalConnect = pool.connect.bind(pool);

  (pool as any).query = function (...args: any[]) {
    const store = demoStorage.getStore();
    if (store?.client) {
      return (store.client.query as Function)(...args);
    }
    return getOriginalQuery(pool)(...args);
  };

  (pool as any).connect = async function () {
    const client: PoolClient = await getOriginalConnect(pool)();
    const store = demoStorage.getStore();
    if (store?.schema) {
      await client.query(`SET search_path TO "${store.schema}", public`);
    }
    return client;
  };
}

export async function initDemoDb(pool: Pool) {
  await getOriginalQuery(pool)(`
    CREATE TABLE IF NOT EXISTS demo_sessions (
      schema_name VARCHAR(255) PRIMARY KEY,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function sessionExists(pool: Pool, schemaName: string): Promise<boolean> {
  const result = await getOriginalQuery(pool)(
    'SELECT 1 FROM demo_sessions WHERE schema_name = $1',
    [schemaName]
  );
  return result.rows.length > 0;
}

async function createDemoSchema(pool: Pool, schemaName: string): Promise<void> {
  await getOriginalQuery(pool)(`CREATE SCHEMA "${schemaName}"`);

  const client: PoolClient = await getOriginalConnect(pool)();
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
    client.release();
  }

  await getOriginalQuery(pool)(
    'INSERT INTO demo_sessions (schema_name) VALUES ($1)',
    [schemaName]
  );
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

      if (schemaName && await sessionExists(pool, schemaName)) {
        await getOriginalQuery(pool)(
          'UPDATE demo_sessions SET last_seen_at = NOW() WHERE schema_name = $1',
          [schemaName]
        );
      } else {
        schemaName = generateSessionId();
        await createDemoSchema(pool, schemaName);
        res.cookie('demo_session', schemaName, {
          maxAge: 2 * 60 * 60 * 1000,
          httpOnly: true,
          path: '/',
          sameSite: 'lax',
        });
      }

      (req as any).demoSession = schemaName;

      const client: PoolClient = await getOriginalConnect(pool)();
      await client.query(`SET search_path TO "${schemaName}", public`);

      let released = false;
      const releaseClient = () => {
        if (!released) {
          released = true;
          client.release();
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
