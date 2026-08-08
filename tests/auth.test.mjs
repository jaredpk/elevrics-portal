import test from 'node:test';
import assert from 'node:assert/strict';

import { authConfig, configErrors, SESSION_COOKIE, LOGIN_COOKIE } from '../src/auth/config.js';
import { seal, unseal, readCookie, cookie, timingSafeEqual } from '../src/auth/crypto.js';
import { safeNext, handleAuthRoute, isAuthRoute } from '../src/auth/routes.js';
import { isPublicPath, hasRole, gate } from '../src/auth/guard.js';
import { mintAssertion, stripInboundAssertions, jwksResponse, JWKS_PATH } from '../src/auth/assertion.js';
import { sessionCookie, readSession, withCookies } from '../src/auth/session.js';
import { requiredRoleFor } from '../src/modules.js';
import { handleRequest } from '../src/router.js';

const SECRET = 'test-secret-that-is-long-enough-to-be-a-key';

/**
 * A signing key for the module assertion. Generated per run rather than
 * checked in — a private key in a repository is a private key on a laptop, and
 * the test only needs *a* valid P-256 pair.
 */
async function testKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { jwk: JSON.stringify({ ...jwk, kid: 'test-1' }), publicKey: pair.publicKey };
}

const env = (extra = {}) => ({
  SESSION_SECRET: SECRET,
  WORKOS_CLIENT_ID: 'client_test',
  WORKOS_API_KEY: 'sk_test',
  PORTAL_ORIGIN: 'https://portal.elevrics.ai',
  ...extra,
});

const SESSION = {
  sub: 'user_01',
  email: 'jared@elevrics.ai',
  emailVerified: true,
  name: 'Jared',
  org: null,
  roles: ['admin'],
  sid: 'session_01',
  accessToken: 'header.payload.sig',
  refreshToken: 'refresh_01',
  // Far future, so `readSession` never tries to refresh against a real WorkOS.
  accessExp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000),
};

async function signedInRequest(url, extraHeaders = {}) {
  const config = authConfig(env());
  const value = await sealSession(config);
  return new Request(url, {
    headers: { Cookie: `${SESSION_COOKIE}=${value}`, ...extraHeaders },
  });
}

async function sealSession(config, session = SESSION) {
  const setCookie = await sessionCookie(session, config);
  return setCookie.slice(`${SESSION_COOKIE}=`.length, setCookie.indexOf(';'));
}

// ---------------------------------------------------------------- sealing

test('a sealed session round-trips', async () => {
  const sealed = await seal({ sub: 'user_01' }, SECRET);
  assert.deepEqual(await unseal(sealed, SECRET), { sub: 'user_01' });
});

test('a tampered, truncated or wrongly-keyed seal unseals to null, never throws', async () => {
  const sealed = await seal({ sub: 'user_01' }, SECRET);
  const cases = [
    sealed.slice(0, -4),
    `${sealed}AAAA`,
    sealed.replace(/^v1\./, 'v2.'),
    'not-a-token',
    '',
    null,
  ];
  for (const bad of cases) {
    assert.equal(await unseal(bad, SECRET), null, `accepted: ${bad}`);
  }
  assert.equal(await unseal(sealed, 'a-completely-different-secret-value!!'), null);
});

test('the purpose label separates the two cookies that share one secret', async () => {
  // Without HKDF `info` per purpose, a login-state cookie would unseal as a
  // session — which is a forged session assembled from a value we hand out.
  const loginState = await seal({ state: 'abc' }, SECRET, 'login');
  assert.equal(await unseal(loginState, SECRET, 'session'), null);
  assert.deepEqual(await unseal(loginState, SECRET, 'login'), { state: 'abc' });
});

test('the session cookie is __Host- prefixed, HttpOnly, Secure and SameSite', async () => {
  const value = await sessionCookie(SESSION, authConfig(env()));
  assert.ok(value.startsWith('__Host-'), value);
  for (const attr of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']) {
    assert.ok(value.includes(attr), `missing ${attr}: ${value}`);
  }
  // __Host- is browser-rejected with a Domain, which is what stops a sibling
  // subdomain (a retired host, a future client host) from ever seeing it.
  assert.doesNotMatch(value, /Domain=/i);
});

