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
| `/finance` | `finapp-v3.fly.dev` | `jaredpk/finapp-v3` |

`src/modules.js` is the registry — the single source of truth for what the
portal contains. `src/router.js` proxies from it, `src/nav.js` renders the nav
and launcher grid from it, and `src/index.js` is the Worker entrypoint. The
Worker runs on **every** request (`assets.run_worker_first`) and hands anything
that isn't a module route back to `ASSETS`, so 404s come from the same place as
the rest of the shell.

`src/auth/` is the account system (WorkOS AuthKit — see **Authentication**
below), and `src/retired.js` holds hostnames that used to be their own front
door. Both are host- or path-matched *before* the module registry is consulted,
so neither can be shadowed by a module.

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

### The registry

Adding a module is an entry in `src/modules.js` — its origin, whether the prefix
is stripped, and the presentation fields (label, blurb, stack line) that the nav
and the launcher card need. Nothing else has to change.

Three kinds of entry:

- **Proxied** — has an `origin`. The router forwards to it.
- **Portal-owned** — no `origin` (`/`, `/admin`). Served from `public/`; still
  in the nav, but `matchModule()` skips it so it falls through to `ASSETS`.
  That check is why `/` — a prefix of every path — can safely live here.
- **External** — `external: true`, keyed by its URL instead of a path. Linked
  and never proxied. No entry uses this today (Finance did, until it moved into
  the portal), but the kind is kept: "link, don't proxy" is still the right
  answer for anything whose callers can't present a token.

The URL key is the point, not a formatting choice: `matchModule()` only
forwards entries whose key starts with `/`, so no `pathname` can ever match an
external entry — the guard holds even if someone later adds an `origin` to one,
reading it as "where it lives" rather than "proxy this". Both halves are
asserted in `tests/` against a fixture entry, since no real module is external
right now — a guard that only runs when something happens to use it is a guard
that rots.

A fourth axis crosses those: `status`. `live` renders no chip; anything else
(`shell`, `beta`, `coming_soon`) chips itself in the rail and on its card, so a
thing that is not yet what it looks like says so everywhere it appears. A
`coming_soon` entry needs no origin and no files — the router serves it a
branded page, so a module can be listed the day it is decided rather than the
day it ships, and the "Soon" chip leads somewhere deliberate instead of to a
404. Only an exact match: `/demands` and `/demands/` render, `/demands/anything`
stays a 404 rather than inventing pages nobody published.

### Chrome injection

The rail is rendered by the Worker and stapled into pages with `HTMLRewriter`,
in two modes:

- **Portal-owned pages** carry `<nav data-portal-nav>` and (on the launcher)
  `<div class="card-grid" data-portal-cards>` placeholders to fill.
- **Proxied modules** have neither, so the rail is *appended* to `<body>` and
  `chrome.css` linked into `<head>`. Appended rather than prepended: it is the
  least invasive place to put a node in someone else's document, and the rail is
  position-fixed at every breakpoint precisely so its DOM position never
  matters.

Both modes also get an inline `<head>` snippet that restores the pinned rail
before first paint, a deferred `/js/portal.js` for the toggle, and an
`elv-chrome` class on `<html>` — set server-side, so the body inset that clears
the fixed rail is right even with JavaScript off.

Two guards matter:

- **Per-module opt-in.** `injectChrome` in the registry, so origins are
  decorated one at a time and undone by deleting a word. Pathfinder is
  deliberately **off**: Next.js App Router hydrates from `<html>`, so an extra
  `<body>` child is the one place React may object. Turn it on only after
  confirming the deployed app logs no hydration error.
- **Documents only.** A Flask or Express app may answer XHR with `text/html`
  partials, and a navigation rail spliced into a table fragment would be a mess.
  `Sec-Fetch-Dest: document` decides, falling back to `Accept` where the header
  is absent, and declining when neither says so. Failing closed costs a rail;
  failing open corrupts a page.

`HTMLRewriter` is a Workers global with no Node equivalent, so the injector is
passed into `handleRequest()` the same way the asset fallback is: the unit tests
and the local harness pass none and route identically, and the markup itself is
tested directly against `src/nav.js`.

Parked hosts are never injected. Their placeholder is public, and it must not
advertise the internal module list.

### Chrome and design tokens

Two stylesheets, split by where they have to survive:

