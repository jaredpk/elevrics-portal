# Elevrics Portal

Internal portal for **portal.elevrics.ai** — one login, one front door for the
tools that used to live on their own subdomains.

Marketing (`elevrics.ai`) stays where it is, in `elevrics-site`. This repo is
internal only and is never indexed.

---

## What it does

A Cloudflare Pages project that serves a static shell and reverse-proxies each
tool onto a path:

| Path | Origin | Repo |
|---|---|---|
| `/` | static launcher | this repo |
| `/admin/` | static shell (skeleton) | this repo |
| `/solayard` | `solayard-intel.fly.dev` | `jaredpk/solayard-intel` |
| `/opportunities` | `elevrics-opportunities.fly.dev` | `jaredpk/elevrics-opportunities` |
| `/pathfinder` | `elevrics-relocation.fly.dev` | `jaredpk/elevrics-relocation` |

Routing lives in `functions/[[path]].js` — a Pages Functions catch-all.
Anything that doesn't match a module prefix falls through to the static shell.

### Two proxying modes

`/solayard` and `/opportunities` are **prefix-stripped**: the router removes the
prefix before forwarding, so the Flask and Express apps keep serving from root.
Each is told where it lives via a `URL_PREFIX` environment variable and emits
portal-space URLs itself. The router additionally rewrites `Location` headers
and scopes `Set-Cookie` paths on the way back, so a redirect or a session cookie
can't escape its module.

`/pathfinder` is **passed through whole**: Next.js `basePath` expects to see
`/pathfinder` in the path and generates correctly prefixed asset URLs on its own.

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
npx wrangler pages dev .
```

`npm test` covers prefix matching, redirect rewriting and cookie scoping.

For an end-to-end check against the real apps, start the three origins locally
and run the integration harness — it imports the *actual* `onRequest` from
`functions/[[path]].js` and only swaps the module origins for localhost, so it
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

Cloudflare Pages, connected to this repo. Pushing to `main` deploys.

Project settings:
- **Build command** — none (no build step)
- **Output directory** — `/` (repo root)
- **Functions** — picked up automatically from `functions/`

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
