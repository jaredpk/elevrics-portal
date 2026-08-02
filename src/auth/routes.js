/**
 * The portal's auth surface. Five routes, none of which is a form.
 *
 * There is no /auth/register, no /auth/forgot-password, no /auth/verify. Those
 * screens exist — they are hosted by AuthKit, themed to match, and reached from
 * the same authorize call with a different `screen_hint`. Building our own would
 * mean a second place that collects a password, a second place that has to get
 * the reset round trip right, and a second thing to re-audit every time the
 * threat model moves. "Avoid duplicate auth surfaces" is a security requirement
 * here, not only a UX one.
 *
 *   GET  /auth/login    → AuthKit, sign-in screen
 *   GET  /auth/signup   → AuthKit, create-account screen
 *   GET  /auth/callback → code exchange, session cookie, back to where you were
 *   POST /auth/logout   → clear cookie, end the AuthKit session too
 *   GET  /auth/session  → who am I, as JSON
 *   POST /auth/revoke   → sign out everywhere
 */

import { LOGIN_COOKIE, configErrors } from './config.js';
import {
  seal,
  unseal,
  randomToken,
  timingSafeEqual,
  readCookie,
  cookie,
  clearCookie,
} from './crypto.js';
import { authorizationUrl, exchangeCode, logoutUrl } from './workos.js';
import { readSession, startSession, signOutCookie, revokeAll } from './session.js';
import { clientIp, overLimit, tooManyRequests } from './ratelimit.js';

export const AUTH_PREFIX = '/auth/';

/** How long a login attempt may sit unfinished before its state expires. */
const LOGIN_STATE_TTL = 10 * 60;

/**
 * Where to send someone after a successful sign-in.
 *
 * ONLY a path on this origin. `next=https://evil.example` on a login link is the
 * classic open-redirect phish — the URL the victim inspects genuinely is ours,
 * and the hop happens after they have authenticated, which is exactly when they
 * have stopped looking. Protocol-relative `//evil.example` is the same attack
 * spelled differently and is why the second character is checked too.
 */
export function safeNext(value) {
  if (typeof value !== 'string') return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  // A backslash is normalised to a forward slash by some browsers, so "/\evil"
  // can leave the origin. Cheaper to refuse than to reason about per browser.
  if (value.includes('\\')) return '/';
  return value;
}

function redirect(location, extraHeaders = {}) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      // Auth responses are per-session by definition. Without this a shared
      // cache or an over-eager browser can serve one person's redirect — or
      // one person's Set-Cookie — to the next.
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

/**
 * Is this an auth route at all? Checked before the module registry, so a
 * hypothetical future module at /auth could never shadow sign-in.
 */
export function isAuthRoute(pathname) {
  return pathname === '/auth' || pathname.startsWith(AUTH_PREFIX);
}

/**
 * Start a login. Mints single-use state, stashes it in its own sealed cookie,
 * and hands the browser to AuthKit.
 *
 * The state lives in a COOKIE rather than in KV because it makes the CSRF
 * property structural: the state echoed back by the identity provider has to
 * match a value that only this browser was ever given. A KV-side store would
 * work too, but it would make login depend on a KV binding that everything else
 * here treats as optional.
 */
async function startLogin(request, url, config, screenHint) {
  if (await overLimit(config, 'login', clientIp(request), { limit: 30, windowSeconds: 60 })) {
    return tooManyRequests();
  }

  const state = randomToken();
  const payload = {
    state,
    next: safeNext(url.searchParams.get('next') ?? '/'),
    exp: Math.floor(Date.now() / 1000) + LOGIN_STATE_TTL,
  };

  return redirect(
    authorizationUrl(config, {
      state,
      screenHint,
      loginHint: url.searchParams.get('email') ?? undefined,
    }),
    {
      'Set-Cookie': cookie(LOGIN_COOKIE, await seal(payload, config.sessionSecret, 'login'), {
        maxAge: LOGIN_STATE_TTL,
      }),
    },
  );
}

