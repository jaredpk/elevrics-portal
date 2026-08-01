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

`src/modules.js` is the registry — the single source of truth for what the
portal contains. `src/router.js` proxies from it, `src/nav.js` renders the nav
and launcher grid from it, and `src/index.js` is the Worker entrypoint. The
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

### The registry

Adding a module is an entry in `src/modules.js` — its origin, whether the prefix
is stripped, and the presentation fields (label, blurb, stack line) that the nav
and the launcher card need. Nothing else has to change.

Three kinds of entry:

- **Proxied** — has an `origin`. The router forwards to it.
- **Portal-owned** — no `origin` (`/`, `/admin`). Served from `public/`; still
  in the nav, but `matchModule()` skips it so it falls through to `ASSETS`.
  That check is why `/` — a prefix of every path — can safely live here.
- **External** — `external: true`, keyed by its URL instead of a path
  (Finance). Linked and never proxied.

The URL key is the point, not a formatting choice: `matchModule()` only
forwards entries whose key starts with `/`, so no `pathname` can ever match an
external entry — the guard holds even if someone later adds an `origin` to one,
reading it as "where it lives" rather than "proxy this". Both halves are
asserted in `tests/`, because getting it wrong breaks Plaid webhooks silently
(see below).

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

In the registry it is `external: true` and keyed by its URL, which is what makes
proxying it structurally impossible rather than merely discouraged. Both the
rail entry and the card open in a new tab and carry an ↗ affordance plus
screen-reader text, so leaving the portal is visible rather than surprising.

One consequence for the chrome work: the rail cannot follow you to Finance. It
is a separate origin the Worker never sees, so there is nothing to inject into
— the ↗ is doing real work there, marking the one edge of the portal.

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

`npm test` (in `tests/`) covers prefix matching, redirect rewriting, cookie
scoping, and that the nav and launcher stay derived from the registry.

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
substring.

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
