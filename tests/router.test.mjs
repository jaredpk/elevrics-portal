import test from 'node:test';
import assert from 'node:assert/strict';

const router = await import('../src/router.js');
const { matchModule, reprefixLocation, reprefixCookiePath, MODULES } = router;

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
