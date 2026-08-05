/**
 * Integration harness: runs the REAL portal router (src/router.js) in front of
 * the REAL local app origins, so the prefix-strip + rewrite design is exercised
 * end to end rather than unit-tested in isolation.
 *
 * No chrome injector is passed — HTMLRewriter is a Workers global with no Node
 * equivalent. Routing behaves identically without it; only the nav markup is
 * absent, and that is tested directly in tests/nav.test.mjs.
 */
import http from 'node:http';
import { handleRequest } from '../src/router.js';
import { MODULES } from '../src/modules.js';
import { authConfig } from '../src/auth/config.js';
import { sessionCookie } from '../src/auth/session.js';

// Point the module origins at the locally running apps.
MODULES['/solayard'].origin = 'http://127.0.0.1:8077';
MODULES['/opportunities'].origin = 'http://127.0.0.1:8099';
MODULES['/pathfinder'].origin = 'http://127.0.0.1:3999';
MODULES['/finance'].origin = 'http://127.0.0.1:3011';

/**
 * The harness signs itself in, rather than running with auth off.
 *
 * There is no "auth off" any more. The portal session is the only login, so the
 * guard is unconditional and a request with no session gets a redirect to
 * WorkOS — which is not something this harness can complete, and not what it is
 * here to test.
 *
 * So it mints a REAL session: a random secret generated at startup, a genuinely
 * sealed cookie, attached to each inbound request and read back by the genuine
 * `readSession`. That is deliberately not a bypass flag. A flag would be a code
 * path that exists in the deployed Worker and can be switched on there; this is
 * an ordinary signed-in user, assembled outside the Worker, exercising exactly
 * the code path a real one does.
 *
 * The secret is per-process and never leaves it, so nothing minted here is worth
 * anything to the deployed portal.
 */
const ENV = {
  SESSION_SECRET: crypto.randomUUID() + crypto.randomUUID(),
  WORKOS_CLIENT_ID: 'client_harness',
  WORKOS_API_KEY: 'sk_harness',
  PORTAL_ORIGIN: 'http://127.0.0.1:8090',
};

const now = Math.floor(Date.now() / 1000);
const HARNESS_COOKIE = (
  await sessionCookie(
    {
      sub: 'user_harness',
      email: 'harness@localhost',
      name: 'Harness',
      roles: ['admin'],
      sid: 'session_harness',
      accessToken: 'harness',
      refreshToken: 'harness',
      // Far future: a refresh would try to reach the real WorkOS API.
      accessExp: now + 365 * 24 * 60 * 60,
      iat: now,
    },
    authConfig(ENV),
  )
).split(';')[0];

const server = http.createServer(async (req, res) => {
  const url = `http://127.0.0.1:8090${req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v);
  }

  // Appended rather than set: a proxied module's own cookies have to survive,
  // and this is exactly the multi-cookie shape a browser would send.
  const existing = headers.get('Cookie');
  headers.set('Cookie', existing ? `${existing}; ${HARNESS_COOKIE}` : HARNESS_COOKIE);

  const request = new Request(url, { method: req.method, headers });
  // Stands in for env.ASSETS.fetch in the deployed Worker.
  const next = async () => new Response('SHELL', { status: 200, headers: { 'x-served-by': 'shell' } });

  let out;
  try {
    out = await handleRequest(request, next, undefined, ENV);
  } catch (e) {
    out = new Response(`harness error: ${e.stack}`, { status: 500 });
  }

  res.statusCode = out.status;
  out.headers.forEach((v, k) => {
    if (k.toLowerCase() !== 'content-encoding') res.setHeader(k, v);
  });
  res.end(Buffer.from(await out.arrayBuffer()));
});

server.listen(8090, '127.0.0.1', () => console.log('harness on 8090'));
