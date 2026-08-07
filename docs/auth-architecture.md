# Portal Authentication — Architecture and Rollout

**Date:** August 2026
**Question:** Replace Cloudflare Access one-time email codes with real accounts
for `portal.elevrics.ai`, without painting us into a corner for MFA, passkeys,
SSO or organizations — and retire `finance.elevrics.ai` as a separate front door
while we are in here.

> **Status: done.** The rollout below has been carried out. WorkOS AuthKit is the
> only login; the Cloudflare Access application is gone, and with it the
> `AUTH_MODE` ladder that sequenced the move — see §6. Sections 1–4 are kept as
> the record of *why* it is shaped this way, and section 1 describes the state
> this started from, not the state now.

---

## 1. Starting state (historical)

### Where auth lived before this work

Nowhere in this repo. That is the finding that shaped everything else.

One Cloudflare Access application covered `portal.elevrics.ai`. Access
authenticated at the edge — a one-time PIN emailed to an address on an allow
policy — and every request that reached the Worker was already authenticated. The
Worker read `Cf-Access-Authenticated-User-Email` and rendered it at the foot of
the rail, and `src/nav.js` was emphatic that this was **display only**.

The `Cf-Access-Jwt-Assertion` header was forwarded to each Fly origin unchanged,
and **each origin verified it itself** (`solayard-intel/app.py` verified against
`elevrics.cloudflareaccess.com`). That was not redundancy — the Fly hostnames stay
publicly reachable, so a direct hit on `*.fly.dev` has to be rejected at the
origin. It is why `src/router.js` could say it was a convenience layer and not a
security boundary.

| Fact | Consequence |
|---|---|
| No users table, no `user_id`, no `tenant_id` anywhere (`docs/portal-feasibility.md`) | There are no existing users to migrate. There is no schema to change. |
| No database in this repo. Worker + static assets, zero npm dependencies, no build step | An auth stack that needs a Node server, a bundler or a Postgres is a much bigger change than it looks. |
| Access has no user store, no roles, no self-service, no invites | Everything past "is this email allowed" has to come from somewhere else. |
| Every origin verified the Access JWT independently | Removing Access without replacing that token would turn four defended services into four open ones behind a proxy. **This was the sequencing constraint.** |
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

### The piece that made Access removable: a portal-issued assertion

The origins verified a token before, and they must keep verifying a token,
because `*.fly.dev` stays reachable. So the portal issues its own:

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

### What happened to existing users

Nothing to migrate. Access had no user store, and no application table has a
`user_id`. The cutover was: create accounts in WorkOS for the emails on the
Access policy, send invitations, verify sign-in in `shadow` mode, then enforce.
The Access allow-list stayed in place as the safety net until the last step.

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

Finance is a module at `/finance`. The old hostname stops being a front door.

| Request | Answer | Why |
|---|---|---|
| Anything a browser asks for | **301** to the same path under `/finance`, `Cache-Control: public, max-age=86400`, `Link: rel=canonical`, `Deprecation: true` | The mapping is one-to-one: finapp is prefix-passed-through and strips the prefix itself, so every route at the old root exists unchanged one level down. Permanent for bookmarks; bounded in the browser, because a 301 with no cache header is cached effectively forever. |
| `/api/*`, `/webhook*`, `/mcp*`, `/oauth*`, `/.well-known/*`, `/health*` | **410 Gone**, naming `finapp-v3.fly.dev` in the body | A webhook POST redirected into the portal meets an authentication wall and gets HTML back — a shape Plaid records as something other than an error while the transaction never lands. A 410 fails loudly at the caller instead. Plaid and MCP are confirmed pointed at the Fly hostname, so this should never fire; it stays because ten lines against a silent financial-integration failure is a trade worth making. |

