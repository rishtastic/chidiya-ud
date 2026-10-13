# Chidiya Ud

Chidiya Ud is a Hindi flying-or-not-flying reaction game.

## Global leaderboard

The website build reads a shared top ten from the Go service in
`cmd/leaderboard`. The service uses SQLite and exposes these same-origin
endpoints:

- `GET /chidiya-ud/api/scores`
- `POST /chidiya-ud/api/sessions`
- `POST /chidiya-ud/api/scores`
- `GET /healthz`

For local API work, run the service alongside the Vite development server:

```sh
go run ./cmd/leaderboard -db ./data/chidiya-ud.db
```

The GitHub Pages build (`yarn build --mode pages`) keeps the previous device-only
top ten in the browser's existing `scores` storage key. It makes no leaderboard
API requests. The default build uses the global leaderboard. Both builds point
search engines to `https://rishabhdaga.com/chidiya-ud/` as the canonical page.

In production, the Go service listens only on `127.0.0.1:8082`. Nginx proxies
`/chidiya-ud/api/` to it and serves the Vite build at `/chidiya-ud/`. The
service and route definitions are in `deploy/`.

## Security model

- Every submitted score needs a cryptographically random, one-use session ID
  created by the server and expiring after 15 minutes.
- The server owns player-name limits, score limits, request-size limits,
  prepared SQLite queries, and per-address rate limits. It returns JSON only,
  does not enable CORS, and binds to loopback in production.
- Nginx must overwrite `X-Real-IP` when proxying. The Go service must remain
  private so a caller cannot forge that header directly.
- SQLite runs in WAL mode with a busy timeout, suitable for this low-volume
  workload without an additional paid service.
- A protected username is configured with `SUPER_ADMIN_USERNAME` and a bcrypt
  `SUPER_ADMIN_PASSWORD_HASH`. Store both in `/srv/chidiya-ud/admin-auth.env`
  with owner `codex-deploy` and mode `0600`; the service unit loads that file.
  Run `go run ./cmd/admin-password` in a terminal to generate the hash line.
  Never commit the username, hash, or password. With no configured hash, the
  protected username cannot log in while other players can still play.
- Five failed passwords from one address block protected login for 15 minutes.
  Existing scores matching the configured username remain in SQLite but are
  omitted from public scores and rank calculations. The authenticated player
  sees their private rank among all scores after a game. GitHub Pages has no
  server authentication; its device-only game and leaderboard stay unchanged.

This is abuse resistance, not an impossibility proof against a determined
player who modifies their browser. A later server-authoritative event sequence
would be the next step if competitive integrity becomes more important than a
lightweight reaction game.

## Checks

```sh
npm run build
go test ./...
```