/**
 * Finish a login.
 *
 * Order matters: the state is validated BEFORE the code is spent. An attacker
 * who can get a victim's browser to hit this URL with an attacker-issued code
 * would otherwise log the victim into the attacker's account — session fixation
 * in its OAuth clothing — and the code would already be burned by the time we
 * noticed the state was wrong.
 */
async function finishLogin(request, url, config) {
  if (await overLimit(config, 'callback', clientIp(request), { limit: 20, windowSeconds: 60 })) {
    return tooManyRequests();
  }

  const clearLoginState = clearCookie(LOGIN_COOKIE);

  const raw = readCookie(request, LOGIN_COOKIE);
  const pending = await unseal(raw, config.sessionSecret, 'login');
  const state = url.searchParams.get('state');

  // The cookie is missing entirely versus present-but-not-matching are very
  // different problems — a browser that didn't send it (SameSite, prefix
  // rejection, a cross-site hop we didn't anticipate) versus a stale or
  // replayed attempt. Same refusal either way, different `reason`.
  if (!raw) {
    return authError('Sign-in could not be completed. Start again from the portal.', 400, clearLoginState, 'no_state_cookie');
  }
  if (!pending) {
    // Unsealable: almost always SESSION_SECRET changed between the two halves
    // of the round trip.
    return authError('Sign-in could not be completed. Start again from the portal.', 400, clearLoginState, 'state_unsealable');
  }
  if (!timingSafeEqual(pending.state ?? '', state ?? '')) {
    return authError('Sign-in could not be completed. Start again from the portal.', 400, clearLoginState, 'state_mismatch');
  }
  if (pending.exp < Math.floor(Date.now() / 1000)) {
    return authError('That sign-in link expired. Start again from the portal.', 400, clearLoginState, 'state_expired');
  }

  // AuthKit reports user-facing failures (access denied, unverified email) on
  // the redirect rather than at the token endpoint.
  const providerError = url.searchParams.get('error_description') ?? url.searchParams.get('error');
  if (providerError) return authError(providerError, 400, clearLoginState, 'provider_error');

  const code = url.searchParams.get('code');
  if (!code) return authError('Sign-in could not be completed.', 400, clearLoginState, 'no_code');

  const result = await exchangeCode(config, code);
  if (!result.ok) {
    // WorkOS's own machine code, which is far more use than our HTTP status:
    // `invalid_grant` (code spent, expired, or issued for a different
    // redirect_uri) and `unauthorized_client` / `invalid_client` (the API key
    // belongs to a different environment than the client id) have completely
    // different fixes and both arrive as a 400.
    console.error(`[auth] token exchange rejected: ${JSON.stringify(result.body ?? {})}`);
    return authError(
      'Sign-in could not be completed. Start again from the portal.',
      502,
      clearLoginState,
      `exchange_${result.code}`,
    );
  }

  const { session, cookie: sessionSet } = await startSession(result.data, config);
  if (!session.sub) {
    return authError('Sign-in returned no account.', 502, clearLoginState, 'no_subject');
  }

  const response = redirect(safeNext(pending.next));
  response.headers.append('Set-Cookie', sessionSet);
  response.headers.append('Set-Cookie', clearLoginState);
  return response;
}

/**
 * A sign-in failure the user can read, without telling them anything useful if
 * they are not the intended user. The provider's own message is passed through
 * only for the AuthKit-reported cases above, which are already user-facing.
 *
 * `reason` is the operator's half, and adding it was a correction: the first
 * version gave every failure the same words on the grounds that distinguishing
 * them helps an attacker probe. True, but it also makes the flow undebuggable
 * for the person who owns it — three unrelated faults rendering one sentence,
 * with no way to tell which fired. The split is: the PAGE stays vague, while a
 * response header and a log line carry a short non-sensitive code. Neither
 * reveals whether an account exists, and both turn "it doesn't work" into a
 * name you can act on.
 *
 * Read it with `npx wrangler tail`, or in the Network tab.
 */
