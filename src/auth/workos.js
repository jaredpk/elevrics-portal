/**
 * WorkOS AuthKit client — three HTTP calls, no SDK.
 *
 * WHY NO SDK: this repo has no build step and no dependencies (`package.json`
 * lists none; `npm install` exists only to get wrangler). AuthKit is drivable
 * with `fetch` alone, which is the difference between adding an auth provider
 * and adding a bundler, a lockfile and a dependency-update surface to a Worker
 * that currently has none. It is not the main reason to pick WorkOS — the
 * enterprise path is — but it is why picking it costs nothing structurally.
 *
 * WHAT WORKOS OWNS, and therefore what is not in this repo: the password form,
 * password hashing and strength rules, the email-verification round trip, the
 * password-reset round trip, credential-stuffing and brute-force defence, TOTP
 * enrolment, passkeys, and — later — SAML/OIDC connections and directory sync.
 * Turning MFA or passkeys on is a dashboard setting against this same code
 * path; adding enterprise SSO is a connection on an organization, not a second
 * login screen. That is the whole architectural bet.
 *
 * WHAT THE PORTAL OWNS: the session cookie, route protection, roles as they
 * apply to modules, and the assertion the modules verify. Those are ours
 * because they are about *this* product's topology, and no provider can hold
 * them for us.
 */

/**
 * The hosted AuthKit URL to send a browser to.
 *
 * `screen_hint` is the only difference between "sign in" and "create account":
 * one hosted surface, two entry points. Building our own second page for
 * registration is exactly the duplicate auth surface we are trying not to have.
 */
export function authorizationUrl(config, { state, screenHint, loginHint } = {}) {
  const url = new URL('/user_management/authorize', config.apiBase);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', `${config.portalOrigin}/auth/callback`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('provider', 'authkit');
  if (state) url.searchParams.set('state', state);
  if (screenHint) url.searchParams.set('screen_hint', screenHint);
  if (loginHint) url.searchParams.set('login_hint', loginHint);
  return url.toString();
}

/**
 * Exchange an authorization code, or refresh an expiring session.
 *
 * One function for both because the endpoint and the response shape are the
 * same and only `grant_type` differs; two near-identical fetch wrappers would
 * drift the moment one of them grew error handling.
 *
 * Returns `{ ok: true, data }` or `{ ok: false, status, error }` rather than
 * throwing: a failed refresh is an ordinary "sign in again", not an exception,
 * and it happens on ordinary page loads.
 */
async function authenticate(config, body) {
  let response;
  try {
    response = await fetch(new URL('/user_management/authenticate', config.apiBase), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.apiKey,
        ...body,
      }),
    });
  } catch (cause) {
    // Network-level failure. Distinguished from a 4xx because it must NOT be
    // read as "these credentials are bad" — see session.js, which keeps the
    // existing session on a transport error rather than signing the user out
    // because WorkOS had a bad thirty seconds.
    return { ok: false, status: 0, error: String(cause) };
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { ok: false, status: response.status, error: data.error ?? `HTTP ${response.status}` };
  }
  return { ok: true, data };
}

export function exchangeCode(config, code) {
  return authenticate(config, { grant_type: 'authorization_code', code });
}

export function refreshSession(config, refreshToken, organizationId) {
  return authenticate(config, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    ...(organizationId ? { organization_id: organizationId } : {}),
  });
}

/**
 * Where to send the browser to end the session AT WORKOS, not just here.
 *
 * Clearing our cookie signs the user out of the portal. It does not end the
 * AuthKit session, so the next visit to /auth/login would sail straight back
 * through with no prompt and look like the sign-out silently failed. This is
 * also the hook that makes "sign out everywhere" real rather than cosmetic.
 */
export function logoutUrl(config, sessionId) {
  const url = new URL('/user_management/sessions/logout', config.apiBase);
  if (sessionId) url.searchParams.set('session_id', sessionId);
  url.searchParams.set('return_to', `${config.portalOrigin}/signed-out/`);
  return url.toString();
}

/**
 * Read the claims out of a JWT without verifying it.
 *
 * Legitimate here and nowhere else: the only access tokens this code ever sees
 * arrive over TLS directly from the token endpoint and are then held inside our
 * own AEAD-sealed cookie, so their integrity is already established by two
 * mechanisms before this is called. It exists to read `exp` (when to refresh),
 * `sid` (which session to log out) and the role claim.
 *
 * Never call this on a token that arrived from a client. The modules verifying
 * the portal's assertion must check the signature — that is what the JWKS
 * endpoint in `assertion.js` is for.
 */
export function decodeClaims(jwt) {
  try {
    const payload = String(jwt).split('.')[1];
    if (!payload) return {};
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)));
  } catch {
    return {};
  }
}

/**
 * Flatten a WorkOS authenticate response into what the portal stores.
 *
 * Only what the rail renders and the guard decides on — deliberately not the
 * whole user object. Everything in here ends up in a cookie on every request
 * and in the assertion sent to every module, so each field has to earn its
 * place; profile detail can be fetched from WorkOS when something actually
 * needs it.
 */
export function sessionFrom(data) {
  const claims = decodeClaims(data.access_token);
  const user = data.user ?? {};
  return {
    sub: user.id ?? claims.sub ?? null,
    email: user.email ?? null,
    emailVerified: user.email_verified ?? false,
    name: [user.first_name, user.last_name].filter(Boolean).join(' ') || null,
    org: data.organization_id ?? claims.org_id ?? null,
    // AuthKit sends the org-membership role slug as `role`; normalised to a
    // list here so the guard has one shape to check and multi-role later is not
    // a data-model change. No role at all is NOT 'admin' — see roles.js.
    roles: claims.roles ?? (claims.role ? [claims.role] : []),
    sid: claims.sid ?? null,
    accessToken: data.access_token ?? null,
    refreshToken: data.refresh_token ?? null,
    accessExp: claims.exp ?? 0,
    // Impersonation is a WorkOS support feature. Carried through so it can be
    // shown in the rail: an admin browsing as someone else must never look
    // identical to that person being signed in.
    impersonator: data.impersonator?.email ?? null,
  };
}
