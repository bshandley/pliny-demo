#!/usr/bin/env node
// Patches pliny client App.tsx to inject demo mode support.
// Run from the pliny client source root: node apply-client.js

const fs = require('fs');
const path = require('path');

const appPath = path.join(process.argv[2] || '.', 'src', 'App.tsx');
let content = fs.readFileSync(appPath, 'utf-8');

// 1. Add DemoBanner import
content = content.replace(
  "import PublicBoard from './components/PublicBoard';",
  `import PublicBoard from './components/PublicBoard';
import DemoBanner from './components/DemoBanner';`
);

// 2. Replace the "no token" else branch to try demo auto-login first
const oldElse = `} else {
      // Check if this is a fresh install
      api.getSetupStatus().then(({ needsSetup: needs }) => {
        setNeedsSetup(needs);
        setLoading(false);
      }).catch(() => setLoading(false));
    }`;

const newElse = `} else {
      // Demo: try auto-login first, then fall back to setup check
      fetch('/api/demo/auto-login')
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (data?.token) {
            api.setToken(data.token);
            return api.me().then(async (userData: any) => {
              setUser(userData);
              await resolveUrlRoute(userData);
              setLoading(false);
            });
          }
          return api.getSetupStatus().then(({ needsSetup: needs }: any) => {
            setNeedsSetup(needs);
            setLoading(false);
          });
        })
        .catch(() => {
          api.getSetupStatus().then(({ needsSetup: needs }: any) => {
            setNeedsSetup(needs);
            setLoading(false);
          }).catch(() => setLoading(false));
        });
    }`;

content = content.replace(oldElse, newElse);

// 3. Also patch the catch handler for expired tokens to try auto-login
const oldCatch = `.catch(() => {
          api.setToken(null);
          // Check setup status when no valid token
          api.getSetupStatus().then(({ needsSetup: needs }) => {
            setNeedsSetup(needs);
            setLoading(false);
          }).catch(() => setLoading(false));
        });`;

const newCatch = `.catch(() => {
          api.setToken(null);
          // Demo: try auto-login on token expiry
          fetch('/api/demo/auto-login')
            .then(r => r.ok ? r.json() : null)
            .then(data => {
              if (data?.token) {
                api.setToken(data.token);
                return api.me().then(async (userData: any) => {
                  setUser(userData);
                  await resolveUrlRoute(userData);
                  setLoading(false);
                });
              }
              return api.getSetupStatus().then(({ needsSetup: needs }: any) => {
                setNeedsSetup(needs);
                setLoading(false);
              });
            })
            .catch(() => {
              api.getSetupStatus().then(({ needsSetup: needs }: any) => {
                setNeedsSetup(needs);
                setLoading(false);
              }).catch(() => setLoading(false));
            });
        });`;

content = content.replace(oldCatch, newCatch);

// 4. Inject DemoBanner at the top of the authenticated view
content = content.replace(
  '<AppBarContext.Provider value={appBarContext}>',
  `<AppBarContext.Provider value={appBarContext}>
      <DemoBanner />`
);

fs.writeFileSync(appPath, content);
console.log('Client patches applied to', appPath);

// 5. Patch nginx.conf to add rate limiting
const nginxPath = path.join(process.argv[2] || '.', 'nginx.conf');
let nginx = fs.readFileSync(nginxPath, 'utf-8');

// Add rate limit zone before the server block, and apply it to /api/
if (!nginx.includes('limit_req_zone')) {
  nginx = `limit_req_zone $binary_remote_addr zone=demo_api:10m rate=20r/s;
limit_req_zone $binary_remote_addr zone=demo_autologin:10m rate=2r/s;

` + nginx;

  // Rate limit /api/ and tighten auto-login specifically
  nginx = nginx.replace(
    'location /api/ {',
    `location /api/demo/auto-login {
        limit_req zone=demo_autologin burst=5 nodelay;
        proxy_pass http://server:3001/api/demo/auto-login;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location /api/ {
        limit_req zone=demo_api burst=40 nodelay;`
  );

  // Hide server version
  nginx = nginx.replace('gzip on;', 'server_tokens off;\n    gzip on;');

  fs.writeFileSync(nginxPath, nginx);
  console.log('nginx.conf patched with rate limiting');
}
