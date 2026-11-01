# Dependency vulnerability audit

Date: 2026-11-01. Baseline commit: `8566023`.

Scope: repository dependencies, the frontend dependency versions installed on
the VPS, and the actual deployed Go executable. This is not a full host,
Nginx, operating-system, or application penetration test.

## Findings

### Deployed Go executable needs a patched rebuild

The deployed executable was built with Go 1.27.1. Binary-mode govulncheck
identified vulnerable symbols for eight standard-library advisories:

- GO-2026-6809: compromised intermediate certificate distrust, fixed in 1.27.3.
- GO-2026-6617: HTTP/2 HPACK encoder race/server crash.
- GO-2026-6613: HTTP/1 CONNECT connection desynchronization.
- GO-2026-6612: HTTP/2 flow-control accounting.
- GO-2026-6611: HTTP/2 CPU exhaustion.
- GO-2026-6608: MIME-header memory-limit bypass.
- GO-2026-6607: malformed TLS ECH extension handling.
- GO-2026-6603: HTTP/2 trailer memory exhaustion.

The last seven are fixed in Go 1.27.2. Advisory details are available at
`https://pkg.go.dev/vuln/<advisory ID>`.

Binary symbol presence does not establish exploitability. This application
uses a loopback plaintext HTTP listener behind Nginx, does not enable Go TLS
or cleartext HTTP/2, and does not register a successful CONNECT handler.
Those conditions reduce exposure to the listed protocol attacks. Rebuilding
with Go 1.27.3 removes the affected implementations regardless.

### Frontend build dependencies need updates

The committed Yarn tree used Vite 8.1.4. An npm audit of a temporary lockfile
derived from that tree reported four high-severity dependency groups:

| Package | Findings | Prepared version |
| --- | --- | --- |
| vite | Development-server file access and editor command handling | 8.3.5 |
| postcss | Previous-source-map path traversal/disclosure | 8.5.32 |
| nanoid | Invalid-size generator infinite loops | 3.3.20 |
| source-map-js | Indexed-source-map denial of service | 1.2.2 |

These are build/development dependencies, not a Node service serving the public
game. Exploitation depends on development-server exposure or hostile build
inputs. The source-map-js advisory is CVE-2026-93749:
https://github.com/advisories/GHSA-68fv-2mgg-jv7q

The deployed VPS tree differed: Vite 8.3.0, PostCSS 8.5.28, nanoid 3.3.19,
and source-map-js 1.2.1. Vite and source-map-js were still affected. For Vite's
editor issue see https://github.com/advisories/GHSA-587h-7wmj-h5pm .

### Installation drift prevents reproducible security checks

GitHub Pages installs the committed Yarn lockfile. The VPS deployment uses
`npm install --no-save --package-lock=false`, which ignores that lockfile and
can retain old transitive packages in its existing node_modules directory.
The different dependency trees explain the different warning counts.

The prepared replacement helper in `deploy/deploy-chidiya-ud` uses
`yarn install --frozen-lockfile` so the VPS installs the verified Yarn tree,
including replacing stale transitive versions. It installs pinned Yarn if
absent. The replacement has not yet been installed or run on the VPS.

### Go module advisories outside application call paths

The baseline also required old x/crypto and x/sys versions with numerous
SSH, OpenPGP, and Windows advisories. The application imports bcrypt, not SSH
or OpenPGP. The prepared update uses x/crypto 0.56.0, x/term 0.45.0, and x/sys
0.47.0. Go 1.27.3 is now the minimum declared toolchain.

## Verification of prepared changes

- Go tests: passed with Go 1.27.3.
- Website and GitHub Pages builds: passed with Vite 8.3.5.
- npm audit of a temporary lockfile derived from the refreshed Yarn tree:
  zero reported vulnerabilities. The temporary npm lockfile was removed;
  Yarn remains the repository's package manager.
- govulncheck: zero vulnerable symbols and zero vulnerable imported packages.
  One module-only warning remains, GO-2026-5932, for the unused and unmaintained
  x/crypto/openpgp package. It has no patched version and is not imported here.
- These checks were repeated after integrating the accounts/admin feature.
  Go tests with race detection also cover roles, password resets, guest score
  claims, private-score filtering, CSRF/origin checks, configured-admin access,
  and publishing item visibility. The deployment helper passes Bash syntax
  validation; live deployment/rollback will be verified during the approved
  production rollout.

These results cover known advisories in the databases at audit time; they
are not proof that the code has no vulnerabilities. The prepared dependency
updates have not been deployed. Rebuild the Go service with Go 1.27.3 or newer
and verify its embedded toolchain version after deployment.
