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

import { MODULES } from './modules.js';

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
 * Registry entries without an `origin` are portal-owned pages (the launcher,
 * the admin shell) — they belong in the nav but there is nowhere to forward
 * them, so they are skipped here and fall through to the assets binding. That
 * check has to come first: "/" is a registry entry, and every path starts
 * with it.
 */
export function matchModule(pathname) {
  for (const [prefix, config] of Object.entries(MODULES)) {
    if (!config.origin) continue;
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
 * @param injectChrome  optional (response, pathname) => Response that fills the
 *   nav placeholders. Omitted outside the Workers runtime, where HTMLRewriter
 *   doesn't exist; the router routes identically either way.
 */
export async function handleRequest(request, serveAssets, injectChrome) {
  const url = new URL(request.url);

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
    // The portal's own pages (and its 404s) — chrome goes on here. Proxied
    // module responses below still pass through bare; giving them the nav too
    // is the next phase, and wants its own testing.
    const response = await serveAssets(request);
    return injectChrome ? injectChrome(response, url.pathname) : response;
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

  if (!config.stripPrefix) return response;

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

  return rewritten;
}
