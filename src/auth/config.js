/**
 * Auth configuration, read from the Worker `env` on every request.
 *
 * Nothing here is a module-level constant, because a Worker's `env` is per
 * request and the unit tests need to hand in a fake one. `authConfig(env)` is
 * cheap enough to call per request and returns a frozen snapshot.
 *
 * ONE LOGIN. The portal used to sit behind a Cloudflare Access application as
 * well as its own accounts, and an `AUTH_MODE` flag ('access' → 'shadow' →
 * 'enforce') sequenced the move between them. That rollout is over: the WorkOS
 * session is the only way in, and there is no mode in which it is optional.
 *
 * Removing the flag is deliberate rather than tidying. A three-state gate whose
 * two permissive states are no longer reachable in production is a foot-gun
 * with an environment variable attached — the one thing you never want to be
 * able to set by accident is "authentication off". `enforcing` is now a
 * property of the code, not of the deploy.
 *
 * What replaces it as the safety net is `configErrors()` below: a deploy that
 * is missing a WorkOS secret fails CLOSED and says which one, rather than
 * falling back to an edge login that no longer exists. See `guard.js`.
 */

/** Where the portal lives. Used to build absolute redirect and issuer URLs. */
const DEFAULT_ORIGIN = 'https://portal.elevrics.ai';

/**
 * Session lifetimes.
 *
 * The sealed cookie holds a WorkOS access token that is short-lived by design;
 * we refresh it from the refresh token rather than extending it. `ABSOLUTE_TTL`
 * is the ceiling that refreshing cannot push past, so a stolen cookie has a
 * bounded life even if it is refreshed continuously.
 */
export const SESSION_ABSOLUTE_TTL = 30 * 24 * 60 * 60; // 30 days
/** Refresh this many seconds BEFORE the access token actually expires. */
export const REFRESH_SKEW = 60;

/** Name is `__Host-` prefixed: browser-enforced Secure + Path=/ + no Domain. */
export const SESSION_COOKIE = '__Host-elv_session';
/** Short-lived, carries the OAuth state + the post-login destination. */
export const LOGIN_COOKIE = '__Host-elv_login';

export function authConfig(env = {}) {
  return Object.freeze({
    clientId: env.WORKOS_CLIENT_ID ?? '',
    apiKey: env.WORKOS_API_KEY ?? '',
    apiBase: env.WORKOS_API_BASE ?? 'https://api.workos.com',

    portalOrigin: env.PORTAL_ORIGIN ?? DEFAULT_ORIGIN,
    /** HKDF input for the session-cookie key. A secret, never a var. */
    sessionSecret: env.SESSION_SECRET ?? '',
    /** ES256 private key (JWK, JSON string) for module assertions. */
    assertionKey: env.ASSERTION_SIGNING_KEY ?? '',

    /** KV binding for login state, revocation and rate limits. Optional. */
    kv: env.AUTH_KV ?? null,
  });
}

/**
 * Is auth configured well enough to actually run?
 *
 * Checked at the login route, so a half-configured deploy fails with a legible
 * 503 naming the missing secret rather than a stack trace at the callback — and
 * checked again in the guard, because with nothing else in front of the portal
 * a missing secret is now the difference between "nobody can sign in" and
 * "everybody is redirected to a sign-in that cannot work". Both answer 503; the
 * guard's version says so without a redirect first. See `guard.js`.
 */
export function configErrors(config) {
  const missing = [];
  if (!config.clientId) missing.push('WORKOS_CLIENT_ID');
  if (!config.apiKey) missing.push('WORKOS_API_KEY');
  if (!config.sessionSecret) missing.push('SESSION_SECRET');
  return missing;
}
