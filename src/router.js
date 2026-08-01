/**
 * Portal router.
 *
 * portal.elevrics.ai sits behind ONE Cloudflare Access application, so every
 * request that reaches this router is already authenticated. The
 * Cf-Access-Jwt-Assertion header rides along to each origin unchanged, because
 * the origins must verify it themselves: the Fly hostnames stay publicly
 * reachable, and a direct hit on *.fly.dev has to be rejected there, not here.
 * This router is a convenience layer, not a security boundary.
 *
 * Anything that doesn't match a module prefix falls through to the static
 * shell (launcher at /, admin console at /admin).
 *
 * Transport-agnostic on purpose: handleRequest() takes the asset fallback and
 * the chrome injector as parameters, so the Worker passes env.ASSETS.fetch and
 * an HTMLRewriter-backed injector while the local integration harness passes a
 * stub and nothing. The routing logic under test is the deployed logic.
 *
 * What the portal CONTAINS lives in modules.js — one registry behind the
 * proxying here, the nav, and the launcher grid.
 */

import { MODULES, matchComingSoon } from './modules.js';
import { isDocumentRequest, viewerFor } from './chrome.js';
import { renderComingSoon } from './nav.js';

export { MODULES };

/**
 * Hostnames parked on this Worker that are NOT the portal.
 *
 * These are public — no Access application covers them — so module proxying
 * must never apply here. Without this guard, pathfinder.elevrics.ai/solayard
 * would proxy to the internal dashboard. The origins would still reject it for
 * carrying no Access token, but it would confirm to an anonymous visitor that
 * the module exists, and it relies on the origin to catch something this
 * router should never have forwarded.
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
 */
export async function handleRequest(request, serveAssets, injectChrome) {
  const url = new URL(request.url);
  // Set by Cloudflare Access on everything it lets through. Display only — it
  // names the signed-in viewer in the rail and gates nothing.
  const viewer = viewerFor(request);

  // Parked hosts are checked before anything path-based, so no request on a
  // public hostname can reach a module.
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

  const match = matchModule(url.pathname);
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
    return injectChrome
      ? injectChrome(response, { pathname: url.pathname, mode: 'placeholder', viewer })
      : response;
  }

  const { prefix, config } = match;

  const upstream = new URL(config.origin);
  if (config.stripPrefix) {
    const rest = url.pathname.slice(prefix.length);
    upstream.pathname = rest === '' ? '/' : rest;
  } else {
    upstream.pathname = url.pathname;
  }
  upstream.search = url.search;

  const proxied = new Request(upstream, request);
  proxied.headers.set('X-Forwarded-Host', url.host);
  proxied.headers.set('X-Forwarded-Proto', 'https');
  if (config.stripPrefix) proxied.headers.set('X-Forwarded-Prefix', prefix);

  // Manual redirect handling so we can rewrite Location into portal space
  // rather than bouncing the browser to the bare fly.dev origin.
  const response = await fetch(proxied, { redirect: 'manual' });

  // Chrome on a proxied module is opt-in PER MODULE, so it can be switched on
  // one origin at a time and switched off by deleting a word. Only ever on a
  // top-level page load — see isDocumentRequest for why a fragment must not
  // receive a navigation rail.
  const decorate = (res) =>
    injectChrome && config.injectChrome && isDocumentRequest(request)
      ? injectChrome(res, { pathname: url.pathname, mode: 'standalone', viewer })
      : res;

  if (!config.stripPrefix) return decorate(response);

  const rewritten = new Response(response.body, response);

  const location = rewritten.headers.get('Location');
  if (location) {
    rewritten.headers.set('Location', reprefixLocation(location, config.origin, prefix));
  }

  const cookies = rewritten.headers.getSetCookie?.() ?? [];
  if (cookies.length) {
    rewritten.headers.delete('Set-Cookie');
    for (const cookie of cookies) {
      rewritten.headers.append('Set-Cookie', reprefixCookiePath(cookie, prefix));
    }
  }

  return decorate(rewritten);
}
