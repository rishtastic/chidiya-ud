# Website deployment

This release adds accounts, admin roles, item publishing, explanations, and the
full leaderboard, alongside the audited dependency updates. It is prepared for
review; no deployment is performed by building it locally.

## Admin access

After deployment, select **Admin** on the game page or open
`https://rishabhdaga.com/chidiya-ud/admin/`. Sign in with the existing configured
super-admin username and password. Do not create a new account for that name.
The existing bcrypt hash is reused; no password reset or re-registration is
required. The credentials stay in `/srv/chidiya-ud/admin-auth.env` (mode 0600),
which is already loaded by the service. This deployment does not replace it.

Only the environment-configured identity is super admin. That identity can
grant content-editor and user-admin roles to registered users. Other admins
cannot create admins. Super-admin password changes remain an environment
operation; the user-admin reset flow cannot change that credential.

The dashboard is marked noindex and omitted from the sitemap. Every admin API
checks authorization; hiding links is not the access-control mechanism.
The domain-root robots file is managed by the website repository. The admin
login stays crawlable so crawlers can read its noindex meta tag and HTTP
header; do not add a Disallow for that page. Private account/admin API paths
are excluded from crawling. The HTTP noindex rules live in the domain's Nginx
configuration and must remain in place across deployments.

## Publish after approval

Push the reviewed clean branch to master without merging the old feature
branch's history. Then install the prepared helper and invoke it on the VPS:

```sh
scp -i ~/.ssh/codebreaker_deploy deploy/deploy-chidiya-ud \
  codex-deploy@77.37.45.23:/tmp/deploy-chidiya-ud
ssh -i ~/.ssh/codebreaker_deploy codex-deploy@77.37.45.23 \
  'sudo -n cp -an /usr/local/sbin/deploy-chidiya-ud /usr/local/sbin/deploy-chidiya-ud.pre-accounts'
ssh -i ~/.ssh/codebreaker_deploy codex-deploy@77.37.45.23 \
  'sudo -n install -o root -g root -m 0755 /tmp/deploy-chidiya-ud /usr/local/sbin/deploy-chidiya-ud'
ssh -i ~/.ssh/codebreaker_deploy codex-deploy@77.37.45.23 \
  'sudo -n /usr/local/sbin/deploy-chidiya-ud'
```

The helper accepts an optional full expected master commit as its first
argument. Use it to ensure the deployed release is the reviewed revision.

The helper installs Yarn 1.22.22 if absent, uses the frozen Yarn lockfile,
builds both the website and Go service, and runs Go tests with Go 1.27.3.
The Go toolchain downloads automatically if missing; this does not replace the
system Go installation used by other projects. The service is stopped only
after builds and tests succeed. It then takes a consistent SQLite backup,
including WAL contents, before any new schema migration runs.

Database migrations are additive and idempotent. Existing scores remain;
items are seeded only for an empty items table, directly from the existing
English/Hindi lists. The helper checks the public page, an asset, admin
noindex markup, and backend health. Nginx and other projects are untouched.

## Rollback

Each deployment retains the prior binary, service unit, and a verified database
snapshot under `/srv/chidiya-ud/backups/<release>/` (root-only). The previous
web directory is retained under `/var/www/.chidiya-ud.rollback.<release>`.

If activation or health checks fail, the helper automatically restores the
old binary, unit, and website and restarts the previous service. The additive
database schema remains, which the old service can tolerate. Database backups
are never automatically restored, to avoid discarding scores submitted since
the snapshot. Restore one only after stopping the service and explicitly
assessing data loss; preserve the current database and WAL files first.

After a successful deployment, verify sign-in with the existing admin
credentials, item editing, role restrictions, and the public leaderboard.
Do not print the environment file or password hash while verifying access.
