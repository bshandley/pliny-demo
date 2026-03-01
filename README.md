# pliny-demo

Ephemeral demo wrapper for [Pliny](https://github.com/bshandley/pliny) — a self-hosted kanban board.

Visitors hit a URL and get their own private, throwaway Pliny instance pre-seeded with realistic demo data. No login required. Sessions expire after 2 hours and are cleaned up automatically.

## How it works

Each visitor gets an isolated PostgreSQL schema (`demo_<id>`) containing a full copy of the Pliny database tables, seeded with a sample "Product Roadmap" board, 18 cards, 4 labels, and 3 fake users. An `AsyncLocalStorage`-based middleware transparently routes all database queries to the visitor's schema.

- **Session creation**: On first visit, the middleware generates a schema, runs all Pliny migrations, seeds demo data, and sets a cookie.
- **Auto-login**: The client automatically obtains a JWT for the demo admin user — no login form needed.
- **Isolation**: Each session has its own users, boards, cards, and comments. Changes are private.
- **Cleanup**: A cron job runs every 30 minutes, dropping schemas for sessions last seen >2 hours ago.
- **Banner**: A sticky amber banner shows a countdown timer and links to the Pliny repo.

## Architecture

The demo images are built **from source** — not forked. This repo contains only the patch layer:

```
patches/
├── server/          # Demo middleware, seeder, cleanup, routes
│   ├── demo-session.ts    # Schema-per-session middleware + pool patching
│   ├── demo-seeder.ts     # Seeds realistic board data
│   ├── demo-cleanup.ts    # Cron to drop expired schemas
│   └── demo-routes.ts     # /api/demo/status + /api/demo/auto-login
├── client/
│   └── DemoBanner.tsx     # Sticky banner with countdown
├── apply-server.js        # Injects demo imports into pliny server
└── apply-client.js        # Injects demo banner + auto-login into pliny client
```

At build time, pliny source is cloned, patches are applied, and the result is compiled into Docker images.

## Deploy

```bash
cp .env.example .env
# Edit .env — set strong DB_PASSWORD and JWT_SECRET

docker compose up -d
```

The demo is available at `http://localhost:8090` (or whatever `DEMO_PORT` you set).

## Build images locally

```bash
# Uses /tmp/pliny-src by default; set PLINY_SRC_DIR to override
./build.sh

# Push to GHCR
PUSH=1 ./build.sh
```

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DB_PASSWORD` | Yes | PostgreSQL password |
| `JWT_SECRET` | Yes | JWT signing secret (≥16 chars) |
| `DEMO_URL` | No | Public URL (default: `http://localhost:8090`) |
| `DEMO_PORT` | No | Port to expose (default: `8090`) |
