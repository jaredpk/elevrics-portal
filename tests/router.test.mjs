import test from 'node:test';
import assert from 'node:assert/strict';

const router = await import('../src/router.js');
const {
  matchModule,
  reprefixLocation,
  reprefixCookiePath,
  matchParkedHost,
  handleRequest,
  MODULES,
} = router;

/** Records what the asset layer was asked for, so host routing is observable. */
function assetSpy() {
  const seen = [];
  const serve = async (req) => {
    seen.push(new URL(req.url).pathname);
    return new Response('ASSET', { status: 200 });
  };
  return { seen, serve };
}

test('a parked host is recognised; the portal host is not', () => {
  assert.equal(matchParkedHost('pathfinder.elevrics.ai'), '/pathfinder-coming-soon/');
  assert.equal(matchParkedHost('portal.elevrics.ai'), null);
});

test('every path on a parked host serves the placeholder', async () => {
  const { seen, serve } = assetSpy();
  for (const path of ['/', '/anything', '/deep/nested/path']) {
    await handleRequest(new Request(`https://pathfinder.elevrics.ai${path}`), serve);
  }
  assert.deepEqual(seen, ['/pathfinder-coming-soon/', '/pathfinder-coming-soon/', '/pathfinder-coming-soon/']);
});

test('a parked host can NEVER reach an internal module', async () => {
  const { seen, serve } = assetSpy();
  // These paths would proxy to the internal dashboards on the portal host.
  for (const path of ['/solayard', '/opportunities/api/leads', '/pathfinder/methodology']) {
    const res = await handleRequest(new Request(`https://pathfinder.elevrics.ai${path}`), serve);
    assert.equal(await res.text(), 'ASSET', `${path} escaped to a module`);
  }
  assert.ok(seen.every((p) => p === '/pathfinder-coming-soon/'), `leaked: ${seen}`);
});

test('the placeholder is served noindex', async () => {
  const { serve } = assetSpy();
  const res = await handleRequest(new Request('https://pathfinder.elevrics.ai/'), serve);
  assert.match(res.headers.get('X-Robots-Tag') ?? '', /noindex/);
});

test('the portal host still falls through to assets for non-module paths', async () => {
  const { seen, serve } = assetSpy();
  await handleRequest(new Request('https://portal.elevrics.ai/admin/'), serve);
  assert.deepEqual(seen, ['/admin/']);
});

test('matches a module on its bare prefix', () => {
  assert.equal(matchModule('/solayard').prefix, '/solayard');
});

test('matches a module on nested paths', () => {
  assert.equal(matchModule('/opportunities/api/leads').prefix, '/opportunities');
});

test('does not match a prefix that is only a string prefix of the path', () => {
  // /solayardxyz must not be routed to the /solayard module.
  assert.equal(matchModule('/solayardxyz'), null);
});

test('falls through for the shell and admin', () => {
  assert.equal(matchModule('/'), null);
  assert.equal(matchModule('/admin/'), null);
  assert.equal(matchModule('/css/portal.css'), null);
});

test('a registry entry with no origin is never proxied', () => {
  // "/" and "/admin" are in the registry so they appear in the nav. Nothing to
  // forward them to, and "/" is a prefix of every path — both must fall through.
  for (const [prefix, config] of Object.entries(MODULES)) {
    if (config.origin) continue;
    assert.equal(matchModule(prefix), null, `${prefix} was treated as a proxy target`);
  }
});

test('chrome is injected into the portal\'s own pages', async () => {
  const { serve } = assetSpy();
  const calls = [];
  const inject = (response, pathname) => {
    calls.push(pathname);
    return response;
  };
  await handleRequest(new Request('https://portal.elevrics.ai/admin/'), serve, inject);
  assert.deepEqual(calls, ['/admin/']);
});

test('chrome is never injected into a parked host', async () => {
  const { serve } = assetSpy();
  let injected = false;
  const inject = (response) => {
    injected = true;
    return response;
  };
  await handleRequest(new Request('https://pathfinder.elevrics.ai/'), serve, inject);
  assert.equal(injected, false, 'the public placeholder was given the module nav');
});

test('the router routes identically with no injector supplied', async () => {
  const { seen, serve } = assetSpy();
  const res = await handleRequest(new Request('https://portal.elevrics.ai/admin/'), serve);
  assert.equal(await res.text(), 'ASSET');
  assert.deepEqual(seen, ['/admin/']);
});

test('pathfinder keeps its prefix; the others are stripped', () => {
  assert.equal(MODULES['/pathfinder'].stripPrefix, false);
  assert.equal(MODULES['/solayard'].stripPrefix, true);
  assert.equal(MODULES['/opportunities'].stripPrefix, true);
});

test('reprefixes a root-absolute redirect', () => {
  assert.equal(
    reprefixLocation('/reference', 'https://solayard-intel.fly.dev', '/solayard'),
    '/solayard/reference',
  );
});

test('reprefixes an absolute redirect back to the origin, preserving query', () => {
  assert.equal(
    reprefixLocation('https://solayard-intel.fly.dev/?all=1', 'https://solayard-intel.fly.dev', '/solayard'),
    '/solayard/?all=1',
  );
});

test('leaves a redirect to a third-party host alone', () => {
  const external = 'https://calendly.com/jared-elevrics';
  assert.equal(reprefixLocation(external, 'https://solayard-intel.fly.dev', '/solayard'), external);
});

test('scopes a root-path cookie to the module', () => {
  assert.match(
    reprefixCookiePath('session=abc; HttpOnly; Path=/; SameSite=Lax', '/opportunities'),
    /Path=\/opportunities;/,
  );
});

test('scopes a nested-path cookie to the module', () => {
  assert.match(
    reprefixCookiePath('a=b; Path=/items', '/solayard'),
    /Path=\/solayard\/items/,
  );
});

test('adds a scoped path to a cookie that has none', () => {
  assert.equal(reprefixCookiePath('a=b; HttpOnly', '/solayard'), 'a=b; HttpOnly; Path=/solayard');
});

test('a scoped cookie never widens back to the portal root', () => {
  for (const cookie of ['s=1; Path=/', 's=1; path=/', 's=1', 's=1; Path=/deep/er']) {
    const out = reprefixCookiePath(cookie, '/opportunities');
    assert.doesNotMatch(out, /Path=\/(;|$|\s)/, `cookie widened to root: ${out}`);
  }
});
