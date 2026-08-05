/**
 * Portal router.
 *
 * WHO DECIDES WHETHER A REQUEST IS ALLOWED is this file, now. There used to be
 * a Cloudflare Access application in front of portal.elevrics.ai as well, so
 * every request arriving here was already authenticated at the edge and
 * Cf-Access-Jwt-Assertion rode along to each origin. That second login is gone:
 * the portal runs its own accounts (WorkOS AuthKit, see src/auth/) and mints its
 * own short-lived assertion for the origins.
 *
 * So this router IS a security boundary for the portal hostname. It is still
 * not the ONLY one, and must not become the only one: the Fly hostnames stay
 * publicly reachable, so every origin keeps verifying the assertion for itself
 * — a direct hit on *.fly.dev has to be rejected there, not here.
 *
 * Anything that doesn't match a module prefix falls through to the static
 * shell (launcher at /, admin console at /admin).
 *
 * Transport-agnostic on purpose: handleRequest() takes the asset fallback, the
 * chrome injector and the env as parameters, so the Worker passes
 * env.ASSETS.fetch and an HTMLRewriter-backed injector while the local
 * integration harness passes a stub and nothing. The routing logic under test is
 * the deployed logic.
 *
 * What the portal CONTAINS lives in modules.js — one registry behind the
 * proxying here, the nav, and the launcher grid.
 */

import { MODULES, matchComingSoon, requiredRoleFor } from './modules.js';
import { isDocumentRequest } from './chrome.js';
import { renderComingSoon } from './nav.js';
import { matchRetiredHost, handleRetiredHost } from './retired.js';
import { authConfig } from './auth/config.js';
import { handleAuthRoute } from './auth/routes.js';
import { readSession, withCookies } from './auth/session.js';
import { gate, isPublicPath } from './auth/guard.js';
import {
  mintAssertion,
  stripInboundAssertions,
  jwksResponse,
  JWKS_PATH,
  ASSERTION_HEADER,
} from './auth/assertion.js';

export { MODULES };

/**
 * Hostnames parked on this Worker that are NOT the portal.
 *
 * These are public — the sign-in gate is per path, and these paths serve a
 * placeholder — so module proxying must never apply here. Without this guard,
 * pathfinder.elevrics.ai/solayard would proxy to the internal dashboard. The
 * origins would still reject it for carrying no valid assertion, but it would
 * confirm to an anonymous visitor that the module exists, and it relies on the
 * origin to catch something this router should never have forwarded.
 *
 * Every path on a parked host serves its placeholder, which is self-contained
 * (inline CSS) so there are no sub-resources to route.
 */
export const PARKED_HOSTS = {
  'pathfinder.elevrics.ai': '/pathfinder-coming-soon/',
};

export function matchParkedHost(hostname) {
  return PARKED_HOSTS[hostname] ?? null;
}

/**
 * Find the module that should serve this path, if any.
 *
 * Two things are skipped, and both matter:
 *
 * Entries without an `origin` are portal-owned pages (the launcher, the admin
 * shell) — they belong in the nav but there is nowhere to forward them, so they
 * fall through to the assets binding. That check has to come first: "/" is a
 * registry entry, and every path starts with it.
 *
 * Entries keyed by a URL rather than a path are external destinations (Finance),
 * which must be LINKED and never proxied — finapp's Plaid webhooks and OAuth
 * callers can't present an Access token, and those failures are silent. Keying
 * them by URL means no `pathname` can ever match, so this holds even if someone
 * later adds an `origin` to one.
 */
export function matchModule(pathname) {
  for (const [prefix, config] of Object.entries(MODULES)) {
    if (!config.origin) continue;
    if (!prefix.startsWith('/')) continue;
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return { prefix, config };
    }
  }
  return null;
}

/** Pull a root-absolute redirect from a stripped origin back into portal space. */
export function reprefixLocation(location, origin, prefix) {
  if (location.startsWith('/')) return prefix + location;
  try {
    const absolute = new URL(location);
    if (absolute.origin === new URL(origin).origin) {
      return prefix + absolute.pathname + absolute.search + absolute.hash;
    }
  } catch {
    // Relative redirect ("../foo") — already resolves correctly against the
    // prefixed request URL, so leave it alone.
  }
  return location;
}

/**
 * Scope a cookie to the module that set it. Without this, a stripped origin's
 * `Path=/` cookie is sent to every other module on the portal origin.
 */
export function reprefixCookiePath(cookie, prefix) {
  if (/;\s*path=/i.test(cookie)) {
    return cookie.replace(
      /;\s*path=([^;]*)/i,
      (_match, path) => `; Path=${prefix}${path === '/' ? '' : path}`,
    );
  }
  return `${cookie}; Path=${prefix}`;
}

/**
 * @param request  the incoming Request
 * @param serveAssets  fallback for anything that isn't a module route
 * @param injectChrome  optional (response, {pathname, mode, viewer}) => Response
 *   that renders the rail into the page. Omitted outside the Workers runtime,
 *   where HTMLRewriter doesn't exist; the router routes identically either way.
 * @param env  the Worker environment — auth secrets, bindings, mode flags.
 *   Defaulted so the existing unit tests and the local harness, which care about
 *   routing and not about auth, keep calling this with three arguments.
 */
