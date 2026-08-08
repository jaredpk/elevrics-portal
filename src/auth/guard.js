/**
 * What is reachable signed out, and what happens when you are not.
 *
 * The allowlist is the security-relevant half of this file. Everything not on it
 * requires a session in 'enforce' mode — including the launcher itself, which
 * matters more than it looks: the launcher and the rail enumerate every internal
 * module the company has, and that list is not something to hand to an
 * unauthenticated visitor even if each destination behind it would reject them.
 */

import { JWKS_PATH } from './assertion.js';
import { isAuthRoute } from './routes.js';
import { configErrors } from './config.js';

/**
 * Reachable without a session.
 *
 * Each entry has a reason, and an entry without one does not belong here:
 *
 *   /auth/*        the sign-in flow itself, obviously.
 *   JWKS_PATH      fetched by module origins as machines. See assertion.js.
 *   /signed-out/   where sign-out lands. Requiring auth to see it would loop.
 *   /css/, /js/    styling for the pages above. chrome.css is already served to
 *                  third-party origins by design, so none of it is secret — and
 *                  a login page that renders unstyled reads as broken.
 *   /favicon.ico   requested by the browser before any redirect resolves.
 *   /favicon.svg   the same request in the format modern browsers prefer, and
 *   /apple-touch-  the one iOS asks for. Gated, both 302 to sign-in and the tab
 *   icon.png       falls back to a blank page icon on /signed-out/ — the one
 *                  page a signed-out visitor is meant to see. Icons are public
 *                  by nature: the site serves the same mark unauthenticated.
 *   /robots.txt    read by crawlers, which by definition have no session.
 *   /healthz       uptime checks, which by definition have no session either.
 *
 * Note what is NOT here: '/' and '/admin/'.
 *
 * The icons are exact paths rather than an '/icons/' prefix: a prefix is a
 * standing grant to whatever gets filed under it later, and three files do not
 * need one.
 */
const PUBLIC_PREFIXES = ['/css/', '/js/'];
const PUBLIC_PATHS = new Set([
  JWKS_PATH,
  '/signed-out',
  '/signed-out/',
  '/favicon.ico',
  '/favicon.svg',
  '/apple-touch-icon.png',
  '/robots.txt',
  '/healthz',
]);

export function isPublicPath(pathname) {
  if (isAuthRoute(pathname)) return true;
  if (PUBLIC_PATHS.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Does this session satisfy a module's `requiresRole`?
 *
 * ADMIN-SAFE DEFAULT: a module that names a required role and a session that
 * carries no roles at all is a DENY. The tempting alternative — "no roles
 * configured yet, so let everyone through" — makes the gate silently absent
 * during exactly the window where roles are being rolled out, which is when it
 * is least likely to be noticed.
 *
 * A module with no `requiresRole` is open to any authenticated user, which is
 * the correct default for an internal portal where the sign-in is the boundary.
 */
export function hasRole(session, required) {
  if (!required) return true;
  const held = session?.roles ?? [];
  const needed = Array.isArray(required) ? required : [required];
  return needed.some((role) => held.includes(role));
}

/**
 * Is this a top-level navigation, or something a page fetched?
 *
 * Decides the SHAPE of the refusal. Redirecting a background `fetch()` to a
 * sign-in page hands JavaScript an HTML document where it expected JSON, and the
 * module then reports whatever confusing thing it makes of that. A 401 is
 * legible to code; a redirect is legible to a person. Neither is legible to both.
 */
function isNavigation(request) {
  const dest = request.headers.get('Sec-Fetch-Dest');
  if (dest) return dest === 'document';
  return (request.headers.get('Accept') ?? '').includes('text/html');
}

/**
 * The response for a request that has no session, or the wrong role.
 *
 * There is no mode in which this does nothing. The portal session is the only
 * login, so "enforcing" is not a deploy-time choice — see config.js.
 *
 * @returns a Response, or null when the request may proceed.
 */
export function gate(request, url, session, { config, requiredRole } = {}) {
  if (isPublicPath(url.pathname)) return null;

  // A deploy missing a WorkOS secret cannot mint a session and cannot complete
  // a sign-in. Say that, rather than bouncing every request to a login route
  // that will only answer 503 one redirect later — and note the ORDER: this is
  // checked before the session, so it fails closed. There is no longer an edge
  // login behind us to fall back to.
  const missing = configErrors(config);
  if (missing.length) {
    return new Response(JSON.stringify({ error: 'auth_not_configured', missing }, null, 2), {
      status: 503,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  if (!session) {
    if (!isNavigation(request)) {
      return new Response(JSON.stringify({ error: 'not_authenticated' }), {
        status: 401,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          // Tells a fetch-based caller where a human would have been sent,
          // without redirecting it there.
          'X-Elevrics-Login': '/auth/login',
        },
      });
    }
    const next = `${url.pathname}${url.search}`;
    return new Response(null, {
      status: 302,
      headers: {
        Location: `/auth/login?next=${encodeURIComponent(next)}`,
        'Cache-Control': 'no-store',
      },
    });
  }

  if (!hasRole(session, requiredRole)) {
    // 403 and a dead end, NOT a redirect to sign in again. Being bounced to a
    // login you are already past is the most confusing failure mode in this
    // whole flow, and it reads as broken auth rather than as "not for you".
    return new Response(forbiddenPage(url.pathname), {
      status: 403,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  return null;
}

function forbiddenPage(pathname) {
  const path = String(pathname).replace(/[&<>"]/g, '');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>No access · Elevrics Portal</title>
<link rel="stylesheet" href="/css/chrome.css"><link rel="stylesheet" href="/css/portal.css">
</head><body class="elv-plain"><main class="elv-gate">
<h1>No access</h1>
<p>Your account is signed in, but it isn't cleared for <code>${path}</code>.</p>
<p><a class="elv-gate-action" href="/">Back to the portal</a></p>
</main></body></html>`;
}