- **`chrome.css`** — the rail, the chips, the module identity colours, and the
  token VALUES. This is the sheet that gets injected into pages we don't own,
  so every selector is class-based and `elv-` prefixed, and exactly one rule
  (`html.elv-chrome body`) reaches outside the rail.
- **`portal.css`** — everything that only ever renders on the portal's own
  pages: hero band, launcher grid, admin lists. It aliases chrome.css's tokens
  to short names, so the hexes have one home and the two surfaces can't drift.

A class already outranks any element selector a host page carries, however deep.
It does **not** outrank a host's `!important` — and `nav a { color: red
!important }` is ordinary in real stylesheets, while our rail *is* a `<nav>` full
of `<a>`. Measured against a hostile stand-in origin, that single rule repainted
every rail link red at 30px. Specificity decides again between two important
declarations, so chrome.css carries an **armour** block: class-based
`!important` on the properties a host is likely to set generically (colour,
type, list and box resets). Layout internals stay normal — `!important` should
have the smallest surface that works.

Every token has a ROLE, and the role is the thing to reason about when something
new needs a colour. Values stay Elevrics; only the discipline is borrowed from
the insights-portal concept (see `docs/portal-redesign-plan.md`).

Two conventions are load-bearing:

- **Module accents are identity, not palette.** Each module's initials tile
  carries the same colour in the rail and on its launcher card, because the
  collapsed rail has nothing else to identify a destination by. Don't reuse
  purple/blue/teal/green/gray to mean anything.
- **Text on a wash gets its own token.** `--accent` and `--muted` both pass
  contrast on white and both fail on their own 10–16% tint at chip size (2.9:1
  and 3.9:1). `--accent-ink` / `--muted-ink` are the darkened values that pass;
  use them anywhere type sits on a wash.

### Quick switch

`⌘K` / `Ctrl+K`, or the search row at the top of the rail, opens a jump-to over
every destination. It earns its place inside the **proxied modules** most of
all: deep in SolaYard there is no launcher grid to go back to, and the collapsed
rail is six unlabelled tiles.

Its list is **read off the rail**, not passed in separately. The rail is already
rendered from the registry, so reading it back means there is no second copy to
drift — whatever the server decided is in the nav, including which entry is
current and which leaves the portal, is exactly what the switcher offers.
An external entry would open in a new tab from here because it does from there.

The button ships `hidden` and `portal.js` reveals it: it does nothing without
JavaScript, and a control that does nothing is worse than no control. Everything
else in the rail — links, current page, identity, layout — is server-rendered
and works either way.

One known limitation: a proxied module could bind `⌘K` itself, and we can't
detect that. We never take the chord while focus is in a field, and neither of
the two decorated modules binds it today; if one ever does, the fix is a
per-module flag in the registry, the same shape as `injectChrome`.

### The rail

The rail auto-collapses to an icon strip and expands on hover **or focus** —
the focus half is what keeps it usable from the keyboard. Pinning keeps it open
and reflows the page instead of overlaying, and persists to `localStorage`.
Below 860px it becomes a horizontal pill scroller pinned to the top rather than
a hamburger: nothing hides behind a menu at five entries, and pinning it means
the bar lands correctly whether the rail was injected at the start of a page or
appended to the end of one.

### Two proxying modes

`/solayard` and `/opportunities` are **prefix-stripped**: the router removes the
prefix before forwarding, so the Flask and Express apps keep serving from root.
Each is told where it lives via a `URL_PREFIX` environment variable and emits
portal-space URLs itself. The router additionally rewrites `Location` headers
and scopes `Set-Cookie` paths on the way back, so a redirect or a session cookie
can't escape its module.

`/pathfinder` and `/finance` are **passed through whole**. Next.js `basePath`
and Vite `base` both expect to see the prefix and generate matching asset URLs
from it; finapp additionally strips the prefix server-side, so all of its routes
stay registered at root — which is how its machine callers still reach it
unprefixed.

### Finance keeps machine callers on the Fly hostname

`finapp-v3` receives Plaid webhooks, serves an MCP endpoint, and runs its own
OAuth server. None of those callers can present a portal assertion, so they keep
hitting `finapp-v3.fly.dev` unprefixed — the same split SolaYard already uses
for its GitHub Actions cron. `APP_URL` stays on the Fly hostname, so the OAuth
issuer is stable and no MCP client has to re-authorize.

Its Supabase login was removed rather than stacked underneath: the app has no
user model (hardcoded allowed email, identity never read downstream), so the
portal sign-in replaces it and one login covers every module.

### Parked hosts

`pathfinder.elevrics.ai` is parked on this same Worker, serving a public
"coming soon" placeholder from `public/pathfinder-coming-soon/`. The name is
reserved for future onboarding/marketing use; the internal relocation tool
lives at `portal.elevrics.ai/pathfinder` and is unrelated.

Parked hosts are matched **before** any path routing, so a public hostname can
never reach an internal module — without that guard,
`pathfinder.elevrics.ai/solayard` would proxy to the internal dashboard. The
origin would still reject it for carrying no portal assertion, but it would
confirm to an anonymous visitor that the module exists. Asserted in `tests/`.

A parked host is answered before the sign-in gate and serves nothing but its
placeholder — that is the point. Do not put a login in front of one.

---

## Authentication

**One login: portal-owned accounts on WorkOS AuthKit.** The portal used to sit
behind a Cloudflare Access application as well — emailed one-time codes, no user
model — so signing in meant doing it twice. Access is gone.
`docs/auth-architecture.md` is the full assessment and the rollout that got here;
this is the operating summary.

### There is no mode in which auth is off

The `AUTH_MODE` flag (`access` → `shadow` → `enforce`) existed to sequence the
move off Access, and it went with it. A three-state gate whose two permissive
states are no longer reachable is a foot-gun with an environment variable
attached: the one setting you never want reachable by accident is
"authentication off". Enforcement is a property of the code now, not of the
deploy.

What replaces it as the safety net is failing **closed and legibly**. A deploy
missing `WORKOS_CLIENT_ID`, `WORKOS_API_KEY` or `SESSION_SECRET` cannot mint a
session, so every non-public path answers `503 auth_not_configured` naming the
missing secret — rather than redirecting to a sign-in that cannot complete, and
emphatically rather than falling open the way an unconfigured deploy used to.

### The constraint that shaped the cutover

Every Fly origin verifies its own token, because the Fly hostnames stay publicly
reachable and a direct hit on `*.fly.dev` has to be rejected *there*. Taking
Access off `portal.elevrics.ai` stopped the origins receiving
`Cf-Access-Jwt-Assertion`, so each one had to accept the portal's own assertion
first — see below. That property has not changed and must not: **the router is a
security boundary now, but it is not the only one.**

### What the portal owns, and what it doesn't

**WorkOS owns** the password form, hashing, email verification, password reset,
credential-stuffing defence, TOTP, passkeys, and — later — SAML connections and
directory sync. There is no `/auth/register` and no `/auth/forgot-password` in
this repo: they are AuthKit screens reached from the same authorize call with a
different `screen_hint`. Avoiding a second place that collects a password is a
security requirement here, not only a UX one.

**The portal owns** the session cookie, route protection, roles as they apply to
modules, and the assertion the modules verify.

### Session

`__Host-elv_session` — AES-GCM sealed (it carries a refresh token, so signing
alone is not enough), HttpOnly, Secure, SameSite=Lax. The `__Host-` prefix is
browser-enforced: no `Domain`, so the cookie can never reach a sibling subdomain.
Sliding refresh with a hard 30-day ceiling carried across refreshes.

Sign-out is a **POST** — a GET sign-out fires from any `<img>` and gets triggered
by link prefetchers — and it ends the AuthKit session too, not just ours.
`/auth/revoke` is "sign out everywhere": a floor timestamp in KV that kills older
sessions at their next refresh, i.e. within minutes rather than instantly. That
bound is the trade for having no session table.

### The module assertion — what replaced the Access JWT

The router mints `X-Elevrics-Assertion`: an ES256 JWT, 120 seconds, `aud` set to
the module's routing prefix, with the public keys at
`/.well-known/portal-jwks.json`. Each origin swapped its Access verifier for this
one — fetch a JWKS, check signature, `iss`, `aud`, `exp` — a substitution in code
that already existed, not a new code path.

Two properties are load-bearing:

- **Every inbound `X-Elevrics-*` header is deleted before ours is added.**
  Otherwise a caller could present a captured token to the portal and have the
  router forward it to a module taught to trust exactly that header.
- **`aud` is the prefix**, so a token minted for `/finance` cannot be replayed
  against `/solayard`.

`ASSERTION_SIGNING_KEY_NEXT` is published alongside during rotation, so rotating
is a sequence rather than an outage.

**The router is not the only boundary, and must not become one.** Every origin
keeps verifying for itself — `*.fly.dev` is still reachable directly.

`ASSERTION_SIGNING_KEY` is therefore not optional in practice: without it no
assertion is minted, and an origin that verifies properly rejects the request.

**The JWKS path needs a bot-protection exemption**, and this is not optional
either. Cloudflare's bot filtering runs at the edge, before the Worker, so it
can refuse an origin's fetch with a 403 the Worker never sees — and an origin
that cannot load the JWKS refuses every request, which presents as a total
auth outage with no clue in it. This is not theoretical: it took
`solayard-intel` down, because `PyJWKClient` fetches through urllib and
`Python-urllib/3.x` is filtered. `curl` from a laptop succeeded throughout.

Add a WAF skip rule for `/.well-known/portal-jwks.json`. Origins should also
send an identifying `User-Agent`, but that is a courtesy on their side — the
endpoint is published for machines, so the edge is where this belongs.

### Roles

`requiresRole` in `src/modules.js`. Its *absence* means "any signed-in account",
which is the right default for an internal portal where signing in is the
boundary; `/admin` declares `admin` now, while the console is inert, so the gate
is in place on the day it first reads real data. A required role plus a session
carrying no roles is a **deny** — "not rolled out yet, so allow" would make the
gate silently absent during exactly the window nobody is watching it.

`requiredRoleFor()` deliberately does not come from `matchModule()`: that is a
*proxy* lookup and skips origin-less entries, and `/admin` is one.

### Rate limiting

WorkOS owns credential brute force (it owns the form). The real limit is a
**Cloudflare rate-limiting rule on `/auth/*`**, which runs before the Worker —
configure it in the dashboard; it is not in this repo. `src/auth/ratelimit.js` is
the KV backstop for when that rule is missing, and it **fails open**: a limiter
whose own storage outage takes sign-in down has inverted its job.

### Configuration

Vars are in `wrangler.jsonc`. Secrets are not:

```bash
npx wrangler secret put WORKOS_CLIENT_ID
npx wrangler secret put WORKOS_API_KEY
npx wrangler secret put SESSION_SECRET          # 32+ random bytes
npx wrangler secret put ASSERTION_SIGNING_KEY   # ES256 private JWK, as JSON
```

Generate the signing key with:

```bash
node -e "crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify'])
  .then(k=>crypto.subtle.exportKey('jwk',k.privateKey))
  .then(j=>console.log(JSON.stringify({...j,kid:'portal-1'})))"
```

KV is optional (`npx wrangler kv namespace create AUTH_KV`, then uncomment the
binding). Without it, sign-in works; only global revocation and the rate-limit
backstop are absent, and both degrade deliberately rather than silently.

---

## `finance.elevrics.ai` is retired

Finance is a module at `/finance`, not a separate front door. The old hostname is
parked on this Worker and answers three ways, because three different kinds of
traffic arrive there and one blanket redirect breaks one of them:

| Request | Answer |
|---|---|
| Anything a browser asks for | **301** to the same path under `/finance` — the mapping is one-to-one, since finapp is prefix-passed-through and strips the prefix itself. `Cache-Control: max-age=86400` bounds the browser cache; a 301 with none is cached effectively forever. |
| `/api/*`, `/webhook*`, `/mcp*`, `/oauth*`, `/.well-known/*`, `/health*` | **410 Gone**, naming `finapp-v3.fly.dev`. Never a redirect: a webhook POST sent at an authentication wall gets HTML back, which Plaid records as something other than an error while the transaction never lands. A 410 fails loudly at the caller instead. Plaid and MCP are confirmed pointed at the Fly hostname, so this should never fire — it stays because ten lines against a silent financial-integration failure is a trade worth making. |

There is **no retirement-notice interstitial**. An earlier pass had one behind a
mode flag; the portal has one user, who made the decision, so it was a page to
maintain and a flag to remember to flip for an audience of zero.

Answered before any session check (being made to sign in to learn where something
moved is hostile) and before any path routing (so a retired host can never proxy
to an internal module — the same guard the parked hosts carry).

**The cutover is not in this repo, and it is optional.** None of the above runs
until `finance.elevrics.ai` actually resolves to this Worker; without that, the
code sits inert and the name simply stops working once it is removed from Fly.
Pointing it here buys one thing: the browser autocompletes the old hostname from
history for months, and routed, that muscle memory lands in `/finance` instead of
on a DNS error. Steps in `docs/auth-architecture.md`.

---

## Local development

```bash
npm install          # only needed for wrangler
npm test             # router unit tests — no network, no wrangler
npx wrangler dev
```

`npm test` (in `tests/`) covers prefix matching, redirect rewriting, cookie
scoping, that the nav and launcher stay derived from the registry, the auth
layer (sealing, the guard, the assertion, the callback's state check) and the
retired-host mapping.

The injection itself needs the Workers runtime, so it is checked under
`npx wrangler dev` rather than in Node: that `/` and `/admin/` render the nav
with the right entry marked current, that a parked host gets no nav at all, and
that non-HTML assets pass through byte-identical.

For the proxied side, point the module origins at a local stand-in that styles
its OWN `.rail`, `.chip` and `.card`, and sets `!important` on `a`, `span`,
`ul`, `button` and `svg`. Both directions have to hold: the rail keeps its own
type and colour, and the module's page is left exactly as its author styled it.
That test is what caught the armour gap — and a browser screenshot is what
caught the tiles rendering flat, because the class name in the markup and the
one in the CSS had drifted apart while the unit test still passed on a
substring. A screenshot caught the second one too: a `coming_soon` chip
rendering its raw status, unstyled and wide enough to truncate the label beside
it. Look at the pages, not only the assertions.

There is no header that fakes an identity any more. `Cf-Access-Authenticated-User-Email`
used to be read for the rail's footer, because Access set it and nothing else
could; with Access gone it is a header anyone can type, so it is ignored. The
only way to be a viewer is to hold a session, which is why `wrangler dev` shows
no footer and why `npm run harness` mints itself a real sealed cookie with a
per-process secret rather than running with auth off (there is no "off").

The auth layer is unit-tested in Node (Web Crypto is a global in Node ≥ 20, so
sealing, the assertion and the guard all run without wrangler). What needs a
deploy is the part that talks to WorkOS — `wrangler dev` can reach the API with
real secrets in `.dev.vars`, but the redirect URI has to be a real hostname, so
the sign-in round trip is only verifiable against the deployed Worker.

The retired host is testable locally without DNS, since it is matched on the
`Host` header:

```bash
curl -i -H 'Host: finance.elevrics.ai' http://127.0.0.1:8788/accounts        # 301
curl -i -H 'Host: finance.elevrics.ai' http://127.0.0.1:8788/api/plaid/webhook  # 410
```

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
1. Point `portal.elevrics.ai` at this Worker.
2. Set the four auth secrets (`npm run setup:auth`). The portal serves nothing
   without them — there is no Access application in front any more, so a deploy
   missing a secret answers 503 rather than falling back to an edge login.
3. Set `URL_PREFIX` on the two prefix-stripped Fly apps
   (`fly secrets set URL_PREFIX=/solayard`, `.../opportunities`).
4. Add a rate-limiting rule on `/auth/*` (see Authentication above — the
   in-Worker limiter is only the backstop). `/auth/*` is publicly reachable now
   that nothing sits in front of the portal, so this is the real limiter.
5. Add a WAF custom rule: **Skip → Browser Integrity Check** on
   `/.well-known/portal-jwks.json`. BIC is on by default and refuses
   non-browser user agents with a 403 the Worker never sees — see Authentication
   above. Without it an origin can be unable to load the key and refuse
   everything, which presents as an auth bug rather than an edge setting.
6. Route `pathfinder.elevrics.ai` and `finance.elevrics.ai` at this Worker too.
   The parked-host and retired-host guards are both host-matched, so neither
   does anything until the hostname actually arrives here.

**Do not add an Access application back in front of `portal.elevrics.ai`.** It
would be a second login on top of the one that is now authoritative, and the
origins no longer verify its token.

### If sign-in is broken and you are locked out

There is deliberately no bypass flag — one would be a code path in the deployed
Worker that turns authentication off, which is worse than the outage it fixes.
The recovery is `npx wrangler tail` (the callback logs a short `reason` for every
refusal, and `X-Elevrics-Auth-Error` carries the same value on the response) plus
`npx wrangler rollback` to the previous deployment. `npm run setup:auth` is safe
to re-run; it rotates the two generated secrets, which signs out existing
sessions and nothing else.

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