test('cookie parsing survives values containing "=" and ";"-adjacent whitespace', async () => {
  const request = new Request('https://portal.elevrics.ai/', {
    headers: { Cookie: `other=1; ${SESSION_COOKIE}=v1.aa==.bb==; last=2` },
  });
  assert.equal(readCookie(request, SESSION_COOKIE), 'v1.aa==.bb==');
  assert.equal(readCookie(request, 'nope'), null);
});

test('timingSafeEqual agrees with === on the answer', () => {
  assert.ok(timingSafeEqual('abc', 'abc'));
  assert.ok(!timingSafeEqual('abc', 'abd'));
  assert.ok(!timingSafeEqual('abc', 'abcd'));
  assert.ok(!timingSafeEqual('abc', null));
});

// ---------------------------------------------------------------- open redirect

test('post-login destinations can never leave the origin', () => {
  for (const hostile of [
    'https://evil.example/',
    '//evil.example/',
    '/\\evil.example',
    'javascript:alert(1)',
    'http:/evil.example',
    null,
    undefined,
  ]) {
    assert.equal(safeNext(hostile), '/', `escaped: ${hostile}`);
  }
  assert.equal(safeNext('/finance/accounts?tab=all'), '/finance/accounts?tab=all');
});

// ---------------------------------------------------------------- guard

test('the public allowlist covers the sign-in surface and nothing else', () => {
  for (const open of ['/auth/login', '/auth/callback', JWKS_PATH, '/signed-out/', '/css/chrome.css', '/js/portal.js', '/healthz']) {
    assert.ok(isPublicPath(open), `should be public: ${open}`);
  }
  // The launcher and the rail enumerate every internal module by name.
  for (const closed of ['/', '/admin/', '/finance', '/solayard/reference', '/opportunities']) {
    assert.ok(!isPublicPath(closed), `should NOT be public: ${closed}`);
  }
});

test('every tab-icon format is reachable signed out, not just the .ico', () => {
  // The browser asks for these on /signed-out/, which has no session by
  // definition. Gated, they 302 to sign-in and the tab shows a blank page icon.
  for (const icon of ['/favicon.ico', '/favicon.svg', '/apple-touch-icon.png']) {
    assert.ok(isPublicPath(icon), `should be public: ${icon}`);
  }
  // Exact paths, not a prefix: neighbours must not ride along.
  for (const closed of ['/favicon.svg/../', '/apple-touch-icon.png/secret', '/icons/', '/favicon']) {
    assert.ok(!isPublicPath(closed), `should NOT be public: ${closed}`);
  }
});

test('a required role denies a session that carries none', () => {
  assert.ok(hasRole({ roles: ['admin'] }, 'admin'));
  assert.ok(hasRole({ roles: ['member'] }, null), 'no requirement means any account');
  // The admin-safe direction: roles not yet rolled out must not read as "allow".
  assert.ok(!hasRole({ roles: [] }, 'admin'));
  assert.ok(!hasRole({}, 'admin'));
  assert.ok(!hasRole(null, 'admin'));
});

test('/admin requires a role even though it is not a proxied module', () => {
  // matchModule() skips entries with no origin, so a gate that read the
  // requirement off the proxy match would protect nothing here.
  assert.equal(requiredRoleFor('/admin/'), 'admin');
  assert.equal(requiredRoleFor('/admin/tenants'), 'admin');
  assert.equal(requiredRoleFor('/finance'), null);
  assert.equal(requiredRoleFor('/'), null);
});

test('a navigation is redirected to sign in; a fetch gets a 401', () => {
  const config = authConfig(env());
  const url = new URL('https://portal.elevrics.ai/finance/accounts?tab=all');

  const navigation = gate(
    new Request(url, { headers: { 'Sec-Fetch-Dest': 'document' } }),
    url,
    null,
    { config },
  );
  assert.equal(navigation.status, 302);
  assert.equal(
    navigation.headers.get('Location'),
    '/auth/login?next=' + encodeURIComponent('/finance/accounts?tab=all'),
  );

  const xhr = gate(new Request(url, { headers: { 'Sec-Fetch-Dest': 'empty' } }), url, null, {
    config,
  });
  assert.equal(xhr.status, 401);
  assert.match(xhr.headers.get('Content-Type'), /json/);
});