Answered **before** any session check (being made to sign in to be told where
something moved is hostile, and a redirect discloses nothing the hostname
didn't) and **before** any path routing, so the retired host can never proxy to
an internal module — the same guard the parked hosts carry.

**No retirement-notice interstitial.** An earlier pass had one behind a
`RETIREMENT_MODE` flag. This portal has one user, who made the decision: a notice
page for an audience of zero is a page to maintain and a flag to remember to
flip. If a future retirement has users to warn, add it back then.

### Out-of-repo steps

None of this runs until `finance.elevrics.ai` resolves to this Worker, and
routing it there is **optional**. What it buys is narrow but real: the browser
autocompletes the old hostname from history for months, and routed, that muscle
memory lands in `/finance` instead of on a DNS error. One record.

**If you route it** (recommended, ~5 minutes):

1. **Cloudflare → Zero Trust → Access → Applications** — delete the application
   covering `finance.elevrics.ai`. A retired host must stay public: the redirect
   has to answer without a session, and a login in front of it defeats the point.
2. **Fly** — `fly certs remove finance.elevrics.ai -a finapp-v3`, and remove the
   corresponding IP/CNAME allocation. Do this first so the name resolves in one
   place only and Fly stops trying to renew a cert for a name it no longer serves.
3. **Cloudflare → DNS** — delete the existing `finance` record (the CNAME/A
   pointing at Fly). Step 4 will not attach to a hostname that already has one.
4. **Cloudflare → Workers & Pages → `elevrics-portal` → Settings → Domains &
   Routes → Add → Custom Domain** — enter `finance.elevrics.ai`. Cloudflare
   creates the proxied DNS record and issues the certificate itself.
   *Custom Domain, not Route:* a Route needs a DNS record to already exist and
   attaches to a pattern; a Custom Domain manages both the record and the cert,
   which is what the other portal hostnames use.
5. **Verify:**
   ```bash
   curl -sI https://finance.elevrics.ai/accounts | head -3          # 301 → /finance/accounts
   curl -s  https://finance.elevrics.ai/api/plaid/webhook           # 410, names fly.dev
   ```

**If you don't route it:** do steps 1–3 and stop. `finance.elevrics.ai` stops
resolving, `src/retired.js` never executes (it is host-matched), and the only
cost is that autocompleting the old name gives a DNS error instead of a redirect.

Either way, nothing else depends on the subdomain. Plaid, MCP and the OAuth
issuer are confirmed on `finapp-v3.fly.dev`, and no CORS rule, callback URL,
cookie domain or auth redirect in the portal references it — the portal's cookies
are `__Host-` prefixed, which cannot carry a `Domain` at all.

---

## 4. Risks

| Risk | Mitigation |
|---|---|
| **Locking ourselves out.** A deploy with WorkOS unconfigured or a broken `SESSION_SECRET`, now that nothing sits in front. | Fails **closed and named**: every non-public path answers `503 auth_not_configured` listing the missing secret, rather than redirecting into a sign-in that cannot complete. Recovery is `wrangler tail` (every callback refusal logs a short `reason`) plus `wrangler rollback`. There is deliberately no bypass flag — one would be an "authentication off" switch living in the deployed Worker. |
| **Origins reject everything** once Access came off, because they still expected `Cf-Access-Jwt-Assertion`. | This was the whole point of the mode ladder, and it is why the ladder was not removed until after the origins were migrated. The assertion was minted in `shadow` mode too, so origins moved one at a time while Access was still enforcing. |
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

Automated (`npm test`, 107 tests):

- [x] Seal round-trip; tamper, truncation, wrong key and cross-purpose all → null
- [x] Cookie flags: `__Host-`, HttpOnly, Secure, SameSite, no `Domain`
- [x] Open-redirect refusal on `?next=`
- [x] Public allowlist covers the sign-in surface and *not* `/` or `/admin/`
- [x] Role denial when a role is required and none is held
- [x] `/admin` gated despite not being a proxied module
- [x] Navigation → 302; fetch → 401
- [x] 503 naming the missing secret when half-configured — at `/auth/login` and
      at the guard, so an unconfigured deploy serves nothing rather than everything
- [x] No `AUTH_MODE` value, known or invented, stands the gate down
- [x] An `X-Elevrics-*` or `Cf-Access-*` identity header on the request is not a viewer
- [x] Callback refuses mismatched / missing / expired state before spending the code
- [x] Sign-out is POST-only and ends the WorkOS session
- [x] `/auth/session` leaks neither token
- [x] Assertion verifies against the published JWKS; `aud` is the prefix; ≤120s
- [x] JWKS never publishes `d`; publishes both keys mid-rotation
- [x] Inbound `X-Elevrics-*` stripped
- [x] Retired host: 301 with the path preserved, machine-path 410, never a module
- [x] A three-argument `handleRequest` call (no env) serves 503, not everything

Manual, needs a deploy (`wrangler dev` cannot complete a WorkOS round trip — the
redirect URI has to be a real hostname). Checked during the August 2026 cutover:

- [x] Sign in → the portal, with no Cloudflare Access in front of it
- [x] Sign out → `/signed-out/` → signing in again prompts for credentials
- [x] All four origins accept the portal assertion with no Access application

Still unverified. Left unticked deliberately — an unchecked box is worth more
than a ticked one nobody exercised:

- [ ] Password reset end to end
- [ ] Session survives an access-token expiry (wait past it, reload)
- [ ] `/admin/` as a non-admin → 403, not a sign-in loop
- [ ] A module XHR after expiry gets 401 JSON, not an HTML login page
- [ ] Rail and quick-switcher still render inside the proxied modules
- [ ] `finance.elevrics.ai/accounts` → the same page in the portal (only if routed)
- [ ] `finance.elevrics.ai/api/plaid/webhook` → 410, and Plaid still delivers to Fly

No longer applicable: sign-up is disabled in WorkOS — the portal is invite-only,
so there is no self-service registration round trip to test. Invited people
arrive on an invitation link. Re-enabling it is a dashboard toggle, and the
`/auth/signup` route is still mounted for that day.

---

## 6. Removing the second login

The rollout above left the portal with **two** logins for its duration: Cloudflare
Access at the edge and WorkOS behind it. That was correct while the origins were
being migrated and wrong the moment they were done. Both are no longer needed, so:

### Out of repo

1. **Cloudflare → Zero Trust → Access → Applications** — delete the application
   covering `portal.elevrics.ai`. Nothing else in Zero Trust references it.
2. **Each origin** — drop the `Cf-Access-Jwt-Assertion` branch, keeping only the
   `X-Elevrics-Assertion` verifier it has been running alongside it. Do this
   *after* step 1, not before: an origin that accepts both is the state that
   makes step 1 safe, and an origin that accepts neither is an outage.
3. **Keep the emails.** Accounts live in WorkOS now; the Access allow-policy was
   the last thing referencing them at Cloudflare and it goes with the application.

### In repo

| Removed | Why it could not just be left in place |
|---|---|
| `AUTH_MODE` and the three-state ladder | Two of its three states mean "the portal does not enforce". With nothing in front of the portal, a var that can be set to `shadow` is a var that can turn authentication off — and its default *was* `shadow`. |
| `viewerFor()` reading `Cf-Access-Authenticated-User-Email` | Access set that header and stripped any inbound copy. With Access gone it is a header any client can type, so reading it would be trusting attacker-controlled input for the identity shown in the rail. |
| The bare-string viewer shape in `nav.js` | It existed only to carry that header. One identity source, one shape — and a footer now always implies a session that can be signed out of. |
| The unenforced path for a three-argument `handleRequest` | It was safe only because Access was in front. `npm run harness` now mints a real sealed session with a per-process secret instead, which exercises the same code path a real user does rather than a path that only exists with auth off. |

**What did not change:** the assertion, the per-origin verification, and the rule
that `*.fly.dev` stays reachable so the router must never be the only boundary.
Removing a login must not quietly remove a defence.

---

## 7. Operating constraints found during the cutover

Three things that are not visible in the code and each cost real time to
discover. They belong here because each one is a decision or a deploy step, not
a bug to fix.

### The JWKS path must be exempt from bot protection

`/.well-known/portal-jwks.json` is served without a session on purpose. That is
necessary but not sufficient: it must also be reachable by something that does
not look like a browser.

Cloudflare's Browser Integrity Check is on by default, runs at the edge *ahead
of the Worker*, and refuses non-standard user agents with a 403 the Worker never
sees and cannot log. `PyJWKClient` fetches through urllib, so `solayard-intel`
could not load the key and refused every request — a total auth outage on that
module, presenting as "invalid token". `curl` from a laptop returned the key
throughout, and the three JavaScript origins were unaffected because `jose`
fetches via undici. One origin failing while three worked is what located it.

Add a WAF custom rule: **Skip → Browser Integrity Check** for that path. Origins
should also send an identifying `User-Agent`, but that is a courtesy on their
side; the endpoint is published for machines, so the edge is where this belongs.

### Passkeys bind to the AuthKit domain, and that sets an ordering

A passkey is bound to the origin that ran the WebAuthn ceremony. Enrol one on
`<generated>.authkit.app` and it stops working the day a custom AuthKit domain
is configured — every user re-enrols, with no migration path. That binding is
the phishing resistance, so it is not something to design around.

The rule this produces: **custom domain before clients, clients before clients'
passkeys.** For a single operator it does not matter — re-enrolling one account
takes seconds. For the `{client}.elevrics.ai` tier it is a forced re-enrolment
across every client's staff, which is a bad first impression from a vendor.

This also means the custom domain stops being cosmetic at that point. It becomes
the permanent anchor client credentials are bound to, which is an argument for
picking a name that will never change.

### Costs, and the two that scale

AuthKit is free to 1M monthly active users. Passkeys, MFA, magic auth,
organizations and roles are included. At 100 clients none of that costs
anything.

Two things do:

- **AuthKit custom domain — $99/month.** Deferred. Cosmetic today; buy it before
  clients enrol passkeys (above).
- **Enterprise SSO — priced per connection**, roughly $125 each falling to ~$65
  at volume. One connection is one client organization using SAML or Directory
  Sync. 100 SSO clients is on the order of $6,500/month — about 65× the domain
  fee, and the reason SSO belongs in a paid tier of your own pricing rather than
  the base plan. Verify current rates before building a model on them.

Neither changes the architecture. `src/auth/workos.js` is the whole provider
surface — six functions, three `fetch` calls — so if the SSO economics ever
justify self-hosting the SAML side (BoxyHQ Jackson is the usual answer), it
slots in behind that seam without touching the session, the guard, the assertion
or any origin.