export async function handleRequest(request, serveAssets, injectChrome, env = {}) {
  const url = new URL(request.url);
  const config = authConfig(env);

  // ---- Host-level routing, before anything path-based ----
  //
  // Both checks below are host checks for the same reason: a request on a
  // hostname that is not the portal must never be able to reach a module,
  // whatever path it asks for.

  // A parked host is a name we hold and have not used.
  // Deliberately never injected with portal chrome: a parked host is public,
  // and its placeholder must not advertise the internal module list.
  const parked = matchParkedHost(url.hostname);
  if (parked) {
    const assetUrl = new URL(url);
    assetUrl.pathname = parked;
    assetUrl.search = '';
    const response = await serveAssets(new Request(assetUrl, { method: 'GET' }));
    const headers = new Headers(response.headers);
    headers.set('X-Robots-Tag', 'noindex, nofollow');
    return new Response(response.body, { ...response, headers });
  }

  // A retired host is a name that WAS used and whose URLs must keep resolving.
  // Answered without any session check: being made to sign in before being told
  // where something moved is hostile, and a redirect discloses nothing that the
  // hostname itself didn't already.
  const retired = matchRetiredHost(url.hostname);
  if (retired) {
    return handleRetiredHost(retired, url, { portalOrigin: config.portalOrigin });
  }

  // ---- Auth ----

  // Public key material, fetched by module origins as machines. Ahead of the
  // session read because it has nothing to do with sessions.
  if (url.pathname === JWKS_PATH) return jwksResponse(config, env);

  const authResponse = await handleAuthRoute(request, url, config);
  if (authResponse) return authResponse;

  // May mint cookies (a refreshed session) or clear them (a dead one), and
  // those have to reach whatever response we end up returning — hence
  // `withCookies` on every exit below rather than a mutation here.
  const { session, cookies } = await readSession(request, config);

  // The one identity there is. Null renders no footer at all rather than an
  // empty "Signed in as" — which is what `wrangler dev` shows, since a local
  // run has no session and nothing in front of it to invent one.
  const viewer = session
    ? { email: session.email, name: session.name, impersonator: session.impersonator }
    : null;

  const match = matchModule(url.pathname);

  const denied = gate(request, url, session, {
    config,
    requiredRole: requiredRoleFor(url.pathname),
  });
  if (denied) return withCookies(denied, cookies);

  if (!match) {
    // A module that is listed but not built yet gets a branded page rather
    // than a 404, so the "Soon" chip in the rail leads somewhere deliberate.
    const soon = matchComingSoon(url.pathname);
    const response = soon
      ? new Response(renderComingSoon(soon.prefix, soon.entry), {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        })
      : await serveAssets(request);

    // Either way it is one of the portal's own pages: fill the placeholders.
    //
    // Except the public ones. The rail enumerates every internal module by
    // name, and /signed-out/ is the one portal page an unauthenticated visitor
    // is meant to reach — decorating it would hand the module list to exactly
    // the person the sign-in exists to stop. (It also spares those pages the
    // body inset that clears a fixed rail they don't have.)
    return withCookies(
      injectChrome && !isPublicPath(url.pathname)
        ? injectChrome(response, { pathname: url.pathname, mode: 'placeholder', viewer })
        : response,
      cookies,
    );
  }

  // `mod`, not `config` — `config` is the auth configuration in this scope now.
  const { prefix, config: mod } = match;

  const upstream = new URL(mod.origin);
  if (mod.stripPrefix) {
    const rest = url.pathname.slice(prefix.length);
    upstream.pathname = rest === '' ? '/' : rest;
  } else {
    upstream.pathname = url.pathname;
  }
  upstream.search = url.search;

  const proxied = new Request(upstream, request);

  // BEFORE anything is added: delete every X-Elevrics-* header the CLIENT sent.
  // Without this the assertion below is decorative — a caller could present its
  // own (or a captured) token to portal.elevrics.ai and have the router forward
  // it verbatim to a module that has been taught to trust exactly that header.
  stripInboundAssertions(proxied.headers);

  proxied.headers.set('X-Forwarded-Host', url.host);
  proxied.headers.set('X-Forwarded-Proto', 'https');
  if (mod.stripPrefix) proxied.headers.set('X-Forwarded-Prefix', prefix);

  // The portal's own identity assertion: signed, 2 minutes, audience-bound to
  // this module. This is what each origin verifies, in place of the Cloudflare
  // Access token it used to — see src/auth/assertion.js. Absent until a signing
  // key is configured, and an origin that verifies properly rejects a request
  // without one, so `ASSERTION_SIGNING_KEY` is not optional in practice.
  const assertion = await mintAssertion(config, session, prefix);
  if (assertion) proxied.headers.set(ASSERTION_HEADER, assertion);

  // Manual redirect handling so we can rewrite Location into portal space
  // rather than bouncing the browser to the bare fly.dev origin.
  const response = await fetch(proxied, { redirect: 'manual' });

  // Chrome on a proxied module is opt-in PER MODULE, so it can be switched on
  // one origin at a time and switched off by deleting a word. Only ever on a
  // top-level page load — see isDocumentRequest for why a fragment must not
  // receive a navigation rail.
  const decorate = (res) =>
    withCookies(
      injectChrome && mod.injectChrome && isDocumentRequest(request)
        ? injectChrome(res, { pathname: url.pathname, mode: 'standalone', viewer })
        : res,
      cookies,
    );

  if (!mod.stripPrefix) return decorate(response);

  const rewritten = new Response(response.body, response);

  const location = rewritten.headers.get('Location');
  if (location) {
    rewritten.headers.set('Location', reprefixLocation(location, mod.origin, prefix));
  }

  const moduleCookies = rewritten.headers.getSetCookie?.() ?? [];
  if (moduleCookies.length) {
    rewritten.headers.delete('Set-Cookie');
    for (const value of moduleCookies) {
      rewritten.headers.append('Set-Cookie', reprefixCookiePath(value, prefix));
    }
  }

  return decorate(rewritten);
}
