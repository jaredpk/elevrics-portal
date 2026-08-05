# Elevrics Portal — Feasibility Assessment

**Date:** July 2026
**Question:** Replace per-product subdomains (`solayard.elevrics.ai`, `pathfinder.elevrics.ai`, …) with a single portal that keeps the marketing site separate, hosts the existing tools as modules, and eventually supports multi-tenant client logins.

> **Superseded on the auth question (August 2026).** This assessment recommends
> one Cloudflare Access application over `*.elevrics.ai` as the phase-1 login,
> and names WorkOS as the right call for the multi-tenant tier later. That later
> call was brought forward: the portal runs its own WorkOS accounts and there is
> no Access application any more. `docs/auth-architecture.md` is the current
> answer for anything about identity, sessions, roles or per-client logins. The
> rest of this document — the module inventory, the routing analysis and the
> effort estimates — still stands.

---

## Verdict

**Feasible, and the first phase is genuinely easy — but the request contains two
different projects with a ~20x difference in difficulty, and they should not be
built as one thing.**

| | Difficulty | Effort |
|---|---|---|
| **A. Unified internal portal** — one login, one shell, your existing tools as modules | Low | **1–2 days** (2–6 days for true single-origin URLs) |
| **B. Multi-tenant client portal** — clients log in, see only their data | High | **3–6 weeks** for a credible first tenant |

The trap is assuming B is an extension of A. It isn't. A is a routing and
navigation problem. B is a data-model, identity, and liability problem, and
**none of the three tools you named can serve it** — which is the most important
finding in this assessment.

---

## What exists today

| Repo | Role | Stack | Data | Auth |
|---|---|---|---|---|
| `elevrics-site` | Marketing (`elevrics.ai`) | Pure static HTML/CSS, no build step | — | Public |
| `solayard-intel` | SolaYard Intel dashboard | **Flask 3 + Jinja SSR** (Python) | SQLite on Fly volume `intel_data` | **Cloudflare Access JWT** + basic-auth fallback for cron |
| `elevrics-opportunities` | Lead scanner | **Express 4 + vanilla-JS SPA** (Node) | SQLite on Fly volume `opportunities_data` | Shared `ADMIN_PASSWORD` → HMAC signed cookie |
| `elevrics-relocation` | Pathfinder | **Next.js 16 + React 19 + TS** | **No database** — a 278 KB static `dataset.json` | **None** (noindex header only) |

Three different stacks. Three separate SQLite databases on three separate Fly
volumes. Three different auth models. Marketing on Cloudflare Pages, the three
apps on Fly.

### The two facts that decide everything

**1. There is no concept of a user or a tenant anywhere in the codebase.**

- `solayard-intel` tables: `items`, `changes`, `task_phase`, `watch_content`
- `elevrics-opportunities` tables: `leads`, `suppressions`, `collector_runs`
- `elevrics-relocation`: no database at all

Not one table has an `owner_id`, `tenant_id`, or `user_id` column. There is no
users table. Every app is single-occupancy by construction: it assumes exactly
one viewer, and that viewer is you. `leads.domain` (`consulting` / `solayard`)
looks like tenancy but isn't — it partitions *content categories*, not
customers, and nothing enforces it as a security boundary.

**2. None of the three modules is client-facing, and two of them shouldn't be.**

- **SolaYard Intel** belongs to a different venture. Your own `idea-triage-2026-07.md`
  says the solar lane "is a different venture — the Elevrics site has zero solar
  content and should stay that way."
- **Elevrics Opportunities** is your private lead pipeline. It is arguably the
  single most sensitive thing you own — it lists prospects you are chasing.
- **Pathfinder** is a personal relocation POC, explicitly noindexed as
  "not ready."

So "clients logging in to get their data" is not about these three. It's about a
**fourth thing that doesn't exist yet** — and per your own triage doc, you
already know what it looks like: the lb-insights portal pattern (deterministic
pipeline → schema-validated payload → AI narrative → audit trail → governed chat).

---

## The recommendation: two portals, one identity layer

Do **not** put clients and internal tools in the same multi-tenant system. If a
tenant-scoping bug lets Client A see Client B's data, that's bad. If it lets
Client A see your lead pipeline or another venture's roadmap, that's
unrecoverable — and you sell "governance that survives an audit."

