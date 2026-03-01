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

let originalPoolQuery: Function;
let originalPoolConnect: Function;

function generateSessionId(): string {
  return 'demo_' + crypto.randomBytes(4).toString('hex');
}

export function patchPoolForDemo(pool: Pool) {
  originalPoolQuery = pool.query.bind(pool);
  originalPoolConnect = pool.connect.bind(pool);

  // Patch pool.query to route through demo client when inside a demo request
  (pool as any).query = function (...args: any[]) {
    const store = demoStorage.getStore();
    if (store?.client) {
      return (store.client.query as Function)(...args);
    }
    return (originalPoolQuery as Function)(...args);
  };

  // Patch pool.connect so transactional code also uses the demo schema
  (pool as any).connect = async function () {
    const client: PoolClient = await originalPoolConnect();
    const store = demoStorage.getStore();
    if (store?.schema) {
      await client.query(`SET search_path TO "${store.schema}", public`);
    }
    return client;
  };
}

export async function initDemoDb() {
  await originalPoolQuery(`
    CREATE TABLE IF NOT EXISTS demo_sessions (
      schema_name VARCHAR(255) PRIMARY KEY,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function sessionExists(schemaName: string): Promise<boolean> {
  const result = await originalPoolQuery(
    'SELECT 1 FROM demo_sessions WHERE schema_name = $1',
    [schemaName]
  );
  return result.rows.length > 0;
}

async function createDemoSchema(pool: Pool, schemaName: string): Promise<void> {
  await originalPoolQuery(`CREATE SCHEMA "${schemaName}"`);

  const client: PoolClient = await originalPoolConnect();
  try {
    await client.query(`SET search_path TO "${schemaName}"`);

    // Run base schema
    const schemaSQL = fs.readFileSync(
      path.join(__dirname, '..', 'migrations', 'schema.sql'),
      'utf-8'
    );
    await client.query(schemaSQL);

    // Create migration tracking
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Run numbered migrations
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

    // Seed demo data
    await seedDemoData(client);
  } finally {
    client.release();
  }

  // Track session in public schema
  await originalPoolQuery(
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

      if (schemaName && await sessionExists(schemaName)) {
        // Update last seen
        await originalPoolQuery(
          'UPDATE demo_sessions SET last_seen_at = NOW() WHERE schema_name = $1',
          [schemaName]
        );
      } else {
        // Create new session
        schemaName = generateSessionId();
        await createDemoSchema(pool, schemaName);
        res.cookie('demo_session', schemaName, {
          maxAge: 2 * 60 * 60 * 1000, // 2 hours
          httpOnly: true,
          path: '/',
          sameSite: 'lax',
        });
      }

      // Attach session info to request
      (req as any).demoSession = schemaName;

      // Acquire a client and set search_path for this request
      const client: PoolClient = await originalPoolConnect();
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
