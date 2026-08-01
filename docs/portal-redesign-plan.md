# Portal Redesign — Mirroring the Insights-Portal Concept

> **Status (2026-08).** Phases 0–2 are done. Phase 2 shipped with pathfinder's
> `injectChrome` flag off, exactly as the fallback below anticipated — the
> Next.js hydration question needs the real deployed app to answer, and the
> per-module flag is what makes shipping the other two without it possible.
> Phase 3 is next. Two palette findings surfaced during Phase 1–2 and were
> deliberately deferred in favour of keeping Elevrics branding as it stands;
> the measurements are recorded at the top of `public/css/portal.css`.

An assessment of the `lb-insights` concept against this portal, and a staged plan
for adopting it. Written 2026-08-01 against concept snapshot `lb-insights-dev-main`.

The concept is a Next.js app on Fly serving one product's own reports. This
portal is a Cloudflare Worker reverse-proxying three separately-hosted apps. The
gap between those two facts is the whole story — most of the concept's *look* is
cheap to adopt, and one part of its *structure* is not. This document separates
them.

---

## What the concept actually does well

Seven moves, in rough order of value-per-effort for us:

1. **A registry is the information architecture.** `apps/web/src/lib/reports.ts`
   declares departments → reports with `status`, `beta`, `description`, and
   `hrefFor()` as the single URL rule. The sidebar, the routes, and the redirects
   all render off that one list. Adding a report is a config entry — "never new
   plumbing."
2. **Persistent left rail instead of a top nav.** 64px icon rail that hover-expands
   to 288px, with a pin toggle persisted to `localStorage`. Chrome that survives
   navigation, so you always know where you are and what else exists.
3. **Brand tokens with assigned *roles*.** Four type tiers, each with a job:
   display (Bebas, uppercase + wide tracking) for nav labels and titles; serif
   (Libre Baskerville) bold-uppercase for section headers and italic for
   editorial asides; sans (Inter) for body; mono (JetBrains) for provenance and
   metadata. Colour is equally disciplined — navy/navy-deep, one accent, paper,
   one grey.
4. **A full-bleed hero band** — reversed logo on deep navy, thin accent rule,
   oversized display title, serif-italic subtitle (`BrandHero.tsx`). The same
   band leads the real report and the placeholder, so an unbuilt page still
   looks finished.
5. **Unbuilt things are first-class.** `status: "coming_soon"` gets a branded
   page (`ComingSoon.tsx`) and a "Soon" chip in the rail; `beta: true` gets a
   "Beta" chip. The hub reads as complete on day one.
6. **Access is visible.** `AccessIndicator` shows who can see the current page,
   page-aware, pinned to the bottom of the rail, plus an admin view log.
7. **The landing page asks rather than lists.** `/` is a composer with a
   personalised greeting, not a grid of links (`LandingChat.tsx`).

Items 1–5 are design and structure we can take almost directly. Item 6 is nearly
free here (see Phase 3). Item 7 is a product bet, not a redesign — treated
separately at the end.

---

## The one structural obstacle

The concept's rail is a React layout that wraps every page, because every page is
its own. Here, `/solayard` is Flask on Fly, `/opportunities` is Express on Fly,
`/pathfinder` is Next.js on Fly, and the router streams their HTML through
untouched. **The moment you click into a module today, the portal chrome
vanishes** — which is exactly the problem the rail solves, and exactly the thing
the proxy makes hard.

Three ways to get persistent chrome over proxied origins:

| | Approach | Cost | Verdict |
|---|---|---|---|
| **A** | Inject the rail into proxied HTML with Cloudflare `HTMLRewriter` | Low, one repo | **Recommended** |
| **B** | Iframe shell — rail is real DOM, module in a frame | Low to build | **No** |
| **C** | A shared chrome package imported by all three module repos | High, 3 repos, 3 stacks | Later, opportunistically |

**B is a trap.** The URL stops reflecting module state, so deep links, the back
button, bookmarks, and "send me that page" all break. It also breaks printing and
export flows. Not worth it.

**C is the correct end state** and the wrong starting point: three repos, three
languages, three deploy cycles, for chrome we haven't validated yet.

**A is right for now.** The router already sits in front of every module response
and already rewrites `Location` and `Set-Cookie` headers on the way back —
injecting markup is the same class of operation on the same seam. `HTMLRewriter`
is native to the Workers runtime and streams, so it costs no buffering.

### Risks of A, and how each is contained

- **CSS collisions with module styles.** Namespace everything `.elv-*`, put
  `all: revert` on the rail root, and set only custom properties globally. Never
  ship a bare element selector in the injected sheet.