```
elevrics.ai              → marketing (static, Cloudflare Pages, unchanged)
portal.elevrics.ai       → INTERNAL. Cloudflare Access. Solayard Intel,
                           Opportunities, Pathfinder. Single-occupancy. Cheap.
{client}.elevrics.ai     → EXTERNAL. One app, one tenant per hostname.
                           Real IdP, real tenant model, own database.
                           Built once, on the lb-insights pattern.
```

See "Per-client subdomains" below — for the external tier this is the
recommended shape, and it is *not* a reversal of the decision to drop
per-product subdomains.

Separate apps, separate databases, separate deploys. They can share a design
system and even the same auth vendor — but never a database and never a process.

---

## Phase A — internal portal (1–2 days)

**You are most of the way there already.** `solayard-intel/app.py:40-66` already
verifies Cloudflare Access JWTs against a `elevrics.cloudflareaccess.com` team
domain. The Zero Trust tenant exists. The hard part is done.

1. Put **one** Cloudflare Access application in front of `*.elevrics.ai`
   (excluding the apex marketing site). One login covers every tool.
2. Swap `elevrics-opportunities` from its shared-password cookie to the same
   Access JWT check — it's ~30 lines, ported from the Flask version, and it
   *deletes* the login UI rather than adding one.
3. Add Access in front of Pathfinder, which currently has none.
4. Build a launcher at `portal.elevrics.ai` — a static page with a card per
   tool. This can be one HTML file on Cloudflare Pages.

Cost: $0. Cloudflare Access is free to 50 users. That gets you one login, one
front door, one place to add the next tool.

### If you want true single-origin URLs (`portal.elevrics.ai/solayard`)

Add **2–4 days**. A Cloudflare Worker routes path prefixes to the Fly origins.
The cost is that **all three apps hardcode root-absolute URLs** and every one
breaks under a path prefix:

- `solayard-intel`: `href="/"`, `href="/reference"`, `fetch('/items/column')`,
  `fetch('/collect')`, `href="/calendar.ics"` — plus 9 Flask routes registered at root
- `elevrics-opportunities`: `href="/styles.css"`, `src="/app.js"`, `fetch('/api/session')`
- `elevrics-relocation`: needs `basePath` in `next.config.ts` (Next.js handles
  this cleanly — the easy one)

None of this is hard, it's just tedious, and it must be done in three languages.

**My honest advice: skip it initially.** Ship the shared login and the launcher
first. Subdomains behind a single sign-on already deliver most of what you
actually want — one identity, one front door, one coherent product. Path-based
URLs are cosmetics you can buy later, per app, when a module is being touched
anyway.

---

## Phase B — multi-tenant client portal (3–6 weeks)

This is a new build, not a migration. What it actually requires:

**Identity (~3–5 days).** Cloudflare Access does not scale to this — it's an
IdP gate, not a tenant system. It gives you an authenticated email; it gives you
no roles, no tenant membership, no self-service invites, no billing hooks. You
need a real provider. Given the ICP is mid-market law firms and
compliance-sensitive orgs, **WorkOS** is the right call if enterprise SSO/SAML
will be asked for (it will be, by law firms); **Clerk** is faster to ship if it
won't. Either is a few days of work.

**Tenant data model (~1 week).** Organizations, memberships, roles, invitations.
Every domain table carries `tenant_id`. Every query filters on it — enforced at
the data-access layer, not left to individual route handlers, because one
forgotten `WHERE` is a breach. Postgres with row-level security is the
belt-and-braces version and worth it here.

**Move off SQLite (~2–3 days).** SQLite on a single Fly volume is genuinely fine
for single-occupancy internal tools — it's why the current setup is nearly free.
It's the wrong substrate for multi-tenant client data: one writer, one machine,
no horizontal scale, and volume snapshots as your only backup story. Fly
Postgres or Neon.

**Audit + governance (~1 week).** Access logging (who viewed which tenant's data
and when), data-retention policy, DPA template, incident response. Not optional
overhead — this *is* the product you sell. A client portal from the "governance
that survives an audit" firm gets held to a higher standard than a typical SaaS
MVP, and the first enterprise security questionnaire from a law firm will ask
for all of it.

