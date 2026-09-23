# Chidiya Ud

Chidiya Ud is a Hindi flying-or-not-flying reaction game.

## Global leaderboard

The browser keeps the existing device-only top ten and also reads a shared top
ten from the Go service in `cmd/leaderboard`. The service uses a local SQLite
database and exposes only these same-origin endpoints:

- `GET /chidiya-ud/api/scores`
- `POST /chidiya-ud/api/sessions`
- `POST /chidiya-ud/api/scores`
- `GET /healthz`

For local API work, run the service separately from the Vite development
server:

```sh
go run ./cmd/leaderboard -db ./data/chidiya-ud.db
```

The production design is intentionally small: the Go service will listen only
on `127.0.0.1`, while Nginx routes `/chidiya-ud/api/` to it and continues to
serve the Vite build at `/chidiya-ud/`. The required Nginx and systemd changes
are deliberately not included in this branch, pending review.

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

This is abuse resistance, not an impossibility proof against a determined
player who modifies their browser. A later server-authoritative event sequence
would be the next step if competitive integrity becomes more important than a
lightweight reaction game.

## Checks

```sh
npm run build
go test ./...
```