- **Layout displacement.** The rail is `position: fixed` and the injected sheet
  sets `body { padding-left: var(--elv-rail-w) }` — one declaration to get wrong,
  one to revert.
- **React hydration.** Next.js App Router hydrates high in the tree and can
  object to unexpected `<body>` children. Pathfinder is the one module at risk.
  Inject last-in-`</body>`, test it specifically, and if it complains, leave
  pathfinder uninjected — the flag is per module.
- **The local harness runs in Node, where `HTMLRewriter` doesn't exist.** The
  codebase already solved this shape of problem: `handleRequest(request,
  serveAssets)` takes its asset fallback as a parameter so the harness can pass a
  stub. Do the same — pass the rewriter in, default it to `undefined`, skip
  injection when absent. The routing logic under test stays the deployed logic.
- **Blast radius.** Gate injection behind `injectChrome: true` per module in the
  registry. Enable one module at a time; disable by deleting a word.

---

## Should this repo adopt Tailwind / a framework?

**No — not for this.** The concept needs Next because it renders reports from a
validated payload. This portal's own surface is three static pages. Today it has
*no build step at all*: `wrangler deploy`, nothing else. That is a real asset,
and everything visual in items 1–5 above is reachable in roughly 300 lines of
vanilla CSS with custom properties.

Revisit only when the admin console stops being a shell and needs to render real
tenant data — that's a framework decision on its own merits, and per the README
it should land on `admin.elevrics.ai` anyway.

---

## Brand translation — mirror the system, not the palette

Do not adopt navy/electric-yellow/Bebas; that's Law Brothers' identity. Adopt the
*discipline*: give every token a role, then fill the roles with Elevrics values
already in `public/css/portal.css` and the marketing site.

| Role in the concept | Their value | Elevrics equivalent |
|---|---|---|
| Brand ground | `navy #0A1254` | `--navy #071833` (existing) |
| Hero band ground | `navy-deep #060B33` | New `--navy-deep`, a step darker than `--navy` |
| Accent (rules, active state, chips) | `accent #FFDE00` | `--teal #00A19A` — the terminal, brightest colour of the logo's purple→blue→teal ramp |
| Paper | `paper #F7F7F5` | `--offwhite #F7F8FB` (existing) |
| Muted text | `brandgrey #6B6E85` | `--midgray #6C7383` (existing) |
| Display face | Bebas Neue | **No new font.** Inter 600, uppercase, `letter-spacing: 0.09em` — the `.nav-tag` treatment already in the CSS, promoted to a documented tier |
| Editorial serif | Libre Baskerville | Skip. Elevrics has no serif tier and doesn't need an invented one |
| Mono | JetBrains Mono | `ui-monospace` — already used in `.card-meta`, just formalise it as a token and use it consistently for provenance/status metadata |

Four of the eight roles are already present in `portal.css` under different
names. The work is mostly promotion and documentation, not invention.

---

## Plan

### Phase 0 — One registry (½ day)

`src/router.js` already exports `MODULES` with `origin` and `stripPrefix`. That
object *is* the report registry from the concept, minus the presentation fields.
Extend it into `src/modules.js`:

```js
export const MODULES = {
  '/solayard': {
    origin: 'https://solayard-intel.fly.dev',
    stripPrefix: true,
    injectChrome: true,
    label: 'SolaYard Intel',
    initials: 'SI',
    accent: 'purple',
    group: 'Modules',
    status: 'live',
    blurb: 'External deadlines and signals the SolaYard roadmap depends on.',
    stack: 'Flask · SQLite',
  },
  // …
};
```

Routing and IA become one source of truth — the concept's strongest idea, and it
lands here more cleanly than it does there, because our router is already the
thing that knows every module.

Then delete the hand-maintained nav. The nav list is currently duplicated
verbatim in `public/index.html` and `public/admin/index.html`; a third page makes
three copies. Since `run_worker_first` means the Worker executes on every request
anyway, it can render the rail from the registry and inject it into its own
static pages by the same mechanism it will use for proxied ones — one code path,
tested once.

Also fix the stale comment at the top of `src/index.js`, which still claims
assets are served before the Worker runs. `run_worker_first` made that false.

**Ship criterion:** `npm test` covers registry→rail rendering; both static pages
show an identical rail with no duplicated markup.

### Phase 1 — Chrome and tokens (1–1½ days)

- Rewrite `public/css/portal.css` as a documented token layer + component layer,
  with the role table above as its header comment.