**The actual client-facing feature (~1–2 weeks+).** Everything above is
scaffolding. The thing clients log in to *see* is the lb-insights pattern, and
that's the part with real product design in it.

### What NOT to do

**Don't retrofit tenancy into the three existing apps.** Adding `tenant_id` to
`items` and `leads`, rewriting every query, and re-auditing two codebases in two
languages costs more than the internal portal is worth — and buys nothing,
because those tools will never have external tenants. Leave them
single-occupancy behind Cloudflare Access. If SolaYard Intel ever needs to be
multi-user, that's a SolaYard decision, on SolaYard's roadmap.

---

## Per-client subdomains (`acme.elevrics.ai`) — assessment

**Recommended for the external tier.** This is the right shape, and adopting it
costs roughly **+2–3 days** of wildcard/host-resolution plumbing on the Phase B
estimate — while potentially *saving* a week early on (see "IdP deferral" below).

### Why this isn't a contradiction of dropping product subdomains

It looks like a reversal. It isn't — **the axis changed, and that's what makes
the same mechanism flip from wrong to right.**

- **Product subdomains** (`solayard.` / `pathfinder.` / `opportunities.`) split
  **one user across many products**. You pay the fragmentation cost personally,
  every single day, because you use all three.
- **Client subdomains** (`acme.` / `globex.`) split **many users across one
  product**. Each client only ever visits their own hostname. They never
  experience fragmentation at all — there is nothing to unify from their side.

The fragmentation cost lands on you again, but only for cross-client work, and
that's solved by one admin console rather than by collapsing the namespace.

### Pros

1. **Tenant resolved before app code runs.** The hostname gives you a second,
   independent tenant signal to cross-check against the session's claims. If
   session says `acme` and host says `globex`, reject. This is real defense in
   depth against the highest-severity risk in the whole project — the forgotten
   `WHERE tenant_id = ?`. A single-domain portal has no equivalent backstop.
2. **Structural cookie isolation.** Cookies scoped to `acme.elevrics.ai` are
   never sent to `globex.elevrics.ai` (provided you never set
   `Domain=.elevrics.ai`). A session token for one tenant *cannot* physically
   reach another, and an XSS on one tenant's subdomain can't read another
   tenant's cookie. You get this from the browser for free; you cannot buy it
   on a single domain.
3. **IdP deferral.** Each subdomain can be its own Cloudflare Access
   application with its own allowed email domain. For the first handful of
   clients that may be *all the identity you need* — no Clerk/WorkOS, no
   password reset flows, no invitation UI. That's potentially a week off the
   Phase B critical path, and it's an upgrade path rather than a dead end.
4. **Sales asset.** `acme.elevrics.ai` reads as bespoke to a law-firm buyer in
   a way `elevrics.ai/clients/acme` does not, and it upgrades cleanly to a
   full vanity domain (`portal.acmelaw.com` via CNAME) when someone asks.
5. **Per-tenant infrastructure stays on the table.** If a compliance-sensitive
   client demands their own database, host-based routing lets you point one
   tenant at separate storage without redesigning anything.
6. **Clean attribution.** Hostname is in every log line, every metric, every
   Access audit entry, with no application-level tagging.

### Cons

1. **Client roster leakage — the one to take seriously.** Public DNS and
   Certificate Transparency logs can expose your client list to anyone who
   enumerates them. For a consulting firm with confidentiality expectations
   this is a genuine problem. *Mitigation:* use only the wildcard
   `*.elevrics.ai` certificate — never issue per-name certs, since those get
   published to CT individually. Wildcard DNS means individual names don't
   need public records either. Verify this before onboarding client one; it's
   easy to get right up front and awkward to fix later.
2. **Multi-tenant users are awkward.** Cookie isolation cuts both ways: you,
   as admin on every client, get a separate session per hostname. Solved by a
   dedicated cross-tenant admin console, not by fighting the model.
3. **Cross-subdomain SSO needs deliberate design.** Free with Cloudflare Access
   (the team domain handles it). With Clerk it means satellite domains, which
   are fiddly and priced; WorkOS handles it cleanly. Factor this into the IdP
   choice rather than discovering it later.