test('there is no mode in which the gate stands down', () => {
  // The AUTH_MODE ladder is gone along with the Cloudflare Access login it was
  // sequencing. An unknown var must not be able to reintroduce it.
  for (const mode of ['access', 'shadow', 'off', '']) {
    const config = authConfig(env({ AUTH_MODE: mode }));
    const url = new URL('https://portal.elevrics.ai/finance');
    const response = gate(
      new Request(url, { headers: { 'Sec-Fetch-Dest': 'document' } }),
      url,
      null,
      { config },
    );
    assert.ok(response, `AUTH_MODE=${mode} let an anonymous request through`);
    assert.equal(response.status, 302, `AUTH_MODE=${mode}`);
  }
});

test('a deploy missing its WorkOS secrets fails closed, and says which', () => {
  // With nothing else in front of the portal, this is the case that used to be
  // covered by Access still being there. It must not be a redirect into a
  // sign-in that cannot complete, and it must never be a pass.
  const config = authConfig({ SESSION_SECRET: SECRET });
  const url = new URL('https://portal.elevrics.ai/finance');
  const response = gate(new Request(url, { headers: { 'Sec-Fetch-Dest': 'document' } }), url, null, {
    config,
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');

  // Still open where it has to be: /auth/* and the sign-out page answer, so the
  // 503 is legible at the login route too rather than shadowing it.
  assert.equal(gate(new Request(url), new URL('https://portal.elevrics.ai/auth/login'), null, { config }), null);
});

test('a signed-in account without the role gets 403, not a second sign-in', () => {
  const config = authConfig(env());
  const url = new URL('https://portal.elevrics.ai/admin/');
  const response = gate(new Request(url), url, { roles: ['member'] }, {
    config,
    requiredRole: 'admin',
  });
  assert.equal(response.status, 403);
});

// ---------------------------------------------------------------- routes

test('auth routes are recognised before any module could shadow them', () => {
  assert.ok(isAuthRoute('/auth/login'));
  assert.ok(isAuthRoute('/auth'));
  assert.ok(!isAuthRoute('/authors'));
});

test('a half-configured deploy fails legibly at the login route', async () => {
  const config = authConfig({ SESSION_SECRET: SECRET });
  assert.deepEqual(configErrors(config), ['WORKOS_CLIENT_ID', 'WORKOS_API_KEY']);
  const url = new URL('https://portal.elevrics.ai/auth/login');
  const response = await handleAuthRoute(new Request(url), url, config);
  assert.equal(response.status, 503);
  assert.deepEqual((await response.json()).missing, ['WORKOS_CLIENT_ID', 'WORKOS_API_KEY']);
});

test('login mints single-use state, stashes it, and carries the destination', async () => {
  const config = authConfig(env());
  const url = new URL('https://portal.elevrics.ai/auth/login?next=/finance/accounts');
  const response = await handleAuthRoute(new Request(url), url, config);

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');

  const location = new URL(response.headers.get('Location'));
  assert.equal(location.host, 'api.workos.com');
  assert.equal(location.pathname, '/user_management/authorize');
  assert.equal(location.searchParams.get('redirect_uri'), 'https://portal.elevrics.ai/auth/callback');
  assert.equal(location.searchParams.get('screen_hint'), 'sign-in');

  const setCookie = response.headers.get('Set-Cookie');
  assert.ok(setCookie.startsWith(`${LOGIN_COOKIE}=`), setCookie);
  const sealed = setCookie.slice(`${LOGIN_COOKIE}=`.length, setCookie.indexOf(';'));
  const pending = await unseal(sealed, SECRET, 'login');
  assert.equal(pending.next, '/finance/accounts');
  assert.equal(pending.state, location.searchParams.get('state'));
});

test('signup is the same flow with a different AuthKit screen', async () => {
  const config = authConfig(env());
  const url = new URL('https://portal.elevrics.ai/auth/signup');
  const response = await handleAuthRoute(new Request(url), url, config);
  const location = new URL(response.headers.get('Location'));
  assert.equal(location.searchParams.get('screen_hint'), 'sign-up');
});

test('the callback refuses a mismatched, missing or expired state', async () => {
  const config = authConfig(env());
  const good = await seal(
    { state: 'the-real-state', next: '/', exp: Math.floor(Date.now() / 1000) + 60 },
    SECRET,
    'login',
  );
  const expired = await seal(
    { state: 'the-real-state', next: '/', exp: Math.floor(Date.now() / 1000) - 1 },
    SECRET,
    'login',
  );

  const attempt = async (query, stateCookie) => {
    const url = new URL(`https://portal.elevrics.ai/auth/callback${query}`);
    const headers = stateCookie ? { Cookie: `${LOGIN_COOKIE}=${stateCookie}` } : {};
    return handleAuthRoute(new Request(url, { headers }), url, config);
  };

  // A forged code with no state cookie is the session-fixation shape: it must
  // be refused BEFORE the code is spent, so no network call can have happened.
  assert.equal((await attempt('?code=attacker_code', null)).status, 400);
  assert.equal((await attempt('?code=x&state=wrong', good)).status, 400);
  assert.equal((await attempt('?code=x&state=the-real-state', expired)).status, 400);
  // Valid state, no code — still refused, and still without a network call.
  assert.equal((await attempt('?state=the-real-state', good)).status, 400);
});

test('sign-out is POST-only', async () => {
  const config = authConfig(env());
  const url = new URL('https://portal.elevrics.ai/auth/logout');
  const get = await handleAuthRoute(new Request(url), url, config);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('Allow'), 'POST');

  const post = await handleAuthRoute(
    await signedInRequest(url, {}).then((r) => new Request(r, { method: 'POST' })),
    url,
    config,
  );
  assert.equal(post.status, 302);
  // Clears our cookie AND ends the session at WorkOS — clearing only ours would
  // let the next /auth/login sail straight back through with no prompt.
  assert.match(post.headers.get('Set-Cookie'), /^__Host-elv_session=; /);
  const location = new URL(post.headers.get('Location'));
  assert.equal(location.pathname, '/user_management/sessions/logout');
  assert.equal(location.searchParams.get('session_id'), 'session_01');
});

test('/auth/session reports the account without leaking its tokens', async () => {
  const config = authConfig(env());
  const url = new URL('https://portal.elevrics.ai/auth/session');
  const response = await handleAuthRoute(await signedInRequest(url), url, config);
  const body = await response.json();

  assert.equal(body.signedIn, true);
  assert.equal(body.email, 'jared@elevrics.ai');
  assert.deepEqual(body.roles, ['admin']);
  const text = JSON.stringify(body);
  assert.ok(!text.includes('refresh_01'), 'refresh token leaked');
  assert.ok(!text.includes(SESSION.accessToken), 'access token leaked');
});

// ---------------------------------------------------------------- sessions

test('an unsealable or over-age cookie signs the browser out rather than lingering', async () => {
  const config = authConfig(env());

  const garbage = await readSession(
    new Request('https://portal.elevrics.ai/', { headers: { Cookie: `${SESSION_COOKIE}=nonsense` } }),
    config,
  );
  assert.equal(garbage.session, null);
  assert.match(garbage.cookies[0], /Max-Age=0/);

  // Beyond the absolute cap. Refreshing must not be able to extend past it.
  const ancient = await sealSession(config, {
    ...SESSION,
    iat: Math.floor(Date.now() / 1000) - 40 * 24 * 60 * 60,
  });
  const stale = await readSession(
    new Request('https://portal.elevrics.ai/', { headers: { Cookie: `${SESSION_COOKIE}=${ancient}` } }),
    config,
  );
  assert.equal(stale.session, null);
  assert.match(stale.cookies[0], /Max-Age=0/);
});

test('withCookies adds Set-Cookie without discarding what the response had', () => {
  const original = new Response('body', { headers: { 'Set-Cookie': 'module=1; Path=/finance' } });
  const merged = withCookies(original, ['__Host-elv_session=abc; Path=/']);
  const all = merged.headers.getSetCookie();
  assert.equal(all.length, 2);
  assert.ok(all.some((c) => c.startsWith('module=1')));
  assert.ok(all.some((c) => c.startsWith('__Host-elv_session=')));
});

// ---------------------------------------------------------------- assertions

test('the module assertion verifies against the published JWKS', async () => {
  const { jwk, publicKey } = await testKey();
  const config = authConfig(env({ ASSERTION_SIGNING_KEY: jwk }));

  const token = await mintAssertion(config, SESSION, '/finance');
  const [header, payload, signature] = token.split('.');

  const decode = (part) =>
    JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());

  assert.equal(decode(header).alg, 'ES256');
  assert.equal(decode(header).kid, 'test-1');

  const claims = decode(payload);
  assert.equal(claims.iss, 'https://portal.elevrics.ai');
  // Audience is the ROUTING PREFIX, so a token minted for one module cannot be
  // replayed against another.
  assert.equal(claims.aud, '/finance');
  assert.equal(claims.sub, 'user_01');
  assert.deepEqual(claims.roles, ['admin']);
  assert.ok(claims.exp - claims.iat <= 120, 'assertion lives too long');

  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
    new TextEncoder().encode(`${header}.${payload}`),
  );
  assert.ok(valid, 'signature did not verify');
});

