NOTE: The pliny source repo is already cloned at /home/bradley/pliny — use that directly instead of cloning. No need to run git clone for the upstream repo.

You are building `pliny-demo` — a thin demo wrapper over the Pliny kanban app (https://github.com/bshandley/pliny).

The goal: visitors hit a URL, get their own private throwaway Pliny instance (scoped to a Postgres schema), pre-seeded with realistic demo data, with a "this is a demo" banner. No login required. Sessions expire after 2 hours and are cleaned up automatically.

## Architecture

The demo image is built FROM the existing pliny server/client images — not a fork. The demo repo adds a patch layer on top.

## What to build

### 1. Server patch (`patches/server/`)

**`demo-session.ts`** — Express middleware (runs before all routes):
- Reads `demo_session` cookie
- If no cookie or schema doesn't exist: generate a short UUID (`demo_<8chars>`), `CREATE SCHEMA demo_<id>`, run migrations on that schema (use `SET search_path`), seed demo data, set cookie (2h maxAge), respond
- If valid cookie: set `search_path = demo_<id>` for the request
- Attach session ID to `req` for downstream use

**`demo-seeder.ts`** — Seeds a realistic board into the session schema:
- 1 board: "Product Roadmap"
- 4 columns: Backlog / In Progress / In Review / Done
- 18 cards spread across columns with realistic titles (e.g. "Add OAuth support", "Fix mobile drag scroll", "Dark mode polish", "Onboarding flow redesign", "Stripe billing integration", etc.)
- Cards have: descriptions (1-2 sentences), due dates (mix of past/future), labels (Bug / Feature / Design / Infra), 2-3 comments per card from fake users
- 3 fake users in the users table with hashed passwords (they won't log in, just show as assignees on cards)

**`demo-cleanup.ts`** — Cron that runs every 30 minutes:
- Drops any `demo_*` schemas where the session was last seen >2h ago
- Tracks last-seen in a `demo_sessions` table in the public schema

**`demo-routes.ts`** — Additional routes:
- `GET /api/demo/status` — returns `{ sessionId, expiresAt, boardId }` (used by banner)

### 2. Client patch (`patches/client/`)

**`DemoBanner.tsx`** — Sticky top bar (40px):
- "🎭 Live demo · Your changes are private and expire in <countdown> · [Self-host Pliny →](https://github.com/bshandley/pliny)"
- Amber/yellow background, subtle, doesn't feel like an error
- Countdown updates every minute via `GET /api/demo/status`

**`demo-patch.ts`** — Small App.tsx patch:
- Skip the `/setup` redirect check (demo always has a session)
- Inject DemoBanner at the top of the app
- Auto-login: on mount, if no JWT, call `GET /api/demo/auto-login` which returns a JWT for the demo user (first user in the session schema)

### 3. Server auto-login route
- `GET /api/demo/auto-login` — no auth required, returns JWT for the demo admin user in the session schema. Only works if `DEMO_MODE=true` env var is set.

### 4. Dockerfiles

**`Dockerfile.server`**:
```dockerfile
FROM ghcr.io/bshandley/pliny-server:latest
COPY patches/server/ /app/demo-patches/
# Compile patches and inject into dist
```

**`Dockerfile.client`**:
```dockerfile
FROM ghcr.io/bshandley/pliny-client:latest  
# Can't easily patch built React — need to build from source with patches applied
# Use pliny client source as base, apply patches, build
```

Actually — rethink the client Dockerfile. Since the client is pre-built React, patching it requires rebuilding from source. Use a multi-stage build:
1. Pull pliny client source (git clone specific tag or main)
2. Apply client patches
3. Build
4. Serve with nginx (same nginx.conf as pliny)

### 5. `docker-compose.yml`
```yaml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: pliny_demo
      POSTGRES_USER: pliny
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - demo_pgdata:/var/lib/postgresql/data

  server:
    build:
      context: .
      dockerfile: Dockerfile.server
    environment:
      DEMO_MODE: "true"
      NODE_ENV: production
      DB_HOST: db
      DB_NAME: pliny_demo
      DB_USER: pliny
      DB_PASSWORD: ${DB_PASSWORD}
      JWT_SECRET: ${JWT_SECRET}
      PLINY_URL: ${DEMO_URL}
    depends_on:
      db:
        condition: service_healthy

  client:
    build:
      context: .
      dockerfile: Dockerfile.client
    ports:
      - "${DEMO_PORT:-8090}:80"
    depends_on:
      - server

volumes:
  demo_pgdata:
```

### 6. `build.sh` — CI build script
```bash
#!/bin/bash
# Pull latest pliny source for client build
git clone --depth 1 https://github.com/bshandley/pliny /tmp/pliny-src

# Apply client patches
cp patches/client/* /tmp/pliny-src/client/src/components/
# (patch App.tsx to import DemoBanner and demo-patch logic)

# Build and push images
docker build -f Dockerfile.server -t ghcr.io/bshandley/pliny-demo-server:latest .
docker build -f Dockerfile.client -t ghcr.io/bshandley/pliny-demo-client:latest .
docker push ghcr.io/bshandley/pliny-demo-server:latest
docker push ghcr.io/bshandley/pliny-demo-client:latest
```

### 7. `.github/workflows/build.yml`
- Triggers on push to main AND on a schedule (nightly at 2am UTC) to pick up new pliny releases
- Runs `build.sh`, pushes to GHCR
- Also triggerable manually (workflow_dispatch)

### 8. `README.md`
Document:
- What this is and how it works
- How to deploy (`cp .env.example .env && docker compose up -d`)
- How the session scoping works (brief architecture note)
- How patches are applied on top of pliny

### 9. `.env.example`
```
DB_PASSWORD=change-me
JWT_SECRET=change-me-long-random
DEMO_URL=http://localhost:8090
DEMO_PORT=8090
```

## Important constraints

- The server patches need to hook into the pliny server's Express app. Since we're building FROM the compiled pliny image, we need a wrapper `server-demo.js` that:
  1. Requires the demo middleware
  2. Then requires the main pliny server (or monkey-patches it)
  
  Actually — the cleanest approach: the Dockerfile.server changes the CMD to run a demo entrypoint that patches Express before starting the main app. Use Node.js module patching or just run a wrapper that starts express, registers demo middleware first, then loads the pliny routes.

  Alternatively: build the server from source (like the client). Clone pliny source, inject demo middleware into `index.ts` before the route registration, build, run. This is cleaner than monkey-patching.

  **Use the build-from-source approach for both server and client.**

## After completing everything:

- git add -A
- git commit -m "feat: initial pliny-demo — schema-per-session ephemeral demo instances"
- git push origin main
- git push github main
- openclaw system event --text "Done: pliny-demo repo built" --mode now