4. **Provisioning risks becoming an infra operation.** Adding a tenant should
   stay `INSERT INTO organizations`. It will — *if* you set up wildcard DNS and
   a wildcard Access policy from the start. Configure per-client DNS records
   and per-client Access apps instead and you've bought yourself manual toil on
   every signup. Design for the wildcard on day one.
5. **TLS depth limit.** Cloudflare Universal SSL covers the apex and one
   wildcard level (`*.elevrics.ai`) for free. `acme.portal.elevrics.ai` is two
   levels and needs Advanced Certificate Manager (~$10/mo). Keep clients at the
   first level and this costs nothing.
6. **Local dev friction.** Wildcard hostnames locally (`*.localtest.me` or
   `/etc/hosts`) and host-aware tests. Minor but real.

### What it does *not* change

Subdomains change how a tenant is *resolved* and how sessions are *isolated*.
They do **not** remove the need for organizations, memberships, roles,
`tenant_id` on every row, or query-layer enforcement. Host-based routing is a
valuable second lock — it is not the lock. Treating the subdomain as the
security boundary, with unscoped queries behind it, would be the single most
dangerous way to build this.

### Recommended storage shape

Given the ICP — a handful of high-value, compliance-sensitive clients rather
than thousands of self-serve accounts — **Postgres schema-per-tenant** is the
sweet spot. One app, one database server, one connection pool; provisioning is
`CREATE SCHEMA`; isolation is enforced by the search path rather than by every
developer remembering a `WHERE` clause. It also gives you a straight answer to
the security questionnaire question that law firms actually ask: *"is our data
in its own database?"* Full database-per-tenant is stronger still and worth it
only if a specific contract demands it. A single shared table with `tenant_id`
is the standard SaaS answer, but it puts the entire isolation guarantee on
application code — a weaker position for this specific buyer.

### Verdict

Adopt it for the client tier. Keep `portal.elevrics.ai` consolidated for
internal tools, add `admin.elevrics.ai` for your cross-tenant console, and give
each client `{client}.elevrics.ai` served by one host-aware app. Wildcard DNS,
wildcard cert, wildcard Access policy — all configured before the first client,
so onboarding stays a database write.

---

## Risks worth naming

| Risk | Note |
|---|---|
| **Scope conflation** | Treating "portal" as one project is the main failure mode. A is days; B is weeks. Bundling them means shipping neither. |
| **Tenant isolation bugs** | The highest-severity risk in B. Enforce at the data layer, not per-route. Test with a deliberate cross-tenant fetch in CI. |
| **Blast radius** | Your lead pipeline and a second venture's roadmap must not live in the tenant-accessible system. This is why two portals, not one. |
| **Three-stack drag** | Python + Node + Next.js is fine for isolated tools, painful for a shared shell. Every cross-cutting change is written three times. Long-term, new modules should be Next.js. |
| **SolaYard brand bleed** | Solar content inside an Elevrics-branded portal contradicts the positioning discipline your triage doc is emphatic about. Internal-only placement resolves it; a client-visible portal would not. |
| **Fly cost** | Today ~free (solayard scales to zero). A client portal needs a warm machine + Postgres — call it $20–40/mo. Not a blocker, just no longer $0. |

---

## Recommended sequence

1. **This week (1–2 days).** One Cloudflare Access app over `*.elevrics.ai`.
   Port Opportunities to Access JWT (deletes code). Put Access over Pathfinder.
   Static launcher at `portal.elevrics.ai`. → One login, one front door, $0.
2. **When convenient.** Path-based routing per app, one at a time, only when
   you're already in that codebase.
3. **When a real client is on the line.** Build the client tier fresh:
   Next.js + Postgres (schema-per-tenant) + host-based tenant resolution,
   tenant-scoped from commit one, on the lb-insights pattern. Set up wildcard
   DNS, the wildcard cert, and a wildcard Access policy *before* onboarding, so
   adding client two is a database write. Start with Cloudflare Access for
   identity and upgrade to WorkOS when someone asks for SAML. Don't build it
   speculatively — build it for a named first client, because their actual
   requirements will determine the data model.

Step 1 is worth doing regardless of whether step 3 ever happens. Step 3 should
not start until there's a client attached to it.
