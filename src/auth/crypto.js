/**
 * The small amount of cryptography the portal genuinely owns.
 *
 * Deliberately NOT here: password hashing, credential storage, verification and
 * reset token issuance, MFA enrolment. WorkOS owns all of that — see
 * `docs/auth-architecture.md`. What is left is sealing our own session cookie
 * and signing the short-lived assertion the modules verify, both of which are
 * standard AEAD/JWS constructions over Web Crypto with no secret-dependent
 * branching to get wrong.
 *
 * Web Crypto is a global in both Workers and Node ≥ 20, so this file is testable
 * in `node --test` with no shims — the same property that lets `router.js` be
 * tested without wrangler.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64urlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Derive a purpose-bound AES key from the raw secret.
 *
 * HKDF with a distinct `info` per purpose is why one `SESSION_SECRET` can safely
 * back both the session cookie and the login-state cookie: the two keys are
 * unrelated, so a token minted for one purpose cannot be unsealed as the other
 * even though the operator only manages one secret.
 */
async function deriveKey(secret, purpose) {
  const material = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('elevrics-portal'), info: enc.encode(purpose) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypt a JSON payload into a cookie-safe string.
 *
 * AES-GCM rather than sign-only, because the session carries WorkOS refresh
 * tokens. A signed-but-readable cookie would put a long-lived credential in
 * every browser's devtools and every proxy log that captures a Cookie header.
 *
 * The `v1.` prefix is a rotation seam: a future `v2.` can be minted while `v1.`
 * is still accepted, so a key change does not sign everyone out at once.
 */
export async function seal(payload, secret, purpose = 'session') {
  const key = await deriveKey(secret, purpose);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(payload))),
  );
  return `v1.${b64urlEncode(iv)}.${b64urlEncode(body)}`;
}

/**
 * Reverse of `seal`. Returns null for anything that isn't a valid sealed value
 * under this key — tampering, truncation, a rotated secret, a cookie sealed for
 * a different purpose, or plain garbage.
 *
 * NEVER throws, and never distinguishes the failure modes. Callers treat a null
 * session as "signed out", which is the only safe interpretation of all of them,
 * and an error message that separated "wrong key" from "tampered" would be a
 * gift to anyone probing.
 */
export async function unseal(token, secret, purpose = 'session') {
  if (typeof token !== 'string') return null;
  const [version, ivPart, bodyPart] = token.split('.');
  if (version !== 'v1' || !ivPart || !bodyPart) return null;
  try {
    const key = await deriveKey(secret, purpose);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64urlDecode(ivPart) },
      key,
      b64urlDecode(bodyPart),
    );
    return JSON.parse(dec.decode(plain));
  } catch {
    return null;
  }
}

/** URL-safe random token, for OAuth `state` and anything else unguessable. */
export function randomToken(bytes = 32) {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * Compare two strings without leaking their common prefix through timing.
 *
 * Used on the OAuth `state` echo. The window is small and the values are
 * single-use, but a comparison that is constant-time by construction costs
 * three lines and removes the question.
 */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Read one cookie out of a Cookie header.
 *
 * Hand-rolled rather than split(';') on a regex over the whole header: cookie
 * VALUES may contain '=', and `__Host-elv_session` is base64url with dots, so
 * only the first '=' separates name from value.
 */
export function readCookie(request, name) {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const pair = part.trim();
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    if (pair.slice(0, eq) === name) return decodeURIComponent(pair.slice(eq + 1));
  }
  return null;
}

/**
 * Build a Set-Cookie value.
 *
 * `__Host-` prefixed names are rejected by the browser unless Secure is set,
 * Path is exactly "/" and Domain is absent — which is precisely the shape we
 * want, enforced by the client rather than by our remembering. It also means a
 * portal session cookie can never be set BY, or sent TO, a sibling subdomain:
 * the retired finance host cannot touch it, and neither could a future
 * `{client}.elevrics.ai`.
 */
export function cookie(name, value, { maxAge, sameSite = 'Lax' } = {}) {
  const parts = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    `SameSite=${sameSite}`,
  ];
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  return parts.join('; ');
}

/** Expire a cookie. Same attributes, empty value, Max-Age=0. */
export function clearCookie(name) {
  return cookie(name, '', { maxAge: 0 });
}
