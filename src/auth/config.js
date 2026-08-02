/**
 * Auth configuration, read from the Worker `env` on every request.
 *
 * Nothing here is a module-level constant, because a Worker's `env` is per
 * request and the unit tests need to hand in a fake one. `authConfig(env)` is
 * cheap enough to call per request and returns a frozen snapshot.
 *
 * THE MODE FLAG IS THE ROLLOUT.
 *
 * Replacing Cloudflare Access is not a single deploy: the four Fly origins each
 * verify the Access JWT themselves (see the README — the router is explicitly
 * NOT the security boundary), so the moment Access comes off the portal
 * hostname they stop receiving `Cf-Access-Jwt-Assertion` and reject everything.
 * The order has to be: portal auth ships alongside Access → origins learn to
 * accept the portal's own assertion → Access comes off. `AUTH_MODE` is what
 * makes those three states expressible without three branches of the router.
 *
 *   'access'  — today. Access gates at the edge, the rail shows its header,
 *               /auth/* is not mounted. The escape hatch if something is wrong.
 *   'shadow'  — /auth/* is live and a portal session is honoured and displayed,
 *               but Access is still in front and still authoritative. Nothing
 *               is blocked by the portal. This is where you verify the flow
 *               against real WorkOS without being able to lock yourself out.
 *   'enforce' — the portal session is required. Access can now be removed.
 *
 * Committed default is 'shadow' deliberately: a fresh deploy of this repo must
 * never be the thing that starts refusing requests.
 */

export const AUTH_MODES = ['access', 'shadow', 'enforce'];

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
  const mode = AUTH_MODES.includes(env.AUTH_MODE) ? env.AUTH_MODE : 'shadow';
  return Object.freeze({
    mode,
    /** /auth/* only exists once we are past the pure-Access state. */
    enabled: mode !== 'access',
    /** Does a missing session actually stop a request? */
    enforcing: mode === 'enforce',

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
 * Checked before mounting /auth/*, so a half-configured deploy fails with a
 * legible 503 at the login route rather than a stack trace at the callback —
 * and, in 'enforce' mode, so it can refuse to lock everyone out over a missing
 * secret. See `guard.js`.
 */
export function configErrors(config) {
  const missing = [];
  if (!config.clientId) missing.push('WORKOS_CLIENT_ID');
  if (!config.apiKey) missing.push('WORKOS_API_KEY');
  if (!config.sessionSecret) missing.push('SESSION_SECRET');
  return missing;
}
