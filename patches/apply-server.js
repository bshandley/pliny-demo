#!/usr/bin/env node
// Patches pliny server index.ts to inject demo mode support.
// Run from the pliny server source root: node apply-server.js

const fs = require('fs');
const path = require('path');

const indexPath = path.join(process.argv[2] || '.', 'src', 'index.ts');
let content = fs.readFileSync(indexPath, 'utf-8');

// 1. Add demo imports after the pool import
content = content.replace(
  "import pool from './db';",
  `import pool from './db';
// Demo mode
import { createDemoMiddleware, initDemoDb, patchPoolForDemo } from './demo/demo-session';
import { createDemoRestrictions } from './demo/demo-restrictions';
import demoRoutes from './demo/demo-routes';
import { startDemoCleanup } from './demo/demo-cleanup';`
);

// 2. Add pool patching + demo middleware after cookieParser
content = content.replace(
  "app.use(cookieParser());",
  `app.use(cookieParser());
// Demo mode: patch pool for schema isolation and add session middleware
if (process.env.DEMO_MODE === 'true') {
  patchPoolForDemo(pool);
  app.use(createDemoMiddleware(pool));
  app.use(createDemoRestrictions());
}`
);

// 3. Add demo routes before the health check
content = content.replace(
  "// Health check\napp.get('/api/health'",
  `// Demo routes
if (process.env.DEMO_MODE === 'true') {
  app.use('/api/demo', demoRoutes);
}

// Health check
app.get('/api/health'`
);

// 4. Add demo startup tasks after seedBuiltinTemplates
content = content.replace(
  "await seedBuiltinTemplates();",
  `await seedBuiltinTemplates();
    // Demo mode startup
    if (process.env.DEMO_MODE === 'true') {
      await initDemoDb();
      startDemoCleanup();
      console.log('Demo mode enabled — ephemeral schema-per-session');
    }`
);

fs.writeFileSync(indexPath, content);
console.log('Server patches applied to', indexPath);
