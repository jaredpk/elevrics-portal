# Elevrics Portal

Internal portal for **portal.elevrics.ai** — one login, one front door for the
tools that used to live on their own subdomains.

Marketing (`elevrics.ai`) stays where it is, in `elevrics-site`. This repo is
internal only and is never indexed.

---

## What it does

A Cloudflare Worker that serves a static shell and reverse-proxies each tool
onto a path:

| Path | Origin | Repo |
|---|---|---|
| `/` | static launcher | this repo |
| `/admin/` | static shell (skeleton) | this repo |
| `/solayard` | `solayard-intel.fly.dev` | `jaredpk/solayard-intel` |
| `/opportunities` | `elevrics-opportunities.fly.dev` | `jaredpk/elevrics-opportunities` |
| `/pathfinder` | `elevrics-relocation.fly.dev` | `jaredpk/elevrics-relocation` |
| Finance (link out) | `finance.elevrics.ai` | `jaredpk/finapp-v3` |

Routing lives in `src/router.js`; `src/index.js` is the Worker entrypoint. The
Worker runs on **every** request (`assets.run_worker_first`) and hands anything
that isn't a module route back to `ASSETS`, so 404s come from the same place as
the rest of the shell.

> `run_worker_first: true` is load-bearing. Without it, Workers Static Assets
> serve before the Worker runs: a request for `/` on *any* hostname matches
> `public/index.html` and returns the portal launcher without the Worker ever
> executing — which bypasses the parked-host check entirely and served the
> internal launcher on the public `pathfinder.elevrics.ai`. Unit tests call
> `handleRequest` directly and cannot catch this; it only shows up deployed.

> This is a **Worker with static assets**, not a Pages project. Cloudflare has
> folded Pages into Workers, and "Connect to Git" now creates a Worker. The
> Pages Functions convention (a `functions/` directory) is silently ignored
> here — a repo laid out that way deploys fine and then routes nothing.

### Two proxying modes

`/solayard` and `/opportunities` are **prefix-stripped**: the router removes the
prefix before forwarding, so the Flask and Express apps keep serving from root.
Each is told where it lives via a `URL_PREFIX` environment variable and emits
portal-space URLs itself. The router additionally rewrites `Location` headers
and scopes `Set-Cookie` paths on the way back, so a redirect or a session cookie
can't escape its module.

`/pathfinder` is **passed through whole**: Next.js `basePath` expects to see
`/pathfinder` in the path and generates correctly prefixed asset URLs on its own.

### Why Finance links out instead of being proxied

`finapp-v3` receives Plaid webhooks, serves an MCP endpoint, and runs its own
OAuth server (`/.well-known/oauth-authorization-server`, issuer = `APP_URL`).
None of those callers can present a Cloudflare Access token, so proxying it
behind the portal would block them — and webhook failures are silent, surfacing
days later as stale transactions. It also has its own Supabase login, so Access
would be a second sign-in rather than the sign-in.

It stays on `finance.elevrics.ai` with a launcher card pointing at it. The
portal is still the single front door; only this one card leaves the origin.

### Parked hosts

`pathfinder.elevrics.ai` is parked on this same Worker, serving a public
"coming soon" placeholder from `public/pathfinder-coming-soon/`. The name is
reserved for future onboarding/marketing use; the internal relocation tool
lives at `portal.elevrics.ai/pathfinder` and is unrelated.

Parked hosts are matched **before** any path routing, so a public hostname can
never reach an internal module — without that guard,
`pathfinder.elevrics.ai/solayard` would proxy to the internal dashboard. The
origin would still reject it for carrying no Access token, but it would confirm
to an anonymous visitor that the module exists. Asserted in `tests/`.

No Access application covers a parked host — that is the point. Do not add one.

---

## Authentication

One Cloudflare Access application covers `portal.elevrics.ai`. Every request
that reaches the router is already authenticated, and the
`Cf-Access-Jwt-Assertion` header is forwarded to each origin unchanged.

**The router is a convenience layer, not a security boundary.** The Fly
hostnames stay publicly reachable, so every origin verifies the Access token
itself — a direct hit on `*.fly.dev` has to be rejected there, not here.

---

## Local development

```bash
npm install          # only needed for wrangler
npm test             # router unit tests — no network, no wrangler
npx wrangler dev
```

`npm test` (in `tests/`) covers prefix matching, redirect rewriting and cookie scoping.

For an end-to-end check against the real apps, start the three origins locally
and run the integration harness — it imports the *actual* `onRequest` from
`src/router.js` and only swaps the module origins for localhost, so it
exercises the real routing code rather than a reimplementation:

```bash
# solayard-intel   URL_PREFIX=/solayard        flask --app app run --port 8077
# opportunities    URL_PREFIX=/opportunities   PORT=8099 npm start
# relocation                                   PORT=3999 npm start
npm run harness      # http://127.0.0.1:8090
```

The check that matters is not just that each path returns 200, but that the URLs
*inside* the proxied HTML are portal-correct and resolve through the router —
`/solayard/reference`, `/opportunities/styles.css`, and so on.

---

## Deployment

Cloudflare Workers Builds, connected to this repo. Pushing to `main` deploys.

Everything that matters is in `wrangler.jsonc`; the dashboard build settings
just need:
- **Build command** — none (no build step)
- **Deploy command** — `npx wrangler deploy`
- **Root directory** — `/`

`assets.directory` is `./public` deliberately. Pointing it at the repo root
sweeps in `node_modules/workerd` (122 MiB) and fails the 25 MiB per-asset
limit.

One-time Cloudflare setup:
1. Point `portal.elevrics.ai` at the Pages project.
2. Create one Access application for `portal.elevrics.ai`, policy: your email.
3. Set `URL_PREFIX` on the two prefix-stripped Fly apps
   (`fly secrets set URL_PREFIX=/solayard`, `.../opportunities`).

---

## Admin console

`/admin/` is a **shell** — static markup, no data source, no tenants. It exists
so the future client tier has somewhere to land.

It currently shares an origin with the internal modules, which is fine while it
is inert. **Split it to `admin.elevrics.ai` before it can read real client
data** — otherwise an XSS in any internal module could reach an admin session.
The markup and styles carry over unchanged.

See `docs/portal-feasibility.md` for the full architecture assessment, including
the per-client subdomain model (`{client}.elevrics.ai`) planned for the external
tier.