test('no assertion is minted without a key or without a session', async () => {
  const { jwk } = await testKey();
  assert.equal(await mintAssertion(authConfig(env()), SESSION, '/finance'), null);
  assert.equal(
    await mintAssertion(authConfig(env({ ASSERTION_SIGNING_KEY: jwk })), null, '/finance'),
    null,
  );
});

test('the JWKS publishes the public half and never the private one', async () => {
  const { jwk } = await testKey();
  const config = authConfig(env({ ASSERTION_SIGNING_KEY: jwk }));
  const body = await (await jwksResponse(config, {})).json();

  assert.equal(body.keys.length, 1);
  assert.equal(body.keys[0].kid, 'test-1');
  assert.equal(body.keys[0].alg, 'ES256');
  assert.equal(body.keys[0].d, undefined, 'PRIVATE KEY PUBLISHED');
  assert.ok(body.keys[0].x && body.keys[0].y);
});

test('the JWKS publishes both keys during a rotation, and survives a bad one', async () => {
  const a = await testKey();
  const b = await testKey();
  const config = authConfig(env({ ASSERTION_SIGNING_KEY: a.jwk }));

  const both = await (await jwksResponse(config, { ASSERTION_SIGNING_KEY_NEXT: b.jwk })).json();
  assert.equal(both.keys.length, 2);

  // A malformed second key must not take the endpoint down for the good one.
  const survives = await (await jwksResponse(config, { ASSERTION_SIGNING_KEY_NEXT: '{{{' })).json();
  assert.equal(survives.keys.length, 1);
});