- Build the rail: 64px collapsed / 288px expanded, hover-expand, pin toggle
  persisted to `localStorage` (the concept's `PIN_STORAGE_KEY` pattern —
  initialise from a `useEffect` equivalent after first paint so injected markup
  can't flash at the wrong width). Icon tiles carry the collapsed state; labels
  appear on expand.
- Mobile: horizontal pill scroller, not a hamburger. The concept is right about
  this — pills keep every destination one tap away and visible.
- Hero band on `/` and `/admin/`: deep-navy full-bleed, logo, thin teal rule,
  large uppercase-tracked title.
- Status chips ("Soon", "Beta", "Shell") rendered from the registry's `status`.

**Ship criterion:** no visual regression on the two static pages, rail keyboard
navigable, `prefers-reduced-motion` respected on the width transition.

### Phase 2 — Chrome over the proxied modules (1–2 days, the risky one)

- Add the rewriter as an injected dependency to `handleRequest` alongside
  `serveAssets`; skip injection when it isn't supplied (Node harness).
- Inject on `Content-Type: text/html` responses only, and only when the module's
  `injectChrome` is true.
- Order of enablement, easiest origin first: **solayard** (Flask, server-rendered,
  minimal JS) → **opportunities** (Express) → **pathfinder** (Next.js, the
  hydration risk).
- Verify through the existing harness the way the README already frames it: not
  just that pages return 200, but that the injected rail's links are portal-space
  correct and the module's own layout is undisturbed.

**Ship criterion:** each module enabled independently, with a screenshot
before/after and confirmation that module-internal navigation still works. If
pathfinder resists, it ships uninjected and waits for Phase 4 / approach C.

### Phase 3 — The completeness moves (½–1 day)

- **Access indicator.** Cloudflare Access sets `Cf-Access-Authenticated-User-Email`
  on requests reaching the Worker — verify it arrives, then render "signed in as
  …" at the foot of the rail. This is the concept's item 6 for near-zero effort,
  and it makes the auth story visible instead of asserted. Keep it display-only;
  the README is emphatic that the router is not a security boundary, and this
  changes nothing about that.
- **Branded coming-soon pages** for any registry entry with
  `status: 'coming_soon'`, using the Phase 1 hero band — the same treatment the
  existing `public/pathfinder-coming-soon/` placeholder gets, so the parked host
  and the portal finally look like one product.
- Carry the new tokens into `public/pathfinder-coming-soon/index.html`, which is
  self-contained inline CSS today and must stay that way (no sub-resources to
  route on a parked host) — so this is a copy-in, not a link.

### Phase 4 — "Ask Elevrics" (not scheduled)

The concept's landing composer is its best product idea and its least portable
one. It works there because a validated JSON payload exists to ground answers on.
Here, the equivalent would have to span a Flask app's SQLite, an Express app's
SQLite, and a static relocation dataset — there is no payload to point a model
at, and building one is a data-pipeline project, not a redesign.

Recommendation: **keep the launcher grid as the landing for now**, and revisit
after Phase 2 proves the chrome. If it becomes real, the honest first version is
scoped search across the three modules — not a chat box that has nothing solid to
stand on.

---

## What not to copy

- **Their palette and type faces.** Adopt the role system; keep the Elevrics
  identity.
- **Department → report nesting.** They have nine departments and need two
  levels. We have four modules. A tree here is structure without content — the
  registry supports `group` for when a fifth and sixth module make it earn its
  place.
- **The "Projects — coming soon" rail section.** They can promise it because it's
  scoped and dated. An empty section we haven't committed to reads as neglect,
  not roadmap. Earn it first.
- **`unoptimized` image workarounds, `force-dynamic`, the pin-state hydration
  dance.** These are Next.js-specific scar tissue. Static HTML has none of those
  problems and shouldn't inherit their solutions.

---

## Sequence and effort

| Phase | Effort | Risk | Gets you |
|---|---|---|---|
| 0 — One registry | ½ day | None | Single source of truth; nav duplication gone |
| 1 — Chrome + tokens | 1–1½ days | Low | The concept's look on portal-owned pages |
| 2 — Chrome over modules | 1–2 days | **Medium** | Chrome that survives navigation — the actual prize |
| 3 — Completeness moves | ½–1 day | Low | Access visibility, branded placeholders |
| 4 — Ask Elevrics | — | High | Deferred; separate decision |

Phases 0–3 total roughly **3–5 days** and leave the no-build-step property
intact. Phase 2 is the one to prototype early against solayard, because if
injection turns out to be untenable, everything downstream reshapes around
approach C and it is much cheaper to learn that in week one.
