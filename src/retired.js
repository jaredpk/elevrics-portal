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
 * THREE KINDS OF REQUEST arrive at a retired host, and collapsing them into one
 * blanket redirect is the mistake this file exists to avoid:
 *
 *   1. A deep link a human bookmarked  → 301 to the same path in the portal.
 *   2. The bare hostname               → a retirement notice, for a window, so
 *                                        the consolidation is announced rather
 *                                        than merely happening to someone.
 *   3. A machine endpoint              → 410 Gone. NOT a redirect.
 *
 * (3) is the one that would have hurt. finapp receives Plaid webhooks, serves an
 * MCP endpoint and runs its own OAuth server; those callers cannot present a
 * session. Redirecting them into the portal sends a webhook POST at an
 * authentication wall, which answers 302-then-HTML — a shape Plaid will record
 * as a delivered-ish non-error while the transaction never lands. A 410 with the
 * canonical hostname in the body fails loudly at the caller instead, which is
 * the only way a misconfiguration gets noticed rather than absorbed. Machine
 * traffic was never supposed to be on this hostname anyway: `APP_URL` is the Fly
 * hostname precisely so the OAuth issuer is stable, so a hit here is already a
 * config error somewhere.
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
    /** The asset served in `notice` mode. */
    notice: '/finance-retired/',
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

/**
 * Answer a request on a retired hostname.
 *
 * @param mode 'notice' during the announced window, 'redirect' afterwards.
 *   The notice only ever applies to the BARE HOSTNAME — a deep link goes
 *   straight to its content in both modes. Interrupting someone who followed a
 *   bookmark to a specific page with an announcement about the move is how you
 *   turn a clean consolidation into an irritation, and they will find out where
 *   they are from the portal chrome around the page they wanted.
 */
export async function handleRetiredHost(entry, url, serveAssets, { mode, portalOrigin }) {
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
  const isRoot = url.pathname === '/' || url.pathname === '';

  if (mode === 'notice' && isRoot) {
    const assetUrl = new URL(url);
    assetUrl.pathname = entry.notice;
    assetUrl.search = '';
    const response = await serveAssets(new Request(assetUrl, { method: 'GET' }));
    const headers = new Headers(response.headers);
    headers.set('X-Robots-Tag', 'noindex, nofollow');
    headers.set('Cache-Control', 'no-store');
    headers.set('Link', `<${target}>; rel="canonical"`);
    return new Response(response.body, { status: response.status, headers });
  }

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

/** `notice` for the announced window, `redirect` after. See README. */
export function retirementMode(env = {}) {
  return env.RETIREMENT_MODE === 'redirect' ? 'redirect' : 'notice';
}