test('every X-Elevrics-* header a client sends is deleted', () => {
  const headers = new Headers({
    'X-Elevrics-Assertion': 'forged',
    'x-elevrics-anything-future': 'also forged',
    'X-Forwarded-Host': 'kept',
    Accept: 'kept',
  });
  stripInboundAssertions(headers);
  assert.equal(headers.get('X-Elevrics-Assertion'), null);
  assert.equal(headers.get('x-elevrics-anything-future'), null);
  assert.equal(headers.get('X-Forwarded-Host'), 'kept');
});

// ---------------------------------------------------------------- end to end

test('an unauthenticated navigation to the launcher is sent to sign in', async () => {
  const serve = async () => new Response('LAUNCHER');
  const response = await handleRequest(
    new Request('https://portal.elevrics.ai/', { headers: { 'Sec-Fetch-Dest': 'document' } }),
    serve,
    undefined,
    env(),
  );
  assert.equal(response.status, 302);
  assert.match(response.headers.get('Location'), /^\/auth\/login\?next=/);
});

test('a signed-in request reaches the launcher', async () => {
  const serve = async () => new Response('LAUNCHER');
  const response = await handleRequest(
    await signedInRequest('https://portal.elevrics.ai/', { 'Sec-Fetch-Dest': 'document' }),
    serve,
    undefined,
    env(),
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'LAUNCHER');
});

test('the JWKS is reachable with no session at all', async () => {
  const { jwk } = await testKey();
  const response = await handleRequest(
    new Request(`https://portal.elevrics.ai${JWKS_PATH}`),
    async () => new Response('ASSET'),
    undefined,
    env({ ASSERTION_SIGNING_KEY: jwk }),
  );
  // An origin fetches this as a machine, with no cookie and no way to get one.
  assert.equal(response.status, 200);
  assert.equal((await response.json()).keys.length, 1);
});

test('an env with no auth config at all serves nothing, rather than everything', async () => {
  // This is the inversion the Access removal forced, and it is the single most
  // important line in this file. It used to pass: a three-argument caller got an
  // unenforced router, which was safe only because Access was still in front.
  // With one login and nothing behind it, "no config" has to mean closed.
  const response = await handleRequest(
    new Request('https://portal.elevrics.ai/'),
    async () => new Response('LAUNCHER'),
  );
  assert.equal(response.status, 503);
  assert.deepEqual((await response.json()).missing, [
    'WORKOS_CLIENT_ID',
    'WORKOS_API_KEY',
    'SESSION_SECRET',
  ]);
});

