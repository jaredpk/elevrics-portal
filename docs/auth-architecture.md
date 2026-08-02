# Portal Authentication — Architecture and Rollout

**Date:** August 2026
**Question:** Replace Cloudflare Access one-time email codes with real accounts
for `portal.elevrics.ai`, without painting us into a corner for MFA, passkeys,
SSO or organizations — and retire `finance.elevrics.ai` as a separate front door
while we are in here.

---

## 1. Current state

### Where auth lives today

Nowhere in this repo. That is the finding that shapes everything else.

One Cloudflare Access application covers `portal.elevrics.ai`. Access
authenticates at the edge — a one-time PIN emailed to an address on an allow
policy — and every request that reaches the Worker is already authenticated. The
Worker reads `Cf-Access-Authenticated-User-Email` and renders it at the foot of
the rail, and `src/nav.js` is emphatic that this is **display only**.

The `Cf-Access-Jwt-Assertion` header is forwarded to each Fly origin unchanged,
and **each origin verifies it itself** (`solayard-intel/app.py` verifies against
`elevrics.cloudflareaccess.com`). That is not redundancy — the Fly hostnames stay
publicly reachable, so a direct hit on `*.fly.dev` has to be rejected at the
origin. It is why `src/router.js` can say it is a convenience layer and not a
security boundary.

| Fact | Consequence |
|---|---|
| No users table, no `user_id`, no `tenant_id` anywhere (`docs/portal-feasibility.md`) | There are no existing users to migrate. There is no schema to change. |
| No database in this repo. Worker + static assets, zero npm dependencies, no build step | An auth stack that needs a Node server, a bundler or a Postgres is a much bigger change than it looks. |
| Access has no user store, no roles, no self-service, no invites | Everything past "is this email allowed" has to come from somewhere else. |
| Every origin verifies the Access JWT independently | Removing Access without replacing that token turns four defended services into four open ones behind a proxy. **This is the sequencing constraint.** |
| finapp's Plaid webhooks, MCP endpoint and OAuth server use `finapp-v3.fly.dev`, and `APP_URL` is pinned there | Machine callers do not depend on `finance.elevrics.ai`. It is safe to retire — and machine traffic arriving there is already a misconfiguration. |

### How portal and finance relate

They share no code, no database and no auth state. `finapp-v3` is a separate repo
on Fly with its own Postgres; its Supabase login was already removed in favour of
Access. The portal proxies it at `/finance`, prefix passed through whole (Vite
`base` is `/finance/`, and the app strips the prefix server-side so its routes
stay registered at root).

**That last detail is what makes the retirement a redirect rather than a route
table:** every URL that worked at the root of `finance.elevrics.ai` exists
unchanged one level down at `portal.elevrics.ai/finance`.

---

## 2. Recommended architecture

### Provider: WorkOS AuthKit

**Recommended, not one of three options.**

- Email + password, email verification, password reset, brute-force defence,
  TOTP MFA and passkeys are all built in and enabled from the dashboard against
  the same code path. None of them is a future project.
- Enterprise SSO is the **same product**: a SAML/OIDC connection on an
  organization, not a second login surface, not a migration. This is the
  requirement that eliminates most alternatives.
- Organizations, memberships and roles ship with it, so `admin` vs `member`
  today and a real org model later are the same mechanism.
