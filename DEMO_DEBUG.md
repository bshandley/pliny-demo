# pliny-demo Debug Task

## Problem
`initDemoDb(pool)` hangs indefinitely when called. The server starts up fine but never logs "Demo mode enabled".

## What we know
- `pool.query("SELECT 1")` works fine directly
- After `patchPoolForDemo(pool)`, `pool.__originalQuery` is set to a function
- Calling `pool.__originalQuery("CREATE TABLE IF NOT EXISTS demo_sessions (...)")` hangs forever
- No error is thrown — it just never resolves
- The server starts, runs migrations via `node dist/migrations/run.js` first, then starts `node dist/index.js`
- DEMO_MODE=true is confirmed set in the container
- DB is healthy (postgres responds fine)

## Architecture
- Wharf (10.0.0.102): Docker host running the demo containers
- SSH key: ~/.ssh/id_ed25519_orin
- Demo repo: ~/pliny-demo on Wharf
- Containers: pliny-demo-server-1, pliny-demo-db-1, pliny-demo-client-1
- Server port on Wharf: 3001 (internal), 8090 (via nginx client)

## Files
- `/home/bradley/pliny-demo/patches/server/demo-session.ts` - the broken file
- `/home/bradley/pliny-demo/patches/apply-server.js` - injects demo code into pliny's index.ts

## Root cause hypothesis
The pool patch replaces `pool.query` with a function that calls `getOriginalQuery(pool)()`. But `getOriginalQuery(pool)` returns `pool.__originalQuery` which is `pool.query.bind(pool)` — but at the time of calling, `pool.query` has already been replaced by the patched version. So when `__originalQuery` (the bound version of the *original* pool.query) is called internally by pg, it might be calling `pool.connect` internally which is now the patched version... creating a deadlock.

Actually simpler: `pool.query.bind(pool)` captures the pool object but NOT the method. When pg's Pool internally calls `this.connect()`, it uses the current `pool.connect` which is patched, and the patched connect calls `getOriginalConnect(pool)()` which is `pool.connect.bind(pool)` (original). But wait — `pool.connect.bind(pool)` is bound to the pool object. When pg's original connect calls `this._connect()` or internal pool methods, those use the pool's current state.

## Likely fix
The issue is circular: `pool.query.bind(pool)` creates a function that when called, internally calls `pool.connect()` (the now-patched version). The patched `pool.connect` calls `pool.__originalConnect()` which is `pool.connect.bind(pool)` (original)... but that original connect also internally calls pool methods.

**The real fix**: Don't patch `pool.query` and `pool.connect`. Instead, use a separate pg.Pool instance for demo schema operations (unpatched), and override the pool exports that the pliny routes use.

OR: use `pg.Pool._connect` private method, or just use `pool._query` to bypass the public interface.

OR simplest: create a second pool client directly with `new pg.Pool(...)` for demo operations, separate from the main pool.

## What to do
1. SSH to Wharf: `ssh -i ~/.ssh/id_ed25519_orin bradley@10.0.0.102`
2. Look at the actual hanging in context — maybe add pg query timeout
3. Fix the root cause in `patches/server/demo-session.ts`
4. The fix should use a **separate unpatched Pool** for demo schema operations
5. Rebuild: `cd ~/pliny-demo && git pull && docker compose build --no-cache server && docker compose up -d`
6. Test: `curl -c /tmp/dc.txt --max-time 60 http://localhost:8090/api/demo/auto-login` from Wharf
7. Verify the cookie is set and contains a JWT
8. Test restrictions: `curl -X POST http://localhost:8090/api/auth/register` should 403
9. Commit fix to both remotes (origin = Gitea 10.0.0.102:3004, github = GitHub)
10. Run: `openclaw system event --text "Done: demo site smoke test" --mode now`

## Expected working behavior
1. First visit → schema created, seeded (18 cards, 1 board, 3 users), cookie set, JWT returned
2. Subsequent visits with cookie → schema reused, last_seen updated
3. Blocked routes return 403 with `{"error":"Not available in the demo"}`
4. Soft limits: 6th board creation 403s, 101st card 403s
5. Cleanup cron drops schemas older than 2h every 30min