test('the signed-out page is never decorated with the rail', async () => {
  // The rail enumerates every internal module by name, and this is the one
  // portal page an unauthenticated visitor is meant to reach.
  const injected = [];
  const inject = (response, ctx) => {
    injected.push(ctx.pathname);
    return response;
  };
  const serve = async () => new Response('<html><body></body></html>', {
    headers: { 'Content-Type': 'text/html' },
  });

  await handleRequest(new Request('https://portal.elevrics.ai/signed-out/'), serve, inject, env());
  assert.deepEqual(injected, []);

  // …while a real portal page still is.
  await handleRequest(
    await signedInRequest('https://portal.elevrics.ai/'),
    serve,
    inject,
    env(),
  );
  assert.deepEqual(injected, ['/']);
});

test('the JWKS publishes only verification fields', async () => {
  // A private JWK from Web Crypto also carries key_ops:["sign"] and ext:true; a
  // strict verifier is entitled to reject a key that says it is for signing.
  const { jwk } = await testKey();
  const body = await (await jwksResponse(authConfig(env({ ASSERTION_SIGNING_KEY: jwk })), {})).json();
  assert.deepEqual(Object.keys(body.keys[0]).sort(), [
    'alg', 'crv', 'key_ops', 'kid', 'kty', 'use', 'x', 'y',
  ]);
  assert.deepEqual(body.keys[0].key_ops, ['verify']);
  assert.equal(body.keys[0].ext, undefined);
});

test('each callback failure carries its own reason code', async () => {
  // The page stays vague on purpose; the reason is for whoever operates this.
  // Three unrelated faults rendering one identical sentence is what made a real
  // cutover undebuggable.
  const config = authConfig(env());
  const good = await seal(
    { state: 'the-real-state', next: '/', exp: Math.floor(Date.now() / 1000) + 60 },
    SECRET,
    'login',
  );
  const expired = await seal(
    { state: 'the-real-state', next: '/', exp: Math.floor(Date.now() / 1000) - 1 },
    SECRET,
    'login',
  );

  const reasonFor = async (query, stateCookie) => {
    const url = new URL(`https://portal.elevrics.ai/auth/callback${query}`);
    const headers = stateCookie ? { Cookie: `${LOGIN_COOKIE}=${stateCookie}` } : {};
    const response = await handleAuthRoute(new Request(url, { headers }), url, config);
    return response.headers.get('X-Elevrics-Auth-Error');
  };

  assert.equal(await reasonFor('?code=x&state=y', null), 'no_state_cookie');
  assert.equal(await reasonFor('?code=x&state=y', 'v1.garbage.garbage'), 'state_unsealable');
  assert.equal(await reasonFor('?code=x&state=wrong', good), 'state_mismatch');
  assert.equal(await reasonFor('?code=x&state=the-real-state', expired), 'state_expired');
  assert.equal(await reasonFor('?state=the-real-state', good), 'no_code');
  assert.equal(
    await reasonFor('?state=the-real-state&error=access_denied', good),
    'provider_error',
  );
});

test("a rejected token exchange reports WorkOS's own code, not just the status", async () => {
  // `invalid_grant` (code spent, or issued for a different redirect_uri) and
  // `unauthorized_client` (API key from another environment) both arrive as a
  // 400 and have completely different fixes. The status alone cannot separate
  // them, which is exactly what stalled a real cutover.
  const config = authConfig(env());
  const pending = await seal(
    { state: 'st', next: '/', exp: Math.floor(Date.now() / 1000) + 60 },
    SECRET,
    'login',
  );

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'code expired' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });

  try {
    const url = new URL('https://portal.elevrics.ai/auth/callback?code=abc&state=st');
    const response = await handleAuthRoute(
      new Request(url, { headers: { Cookie: `${LOGIN_COOKIE}=${pending}` } }),
      url,
      config,
    );
    assert.equal(response.headers.get('X-Elevrics-Auth-Error'), 'exchange_invalid_grant');
    // The provider's prose is logged, never rendered.
    assert.ok(!(await response.text()).includes('code expired'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the reason never leaks whether an account exists', async () => {
  // Every code names a branch of routes.js. None is derived from the identity
  // being signed in, so probing with a real address tells you nothing.
  const config = authConfig(env());
  const url = new URL('https://portal.elevrics.ai/auth/callback?code=x&state=y');
  const response = await handleAuthRoute(new Request(url), url, config);
  const reason = response.headers.get('X-Elevrics-Auth-Error');
  assert.match(reason, /^[a-z0-9_]+$/);
  assert.ok(!reason.includes('@'));
});