function authError(message, status, setCookie, reason = 'unspecified') {
  // Shows up in `wrangler tail` and in Workers observability, which is already
  // enabled in wrangler.jsonc.
  console.error(`[auth] callback refused: ${reason} (${status})`);
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<meta name="robots" content="noindex, nofollow">` +
      `<title>Sign-in problem · Elevrics Portal</title>` +
      `<link rel="stylesheet" href="/css/chrome.css"><link rel="stylesheet" href="/css/portal.css">` +
      `</head><body class="elv-plain"><main class="elv-gate">` +
      `<h1>Sign-in problem</h1><p>${escapeHtml(message)}</p>` +
      `<p><a class="elv-gate-action" href="/auth/login">Try again</a></p>` +
      // Visible to whoever is looking at the page, which is the operator during
      // a cutover. It names a branch of this file, not anything about the
      // account being signed into.
      `<p class="elv-gate-note">Reference: <code>${escapeHtml(reason)}</code></p>` +
      `</main></body></html>`,
    {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Elevrics-Auth-Error': reason,
        ...(setCookie ? { 'Set-Cookie': setCookie } : {}),
      },
    },
  );
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The router's entry point into all of this.
 *
 * @returns a Response for an auth route, or null so the caller carries on.
 */
export async function handleAuthRoute(request, url, config) {
  if (!isAuthRoute(url.pathname)) return null;

  // In 'access' mode these routes do not exist. A 404 rather than a redirect:
  // half-mounted auth is worse than none, and the mode flag exists precisely so
  // this state is explicit.
  if (!config.enabled) return new Response('Not found', { status: 404 });

  const missing = configErrors(config);
  if (missing.length) {
    // 503 not 500: this is configuration that has not landed yet, and the
    // message names exactly which secret so a deploy is not a guessing game.
    return json({ error: 'auth_not_configured', missing }, 503);
  }

  switch (url.pathname) {
    case '/auth/login':
      return startLogin(request, url, config, 'sign-in');

    case '/auth/signup':
      return startLogin(request, url, config, 'sign-up');

    case '/auth/callback':
      return finishLogin(request, url, config);

    case '/auth/logout': {
      // POST only. A GET sign-out is triggerable by any <img> on any page the
      // user visits, and gets fired speculatively by link prefetchers — being
      // silently signed out by a page you merely looked at is a real bug, not a
      // theoretical one. `SameSite=Lax` then means a cross-site POST arrives
      // without the session cookie, so no separate CSRF token is needed.
      if (request.method !== 'POST') {
        return new Response('Use POST to sign out.', {
          status: 405,
          headers: { Allow: 'POST', 'Cache-Control': 'no-store' },
        });
      }
      const { session } = await readSession(request, config);
      return redirect(logoutUrl(config, session?.sid), { 'Set-Cookie': signOutCookie() });
    }

    case '/auth/revoke': {
      if (request.method !== 'POST') {
        return new Response('Use POST.', { status: 405, headers: { Allow: 'POST' } });
      }
      const { session } = await readSession(request, config);
      if (!session) return json({ error: 'not_signed_in' }, 401);
      const revoked = await revokeAll(config, session.sub);
      return redirect(logoutUrl(config, session.sid), {
        'Set-Cookie': signOutCookie(),
        // Surfaced in the header rather than swallowed: without a KV binding
        // this only ended the current session, and that difference matters.
        'X-Elevrics-Revoked-All': String(revoked),
      });
    }

    case '/auth/session': {
      const { session, cookies } = await readSession(request, config);
      const response = session
        ? json({
            signedIn: true,
            email: session.email,
            name: session.name,
            emailVerified: session.emailVerified,
            roles: session.roles,
            organization: session.org,
            impersonator: session.impersonator,
          })
        : json({ signedIn: false }, 200);
      for (const value of cookies) response.headers.append('Set-Cookie', value);
      return response;
    }

    default:
      return new Response('Not found', { status: 404 });
  }
}