- It is drivable with three `fetch` calls. This repo has no build step and no
  dependencies; every self-hosted or SDK-first option (Better Auth, Supabase
  Auth, Clerk's Node SDK) would add a bundler, a lockfile and a
  dependency-update surface to a Worker that has none. This is not the main
  reason to pick WorkOS, but it is why picking it costs nothing structurally.
- `docs/portal-feasibility.md` already named WorkOS as the right call for the
  ICP — mid-market law firms will ask for SAML.

Rejected: **Clerk** (excellent DX, but cross-subdomain sessions mean satellite
domains, which are fiddly and priced, and the `{client}.elevrics.ai` tier in the
feasibility doc walks straight into that). **Auth0** (priced for a different
company). **Self-hosted Better Auth on D1** (we would own password hashing,
email delivery and reset-token handling — the exact list the brief says to
prefer not to hand-roll). **Staying on Access** (no user model, no self-service,
no roles; it is an IdP gate, not an account system).

### Identifier: email only

No usernames in v1.

A username is a second unique namespace to reserve, validate, case-fold, police
for impersonation and support in recovery ("I forgot my username" is a real
ticket). It buys nothing for a B2B portal where every account already has a
verified email and every invite arrives at one. It also makes account enumeration
easier and makes future SSO awkward, because an IdP asserts an email, not a
handle.

The path stays open: a `display_name` is profile metadata, and a handle can be
added later as a *profile* field without ever becoming a login identifier. Adding
one later is easy; removing one later is a migration.

### Session: sealed cookie, portal-owned

`__Host-elv_session` — AES-256-GCM sealed, HttpOnly, Secure, SameSite=Lax,
Path=/. It carries the WorkOS access token, the refresh token, and the identity
summary the rail and the guard need.

- **Encrypted, not merely signed**, because it contains a refresh token. A
  signed-but-readable cookie puts a long-lived credential in every devtools pane
  and every proxy log that captures a Cookie header.
- **`__Host-` prefix** is browser-enforced: no `Domain`, so the cookie can never
  be sent to a sibling subdomain — not the retired finance host, not a future
  `{client}.elevrics.ai`.
- **Sliding, with an absolute ceiling.** The access token is minutes long and is
  refreshed on demand; `iat` is carried across refreshes, so 30 days is a hard
  cap that refreshing cannot extend.
- **No session table.** The cookie is the record. Revocation is bounded rather
  than instant — see below — and that is a deliberate trade for a Worker with no
  database.

**Sign-out** clears the cookie *and* ends the AuthKit session (clearing only ours
means the next `/auth/login` sails through with no prompt, which looks like
sign-out silently failing). **Sign out everywhere** writes a floor timestamp to
KV; sessions older than it die at their next refresh, i.e. within the
access-token lifetime. That is the right tool for a compromised credential; it is
not an instant kill switch, and the code says so.

### The piece that makes Access removable: a portal-issued assertion

The origins verify a token today. They must keep verifying a token, because
`*.fly.dev` stays reachable. So the portal issues its own:

```
X-Elevrics-Assertion:  ES256 JWT, 120s, aud = the module's routing prefix
Public keys:           https://portal.elevrics.ai/.well-known/portal-jwks.json
```

An origin swaps its Access verifier for this one — fetch a JWKS, check the
signature, check `iss`/`aud`/`exp` — which is a substitution inside an existing
code path, roughly 30 lines per origin, in three languages.

Two properties are load-bearing:

- **Every inbound `X-Elevrics-*` header is deleted before ours is added.**
  Without that the scheme is decorative: a caller could present a captured token
  to the portal and have the router forward it to a module taught to trust
  exactly that header.
- **`aud` is the routing prefix**, so a token minted for `/finance` cannot be
  replayed against `/solayard`.

ES256 rather than a shared HMAC secret so the verifying key can be *published* —
onboarding an origin is a URL, not a secret to distribute and rotate.
`ASSERTION_SIGNING_KEY_NEXT` publishes a second key during rotation, so rotating
is a sequence rather than an outage.

### Roles

From the WorkOS organization-membership role slug, normalised into a `roles`
array. `requiresRole` in `src/modules.js` is the gate; its **absence** means "any
signed-in account", which is correct for an internal portal where signing in is
the boundary. `/admin` declares `admin` now, while the console is still inert, so
the gate is in place on the day it first reads real data rather than being
remembered on that day.

The admin-safe direction is explicit: **a required role plus a session carrying
no roles is a DENY.** The tempting alternative — "roles aren't rolled out yet, so
allow" — makes the gate silently absent during exactly the window nobody is
watching it.

### Rate limiting

Layered, and mostly not ours:

1. **WorkOS** owns credential brute force, because WorkOS owns the password form.
   We never see a password attempt and could not count one.
2. **A Cloudflare rate-limiting rule on `/auth/*`** is the real limit — it runs
   before the Worker is invoked, so it cannot be exhausted by the traffic it
   limits. *This must be configured in the dashboard; it is not in this repo.*
3. **A KV fixed-window backstop** in `src/auth/ratelimit.js` for when (2) is
   missing. Generous enough that no real person meets it, and **fails open** — a
   limiter whose own storage outage takes sign-in down has inverted its job.

### What happens to existing users

Nothing to migrate. Access has no user store, and no application table has a
`user_id`. The cutover is: create accounts in WorkOS for the emails currently on
the Access policy, send invitations, verify sign-in works in `shadow` mode, then
enforce. The Access allow-list stays in place as the safety net until the last
step.

### Future paths this preserves

| Later | What it costs from here |
|---|---|
| MFA (TOTP) | A dashboard toggle. No code. |
| Passkeys | A dashboard toggle. No code. |
| Enterprise SSO / SAML | A connection on a WorkOS organization. The session, guard and assertion layers do not change. |
| Organizations / workspaces | `org` is already carried in the session and in the assertion, unused. Roles are already a list. |
| An admin split to `admin.elevrics.ai` | `requiresRole: 'admin'` already gates it; `__Host-` cookies are already same-host-only. |
| Instant global revocation | Add a D1 sessions table read behind `readSession`. The call site already exists. |

---

## 3. Retiring `finance.elevrics.ai`

Treated as a consolidation, not a redirect, because three different kinds of
traffic arrive at that hostname and one blanket rule breaks one of them.

| Request | Answer | Why |
|---|---|---|
| Deep link (a bookmark) | **301** to the same path under `/finance`, `Cache-Control: public, max-age=86400`, `Link: rel=canonical`, `Deprecation: true` | Permanent for bookmarks and crawlers; bounded in the browser, because a 301 with no cache header is cached effectively forever and that is a bad property to hand a redirect on day one. |
| Bare hostname | **Retirement notice** during the announced window, then 301 | The move gets announced rather than merely happening to someone. Only the front page — interrupting a bookmark to a specific page with an announcement is an irritation, and the portal chrome around the page tells them where they are. |
| `/api/*`, `/webhook*`, `/mcp*`, `/oauth*`, `/.well-known/*`, `/health*` | **410 Gone**, naming `finapp-v3.fly.dev` in the body | **The one that would have hurt.** A webhook POST redirected into the portal meets an authentication wall and gets HTML back — a shape Plaid records as something other than an error while the transaction never lands. A 410 fails loudly at the caller instead. These callers were never meant to be on this hostname: `APP_URL` is the Fly hostname precisely so the OAuth issuer is stable. |

Answered **before** any session check: being made to sign in to be told where
something moved is hostile, and a redirect discloses nothing the hostname didn't.
Answered **before** any path routing, so the retired host can never proxy to an
internal module — the same guard the parked hosts carry.

`RETIREMENT_MODE=notice` ships as the default; flip to `redirect` when the window
closes and delete `public/finance-retired/` a release later.

### Out-of-repo steps

These cannot be done from this repository and are the actual cutover:

1. **Route `finance.elevrics.ai` at this Worker** (Cloudflare → Workers Routes /
   Custom Domains). Until this is done, none of the above executes.
2. **Remove the custom domain and certificate from `finapp-v3` on Fly**, after
   (1), so the name resolves in one place only.
3. **Delete the Cloudflare Access application** covering `finance.elevrics.ai`.
   A retired host must not sit behind a login.
4. **Audit for the old hostname** in: the Plaid dashboard (redirect URI, webhook
   URL), finapp's `APP_URL` / `CORS_ORIGINS` / cookie-domain settings, any OAuth
   client registrations or MCP client configs, and DNS. Each should already point
   at `finapp-v3.fly.dev`; confirm rather than assume.
5. **Keep the DNS record** pointing at the Worker indefinitely. Deleting it turns
   every old bookmark into a DNS error instead of a redirect.

No CORS, callback URL, cookie domain or auth redirect in the portal depends on
the finance subdomain — the portal's cookies are `__Host-` prefixed, which
cannot carry a `Domain` at all.

---

## 4. Risks

| Risk | Mitigation |
|---|---|
| **Locking ourselves out.** `enforce` before WorkOS is configured, or with a broken `SESSION_SECRET`. | `AUTH_MODE` ships as `shadow`; Access stays in front until the last step; a missing secret produces a 503 at `/auth/login` naming which one. Keep an Access policy until `enforce` has been exercised. |
| **Origins reject everything** when Access comes off, because they still expect `Cf-Access-Jwt-Assertion`. | The whole point of the mode ladder. Do not remove Access until all four origins accept the portal assertion. The assertion is minted in `shadow` mode too, so origins can be migrated one at a time while Access is still enforcing. |
| **The router becomes the only boundary** and someone stops verifying at the origin. | Called out in `src/router.js`. `*.fly.dev` stays reachable; per-origin verification is not optional. |
| **Header spoofing** of `X-Elevrics-Assertion`. | Blanket prefix strip before minting, tested. |
| **Open redirect** via `?next=`. | Same-origin paths only; `//`, `\` and absolute URLs rejected, tested. |
| **Session fixation** at the callback. | State validated before the code is spent, tested — the code is never sent to WorkOS on a bad state. |
| **Webhook breakage** during the finance retirement. | 410 rather than redirect for machine paths, matched wide on purpose. |
| **A 301 cached forever** if the mapping turns out wrong. | `max-age=86400` bounds the browser cache to a day. |
| **KV absent** (it is optional). | Global revocation and the rate-limit backstop degrade explicitly; `/auth/revoke` reports which happened rather than pretending. |
| **WorkOS outage.** | A refresh that fails at the network level keeps the existing session rather than signing everyone out over a provider blip. A total outage does block new sign-ins — accepted, and the reason the Access policy is not deleted on day one. |

---

## 5. Testing checklist

Automated (`npm test`, 106 tests):

- [x] Seal round-trip; tamper, truncation, wrong key and cross-purpose all → null
- [x] Cookie flags: `__Host-`, HttpOnly, Secure, SameSite, no `Domain`
- [x] Open-redirect refusal on `?next=`
- [x] Public allowlist covers the sign-in surface and *not* `/` or `/admin/`
- [x] Role denial when a role is required and none is held
- [x] `/admin` gated despite not being a proxied module
- [x] Navigation → 302; fetch → 401
- [x] `/auth/*` absent in `access` mode; 503 when half-configured
- [x] Callback refuses mismatched / missing / expired state before spending the code
- [x] Sign-out is POST-only and ends the WorkOS session
- [x] `/auth/session` leaks neither token
- [x] Assertion verifies against the published JWKS; `aud` is the prefix; ≤120s
- [x] JWKS never publishes `d`; publishes both keys mid-rotation
- [x] Inbound `X-Elevrics-*` stripped
- [x] Retired host: deep-link 301, root notice, machine-path 410, never a module
- [x] Three-argument `handleRequest` callers still route unchanged

Manual, needs a deploy (`wrangler dev` has no Access and no WorkOS in front):

- [ ] Sign up → verification email → verify → land in the portal
- [ ] Sign in → land on the page you originally asked for, not `/`
- [ ] Password reset end to end
- [ ] Sign out → `/signed-out/` → sign in again prompts for credentials
- [ ] Session survives an access-token expiry (wait past it, reload)
- [ ] `/admin/` as a non-admin → 403, not a sign-in loop
- [ ] A module XHR after expiry gets 401 JSON, not an HTML login page
- [ ] Rail and quick-switcher still render inside the proxied modules
- [ ] `finance.elevrics.ai/accounts` → the same page in the portal
- [ ] `finance.elevrics.ai/api/plaid/webhook` → 410, and Plaid still delivers to Fly
- [ ] One origin migrated to the assertion still works with Access in front
