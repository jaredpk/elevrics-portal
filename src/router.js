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
 * Transport-agnostic on purpose: handleRequest() takes the asset fallback as a
 * parameter, so the Worker passes env.ASSETS.fetch and the local integration
 * harness passes a stub. The routing logic under test is the deployed logic.
 */

export const MODULES = {
  '/solayard': {
    origin: 'https://solayard-intel.fly.dev',
    // Flask registers its 9 routes at root. Strip the prefix inbound; the app
    // emits portal-space URLs itself via its URL_PREFIX env var.
    stripPrefix: true,
  },
  '/opportunities': {
    origin: 'https://elevrics-opportunities.fly.dev',
    // Express router + static assets, same arrangement as above.
    stripPrefix: true,
  },
  '/pathfinder': {
    origin: 'https://elevrics-relocation.fly.dev',
    // Next.js basePath means the app expects to see /pathfinder in the path
    // and generates its own prefixed asset URLs. Pass the path through whole.
    stripPrefix: false,
  },
};

export function matchModule(pathname) {
  for (const [prefix, config] of Object.entries(MODULES)) {
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
 */
export async function handleRequest(request, serveAssets) {
  const url = new URL(request.url);

  const match = matchModule(url.pathname);
  if (!match) return serveAssets(request);

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
