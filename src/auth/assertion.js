/**
 * The identity assertion the modules verify — the piece that let Cloudflare
 * Access come off without every origin becoming open.
 *
 * THE PROBLEM THIS SOLVES. Each Fly origin used to verify
 * `Cf-Access-Jwt-Assertion` itself against `elevrics.cloudflareaccess.com`,
 * because the Fly hostnames stay publicly reachable and a direct hit on
 * `*.fly.dev` has to be rejected AT THE ORIGIN, not at the router. That property
 * had to survive the move off Access — otherwise replacing the login also
 * silently converts four independently-defended services into four open ones
 * behind a proxy.
 *
 * So the portal issues its own equivalent: a 2-minute ES256 JWT, one per
 * request, sent as `X-Elevrics-Assertion`. An origin verifies it exactly the way
 * it verifies the Access token today — fetch a JWKS, check the signature, check
 * `iss`/`aud`/`exp` — which is a substitution in an existing code path rather
 * than a new one.
 *
 * ES256 rather than a shared HMAC secret: the public key can be published, so
 * onboarding an origin is a URL and not a secret to distribute, rotate and leak.
 * A stolen JWKS lets you verify assertions, which is what everyone should be
 * able to do.
 *
 * TWO MINUTES is not a typo. The assertion is minted per request and consumed
 * immediately; anything longer is a replay window bought for no benefit.
 */

/** Header names the portal mints. See `stripInboundAssertions` — this list is a guard, not a convention. */
export const ASSERTION_HEADER = 'X-Elevrics-Assertion';
const PORTAL_HEADER_PREFIX = 'x-elevrics-';

const ASSERTION_TTL = 120;

/** One import per isolate per key — importKey is not free, and this runs per request. */
const keyCache = new Map();

async function signingKey(jwkText) {
  if (keyCache.has(jwkText)) return keyCache.get(jwkText);
  const jwk = JSON.parse(jwkText);
  const promise = crypto.subtle
    .importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
    .then((key) => ({ key, jwk }));
  keyCache.set(jwkText, promise);
  return promise;
}

function b64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const encodeSegment = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

/**
 * Mint an assertion for one request to one module.
 *
 * `aud` is the module's routing prefix rather than its Fly hostname. The origin
 * is deployment detail that changes; the prefix is what the portal means. An
 * origin that checks `aud === '/finance'` is asserting "this token was minted
 * for me", which is the property that stops a token minted for one module being
 * replayed against another.
 */
export async function mintAssertion(config, session, audience) {
  if (!config.assertionKey || !session?.sub) return null;

  const { key, jwk } = await signingKey(config.assertionKey);
  const issued = Math.floor(Date.now() / 1000);

  const header = { alg: 'ES256', typ: 'JWT', kid: jwk.kid ?? 'portal-1' };
  const payload = {
    iss: config.portalOrigin,
    aud: audience,
    sub: session.sub,
    email: session.email,
    email_verified: session.emailVerified,
    name: session.name,
    org: session.org,
    roles: session.roles ?? [],
    // Present only when a WorkOS admin is browsing as this user. An origin that
    // writes data should refuse, or at least log loudly, when this is set.
    ...(session.impersonator ? { impersonator: session.impersonator } : {}),
    iat: issued,
    exp: issued + ASSERTION_TTL,
  };

  const body = `${encodeSegment(header)}.${encodeSegment(payload)}`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(body),
  );
  return `${body}.${b64url(new Uint8Array(signature))}`;
}

/**
 * Delete every `X-Elevrics-*` header a CLIENT sent before we add our own.
 *
 * Without this the whole scheme is decorative: anyone could send
 * `X-Elevrics-Assertion: <their own token>` to portal.elevrics.ai and have the
 * router forward it verbatim to a module. The origins verify signatures, so a
 * forged one fails — but a *previously valid* one, captured and replayed, would
 * not, and the portal would be the thing that carried it.
 *
 * Blanket prefix rather than a named list on purpose: the next header we add is
 * covered the day it is added, not the day someone remembers this file.
 */
export function stripInboundAssertions(headers) {
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith(PORTAL_HEADER_PREFIX)) headers.delete(name);
  }
}

/**
 * The public half, served unauthenticated at
 * `/.well-known/portal-jwks.json`.
 *
 * Must be reachable without a session — an origin fetches it as a machine, with
 * no cookie and no way to get one, and a JWKS behind a login is a JWKS nobody
 * can use. It is public key material; that is what public key material is for.
 *
 * "WITHOUT A SESSION" IS NOT ENOUGH — IT MUST BE REACHABLE WITHOUT LOOKING HUMAN.
 * This Worker cannot enforce that on its own. Cloudflare's bot protection runs
 * at the edge, BEFORE the Worker, so a request it scores as automated is
 * refused with a 403 that this code never sees. That is not hypothetical: it
 * took solayard-intel down completely, because PyJWKClient fetches through
 * urllib and "Python-urllib/3.x" is filtered. curl from a laptop worked the
 * whole time, which is exactly what made it hard to find.
 *
 * So this path needs a WAF skip / bot-protection exemption in the dashboard,
 * and that requirement belongs here rather than in an origin's troubleshooting
 * notes: the alternative is every origin guessing a user-agent that gets
 * through, in a different language each time. See the README.
 *
 * Two keys are publishable at once (`ASSERTION_SIGNING_KEY_NEXT`), which is what
 * makes rotation a sequence rather than an outage: publish both, switch signing,
 * retire the old one after every origin's JWKS cache has turned over.
 */
export async function jwksResponse(config, env = {}) {
  const keys = [];
  for (const source of [config.assertionKey, env.ASSERTION_SIGNING_KEY_NEXT]) {
    if (!source) continue;
    try {
      const jwk = JSON.parse(source);
      // Named fields, not "everything except `d`". A private JWK exported by
      // Web Crypto also carries `key_ops: ["sign"]` and `ext: true`, and a
      // strict verifier is entitled to reject a key whose declared operation is
      // signing when it wants to verify. Allowlisting also means a future
      // private-ish field cannot be published by having been forgotten.
      keys.push({
        kty: jwk.kty,
        crv: jwk.crv,
        x: jwk.x,
        y: jwk.y,
        kid: jwk.kid ?? 'portal-1',
        use: 'sig',
        alg: 'ES256',
        key_ops: ['verify'],
      });
    } catch {
      // A malformed key must not take the endpoint down for the good one.
    }
  }
  return new Response(JSON.stringify({ keys }, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // Long enough that origins are not fetching this per request, short
      // enough that a rotation completes the same day.
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export const JWKS_PATH = '/.well-known/portal-jwks.json';
