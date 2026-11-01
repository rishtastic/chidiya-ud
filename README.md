# Chidiya Ud

Chidiya Ud is a Hindi flying-or-not-flying reaction game.

## Website and leaderboard

The website build reads published game items and scores from the Go service in
`cmd/leaderboard`. The service uses SQLite and exposes same-origin APIs for
game sessions, the top ten, the searchable full leaderboard, accounts, and
administration. The game remains playable without an account until a name is
claimed. After the first game, a guest can save that name; scores from the
current guest session under that name attach to the new account. Older scores
are assigned only after a user-admin approves each one.

For local API work, run the service alongside the Vite development server:

```sh
go run ./cmd/leaderboard -db ./data/chidiya-ud.db
npm run dev
```

The admin dashboard is at `/chidiya-ud/admin/`; the public full board is at
`/chidiya-ud/leaderboard/`. The Admin link opens a sign-in page. The configured
`SUPER_ADMIN_USERNAME` signs in with its existing password, verified against
`SUPER_ADMIN_PASSWORD_HASH`. This is the sole super admin and can grant
`content-editor` (item drafts and publishing) or `user-admin` (historic score
claims and password resets) to ordinary accounts. User-admins cannot grant
roles or reset admin accounts. There is no route for creating another super
admin. Super-admin scores are hidden from public ranks and the default admin
board; user-admins and the super admin can opt to include them in the admin board.

Items are seeded once from the existing English and Hindi game lists, without
changing their answers. Editors can save drafts without affecting live rounds,
then publish or archive an item. Changing a live `canFly` answer requires an
explicit confirmation. Explanations are plain text shown only after a loss.
To regenerate the initial seed from the original lists before first deployment:

```sh
node scripts/generate-item-seed.mjs
```

The GitHub Pages build (`npm run build -- --mode pages`) keeps its original
client-side item lists and device-only top ten in the browser's existing
`scores` storage key. It has no account/admin/full-board UI and makes no API
requests. Both builds point search engines to
`https://rishabhdaga.com/chidiya-ud/` as the canonical page.

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
- Ordinary account passwords use per-account random salts with Argon2id, and
  only the hashes are stored. Sessions and recovery/reset codes are random,
  hashed in the database, time-limited, and one-use where applicable. Auth
  cookies are HttpOnly, SameSite Strict, and Secure over HTTPS; admin writes
  also require a CSRF token and same-origin request. Admin actions are audited.
- Account recovery requires either the one-time recovery code or an admin's
  recorded identity check. The admin issues a one-use 15-minute reset code;
  neither admins nor the server can show the old password. Reset issuance and
  use revoke existing sessions. Without email, the recorded identity check is
  an operational responsibility: do not approve a request on a matching name
  alone.
- Before deploying a schema change, back up the SQLite database. The migration
  adds tables/columns and seeds items; it does not rewrite existing scores.

This is abuse resistance, not an impossibility proof against a determined
player who modifies their browser. A later server-authoritative event sequence
would be the next step if competitive integrity becomes more important than a
lightweight reaction game.

## Checks

```sh
npm run build
npm run build -- --mode pages
go test ./...
```
