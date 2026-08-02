/**
 * A fixed-window counter in KV, for the auth routes only.
 *
 * SCOPE, because rate limiting is easy to put in the wrong place: WorkOS owns
 * credential brute force, because WorkOS owns the password form — we never see
 * a password attempt and cannot count one. What we can see, and what this
 * covers, is abuse of the routes we do own: someone spraying /auth/callback
 * with codes, or hammering /auth/login to make us mint unbounded state.
 *
 * The heavy lifting belongs at the edge, in a Cloudflare rate-limiting rule on
 * `/auth/*` — it runs before the Worker is even invoked, so it costs nothing and
 * cannot be exhausted by the traffic it is limiting. This is the in-Worker
 * backstop for when that rule is missing or misconfigured, deliberately generous
 * enough that no real person meets it.
 *
 * FAILS OPEN, on purpose. No KV binding, or a KV read that errors, means the
 * request proceeds. A limiter whose own storage outage takes the login page down
 * with it has inverted its job — availability of sign-in matters more than the
 * marginal abuse this catches, given the edge rule underneath it.
 */

/** Cloudflare's client IP. `CF-Connecting-IP` is set by the edge and cannot be spoofed past it. */
export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}

/**
 * @returns true if the caller is over the limit and should be refused.
 */
export async function overLimit(config, bucket, key, { limit, windowSeconds }) {
  if (!config.kv) return false;
  // Window START in the key, so the counter resets by expiring rather than by
  // anything having to reset it. Two adjacent windows can each allow `limit`,
  // which is the known and accepted imprecision of fixed windows.
  const window = Math.floor(Date.now() / 1000 / windowSeconds);
  const name = `rl:${bucket}:${key}:${window}`;
  try {
    const count = Number((await config.kv.get(name)) ?? 0);
    if (count >= limit) return true;
    await config.kv.put(name, String(count + 1), { expirationTtl: windowSeconds * 2 });
    return false;
  } catch {
    return false;
  }
}

/** The 429 itself, with the header a well-behaved client will honour. */
export function tooManyRequests(retryAfter = 60) {
  return new Response('Too many requests. Try again shortly.', {
    status: 429,
    headers: { 'Retry-After': String(retryAfter), 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
