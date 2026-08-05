/**
 * The portal session: one sealed cookie, refreshed against WorkOS on demand.
 *
 * There is no session table. The cookie IS the session record, AEAD-sealed with
 * a key only the Worker can derive, and it is short-lived by construction: the
 * WorkOS access token inside it expires in minutes, so the cookie is only as
 * good as the refresh token beside it, and that is revocable at WorkOS.
 *
 * That choice is what keeps this deployable on a Worker with no database. The
 * alternative — a D1 sessions table read on every request — buys instant global
 * revocation at the cost of a stateful read in front of every page load and a
 * migration story for a portal that currently has neither. The bounded version
 * we get instead is written down under `revokeAll` below, and it is a genuine
 * trade, not an oversight.
 *
 * WHAT IS DELIBERATELY NOT IN THE COOKIE: anything a module is allowed to trust.
 * Modules get a separately signed, 2-minute assertion (`assertion.js`). The
 * cookie is between the browser and this Worker and nothing else reads it.
 */

import {
  SESSION_COOKIE,
  SESSION_ABSOLUTE_TTL,
  REFRESH_SKEW,
} from './config.js';
import { seal, unseal, readCookie, cookie, clearCookie } from './crypto.js';
import { refreshSession, sessionFrom } from './workos.js';

const now = () => Math.floor(Date.now() / 1000);

/** Serialise a session into its Set-Cookie value. */
export async function sessionCookie(session, config) {
  const sealed = await seal(session, config.sessionSecret, 'session');
  return cookie(SESSION_COOKIE, sealed, { maxAge: SESSION_ABSOLUTE_TTL });
}

export function signOutCookie() {
  return clearCookie(SESSION_COOKIE);
}

/**
 * Establish the session for a request.
 *
 * Returns `{ session, cookies }` where `session` is null for a signed-out
 * request and `cookies` is any Set-Cookie the caller must attach — a refresh
 * mints a new cookie, and a dead session clears the old one. The caller has to
 * carry those onto whatever response it ends up producing, which is why this
 * returns them rather than mutating anything: the same session read has to work
 * ahead of an asset response, a proxied response and a redirect.
 */
export async function readSession(request, config) {
  // No key, nothing to unseal with. Returning "signed out" here is NOT a
  // fallback to unauthenticated access: the guard, which runs after this,
  // refuses the request outright when a secret is missing rather than treating a
  // null session as an anonymous visitor. See `configErrors` in guard.js.
  if (!config.sessionSecret) return { session: null, cookies: [] };

  const raw = readCookie(request, SESSION_COOKIE);
  if (!raw) return { session: null, cookies: [] };

  const session = await unseal(raw, config.sessionSecret, 'session');
  // Unsealable: tampered, truncated, or sealed under a rotated key. Clear it —
  // leaving it in place means the browser re-sends a cookie that can never
  // work again on every subsequent request.
  if (!session?.sub) return { session: null, cookies: [signOutCookie()] };

  // The ceiling refreshing cannot push past. Without it, a session that is used
  // daily never ends, and "signed in since March" is not a security posture.
  if (!session.iat || now() - session.iat > SESSION_ABSOLUTE_TTL) {
    return { session: null, cookies: [signOutCookie()] };
  }

  if (session.accessExp - REFRESH_SKEW > now()) return { session, cookies: [] };

  return refresh(session, config);
}

/**
 * Trade the refresh token for a new access token.
 *
 * Three outcomes, and the difference between the second and third is the point:
 *
 *   ok            → new session, new cookie, refresh token rotated.
 *   4xx from      → the refresh token is revoked, expired or already used.
 *   WorkOS          Sign out. This is where a `revokeAll` or a WorkOS-side
 *                   logout actually takes effect.
 *   network       → WorkOS is unreachable. KEEP the session. Signing everyone
 *   failure         out because a dependency had a bad thirty seconds turns a
 *                   provider blip into a portal outage, and the access token we
 *                   are holding is still within its own validity window here.
 */
async function refresh(session, config) {
  if (!session.refreshToken) return { session: null, cookies: [signOutCookie()] };

  if (await isRevoked(session, config)) {
    return { session: null, cookies: [signOutCookie()] };
  }

  const result = await refreshSession(config, session.refreshToken, session.org);

  if (!result.ok) {
    if (result.status === 0) return { session, cookies: [], degraded: true };
    return { session: null, cookies: [signOutCookie()] };
  }

  const next = {
    ...sessionFrom(result.data),
    // Carried forward, NOT reset: the absolute cap is measured from the
    // original sign-in, so refreshing cannot extend a session indefinitely.
    iat: session.iat,
  };
  return { session: next, cookies: [await sessionCookie(next, config)] };
}

/**
 * Establish a brand new session after a successful code exchange.
 */
export async function startSession(data, config) {
  const session = { ...sessionFrom(data), iat: now() };
  return { session, cookie: await sessionCookie(session, config) };
}

/**
 * "Sign out of every device" — the one thing the cookie alone cannot express.
 *
 * Records a floor timestamp per user in KV. Any session whose `iat` predates it
 * dies at its NEXT REFRESH, which is within the access-token lifetime (minutes),
 * not immediately. That bound is the honest description of this design: it is
 * the right answer for compromised-credential response and password change; it
 * is not a kill switch that takes effect inside the current page load.
 *
 * No KV binding means no global revocation — the call is a no-op and reports it,
 * rather than silently pretending to have revoked something.
 */
export async function revokeAll(config, userId) {
  if (!config.kv) return false;
  await config.kv.put(`revoked:${userId}`, String(now()), {
    // Nothing to enforce once every session that could predate it has aged out.
    expirationTtl: SESSION_ABSOLUTE_TTL,
  });
  return true;
}

async function isRevoked(session, config) {
  if (!config.kv) return false;
  const floor = await config.kv.get(`revoked:${session.sub}`);
  return Boolean(floor) && session.iat < Number(floor);
}

/** Attach Set-Cookie headers to a response without discarding its own. */
export function withCookies(response, cookies) {
  if (!cookies?.length) return response;
  const headers = new Headers(response.headers);
  for (const value of cookies) headers.append('Set-Cookie', value);
  return new Response(response.body, { status: response.status, headers });
}
