/**
 * Hostnames that used to be their own front door and are now part of the portal.
 *
 * A PARKED host (see `PARKED_HOSTS` in router.js) is a name we hold and have not
 * used. A RETIRED host is a name that WAS used, that people have bookmarked, and
 * whose URLs must keep resolving to the content that moved. The two need
 * opposite treatment — a parked host serves a placeholder for every path, a
 * retired host has to preserve the path — which is why this is a separate table
 * rather than another flag on that one.
 *
 * finance.elevrics.ai is the first, and the shape below is the general answer.
 *
 * TWO KINDS OF REQUEST arrive at a retired host, and collapsing them into one
 * blanket redirect is the mistake this file exists to avoid:
 *
 *   1. A browser         → 301 to the same path in the portal.
 *   2. A machine endpoint → 410 Gone. NOT a redirect.
 *
 * (2) is the one that would have hurt. finapp receives Plaid webhooks, serves an
 * MCP endpoint and runs its own OAuth server; those callers cannot present a
 * session. Redirecting them into the portal sends a webhook POST at an
 * authentication wall, which answers 302-then-HTML — a shape Plaid will record
 * as a delivered-ish non-error while the transaction never lands. A 410 with the
 * canonical hostname in the body fails loudly at the caller instead, which is
 * the only way a misconfiguration gets noticed rather than absorbed.
 *
 * Machine traffic was never supposed to be on this hostname — `APP_URL` is the
 * Fly hostname precisely so the OAuth issuer is stable, and the Plaid and MCP
 * configuration has been confirmed to point there — so in practice this branch
 * should never fire. It stays because the asymmetry is stark: ten lines against
 * a financial integration failing silently if something ever regresses.
 *
 * WHAT IS DELIBERATELY NOT HERE: a retirement-notice interstitial. An earlier
 * pass had one, behind a mode flag, so the consolidation could be announced
 * before it took effect. There is nobody to announce it to — this portal has one
 * user, who made the decision. A notice page for an audience of zero is a page
 * to maintain, and the flag guarding it was a second thing to remember to flip.
 * If a future retirement ever does have users to warn, add it back then.
 */

export const RETIRED_HOSTS = {
  'finance.elevrics.ai': {
    /** Where the functionality now lives, as a path on the portal. */
    prefix: '/finance',
    /** Shown on the notice page and named in the 410 body. */
    label: 'Finance',
    /**
     * Where machine callers were always meant to go, and still should. Named in
     * the 410 body so a broken integration reports its own fix.
     */
    machineOrigin: 'https://finapp-v3.fly.dev',
    /**
     * Paths that must 410 rather than redirect. Matched as prefixes.
     *
     * Erring wide is correct here: a human path wrongly listed costs one extra
     * click through the portal, while a machine path wrongly omitted is a silent
     * data-integration failure.
     */
    machinePaths: [
      '/api/',
      '/webhook',
      '/webhooks',
      '/mcp',
      '/oauth',
      '/.well-known/',
      '/health',
      '/healthz',
    ],
  },
};

export function matchRetiredHost(hostname) {
  return RETIRED_HOSTS[hostname] ?? null;
}

export function isMachinePath(entry, pathname) {
  const path = pathname.toLowerCase();
  return entry.machinePaths.some((prefix) => path === prefix || path.startsWith(prefix));
}

/**
 * The portal URL a retired URL maps to.
 *
 * Path and query are carried across verbatim. finapp is served prefix-passed-
 * through at `/finance` (Vite `base`, and the app strips the prefix itself), so
 * every route it had at the root of the old hostname exists unchanged one level
 * down — `/accounts` becomes `/finance/accounts`. That one-to-one mapping is why
 * this retirement can be a redirect at all rather than a route table.
 *
 * The fragment is absent from a server-side URL by construction and needs no
 * handling: browsers reattach it to the redirect target themselves, so
 * `#/budgets` survives without us seeing it.
 */
export function retiredTarget(entry, url, portalOrigin) {
  const target = new URL(portalOrigin);
  const rest = url.pathname === '/' ? '' : url.pathname;
  target.pathname = `${entry.prefix}${rest}`;
  target.search = url.search;
  return target.toString();
}

/** Answer a request on a retired hostname. */
export function handleRetiredHost(entry, url, { portalOrigin }) {
  if (isMachinePath(entry, url.pathname)) {
    return new Response(
      JSON.stringify({
        error: 'gone',
        detail:
          `${url.hostname} has been retired. Machine endpoints were never served ` +
          `from this hostname in production configuration — point this integration at ` +
          `${entry.machineOrigin}.`,
        canonical: `${entry.machineOrigin}${url.pathname}${url.search}`,
      }),
      {
        status: 410,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Robots-Tag': 'noindex, nofollow',
        },
      },
    );
  }

  const target = retiredTarget(entry, url, portalOrigin);

  return new Response(null, {
    status: 301,
    headers: {
      Location: target,
      // Permanent for crawlers and bookmarks; bounded in the browser. A 301
      // with no Cache-Control is cached by some browsers effectively forever,
      // and "forever" is a bad property to hand a redirect on the same day you
      // deploy it. A day is long enough to be free and short enough to unwind.
      'Cache-Control': 'public, max-age=86400',
      Link: `<${target}>; rel="canonical"`,
      // Advertises the retirement to anything that reads it (crawlers, some
      // API clients) without depending on anything reading it.
      Deprecation: 'true',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}
