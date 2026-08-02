import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RETIRED_HOSTS,
  matchRetiredHost,
  isMachinePath,
  retiredTarget,
  retirementMode,
} from '../src/retired.js';
import { handleRequest } from '../src/router.js';

const FINANCE = RETIRED_HOSTS['finance.elevrics.ai'];

/** Records what the asset layer was asked for, so host routing is observable. */
function assetSpy() {
  const seen = [];
  const serve = async (req) => {
    seen.push(new URL(req.url).pathname);
    return new Response('NOTICE', { status: 200, headers: { 'Content-Type': 'text/html' } });
  };
  return { seen, serve };
}

const on = (path, env = {}) =>
  handleRequest(new Request(`https://finance.elevrics.ai${path}`), assetSpy().serve, undefined, {
    PORTAL_ORIGIN: 'https://portal.elevrics.ai',
    RETIREMENT_MODE: 'redirect',
    ...env,
  });

test('the retired host is recognised; the portal and parked hosts are not', () => {
  assert.ok(matchRetiredHost('finance.elevrics.ai'));
  assert.equal(matchRetiredHost('portal.elevrics.ai'), null);
  assert.equal(matchRetiredHost('pathfinder.elevrics.ai'), null);
});

test('the mode defaults to the announced window, not to the silent redirect', () => {
  assert.equal(retirementMode({}), 'notice');
  assert.equal(retirementMode({ RETIREMENT_MODE: 'anything-else' }), 'notice');
  assert.equal(retirementMode({ RETIREMENT_MODE: 'redirect' }), 'redirect');
});

test('a path maps one-to-one into the portal, query and all', () => {
  const map = (path) =>
    retiredTarget(FINANCE, new URL(`https://finance.elevrics.ai${path}`), 'https://portal.elevrics.ai');

  assert.equal(map('/'), 'https://portal.elevrics.ai/finance');
  assert.equal(map('/accounts'), 'https://portal.elevrics.ai/finance/accounts');
  assert.equal(map('/budgets/2026?view=month'), 'https://portal.elevrics.ai/finance/budgets/2026?view=month');
  assert.equal(map('/assets/app.css'), 'https://portal.elevrics.ai/finance/assets/app.css');
});

test('a deep link 301s, cached in the browser but not forever', async () => {
  const response = await on('/accounts?tab=all');
  assert.equal(response.status, 301);
  assert.equal(
    response.headers.get('Location'),
    'https://portal.elevrics.ai/finance/accounts?tab=all',
  );
  // A 301 with no Cache-Control is cached by some browsers effectively forever,
  // which is a bad property to hand a redirect on its first day.
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=86400');
  assert.match(response.headers.get('Link'), /rel="canonical"/);
  assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow');
});

test('machine endpoints get 410 Gone, NEVER a redirect', async () => {
  // The failure this prevents: a webhook POST redirected into the portal meets
  // an authentication wall, which answers with HTML. Plaid records that as
  // something other than an error and the transaction silently never lands.
  for (const path of [
    '/api/plaid/webhook',
    '/webhook',
    '/mcp',
    '/oauth/token',
    '/.well-known/oauth-authorization-server',
    '/health',
  ]) {
    const response = await on(path);
    assert.equal(response.status, 410, `${path} was not 410`);
    assert.equal(response.headers.get('Location'), null, `${path} redirected`);
    const body = await response.json();
    // The body names the fix, so a broken integration reports its own repair.
    assert.match(body.canonical, /^https:\/\/finapp-v3\.fly\.dev/);
  }
});

test('machine-path matching is case-insensitive and prefix-based', () => {
  assert.ok(isMachinePath(FINANCE, '/API/Plaid/Webhook'));
  assert.ok(isMachinePath(FINANCE, '/mcp'));
  assert.ok(isMachinePath(FINANCE, '/mcp/messages'));
  // A human page that merely starts with the same letters must not be caught.
  assert.ok(!isMachinePath(FINANCE, '/apiary'));
  assert.ok(!isMachinePath(FINANCE, '/accounts'));
});

test('in notice mode only the bare hostname stops; deep links go straight through', async () => {
  const { seen, serve } = assetSpy();
  const env = { PORTAL_ORIGIN: 'https://portal.elevrics.ai', RETIREMENT_MODE: 'notice' };

  const root = await handleRequest(
    new Request('https://finance.elevrics.ai/'),
    serve,
    undefined,
    env,
  );
  assert.equal(root.status, 200);
  assert.deepEqual(seen, ['/finance-retired/']);
  assert.equal(root.headers.get('X-Robots-Tag'), 'noindex, nofollow');

  // Interrupting someone who followed a bookmark to a specific page with an
  // announcement about the move turns a clean consolidation into an irritation.
  const deep = await handleRequest(
    new Request('https://finance.elevrics.ai/accounts'),
    serve,
    undefined,
    env,
  );
  assert.equal(deep.status, 301);
  assert.equal(deep.headers.get('Location'), 'https://portal.elevrics.ai/finance/accounts');
});

test('a retired host can NEVER reach an internal module', async () => {
  // The same guard the parked hosts carry, for the same reason: a hostname that
  // is not the portal must not be able to proxy to one, whatever it asks for.
  for (const path of ['/solayard', '/opportunities/api/leads', '/admin/']) {
    const response = await on(path);
    assert.equal(response.status, 301, `${path} was not redirected`);
    assert.match(response.headers.get('Location'), /^https:\/\/portal\.elevrics\.ai\/finance/);
  }
});

test('the retired host answers without a session, in enforce mode', async () => {
  // Being made to sign in before being told where something moved is hostile,
  // and a redirect discloses nothing the hostname didn't already.
  const response = await on('/accounts', { AUTH_MODE: 'enforce', SESSION_SECRET: 'x'.repeat(40) });
  assert.equal(response.status, 301);
});

test('the portal host is untouched by any of this', async () => {
  const { seen, serve } = assetSpy();
  const response = await handleRequest(
    new Request('https://portal.elevrics.ai/finance/accounts'),
    serve,
    undefined,
    { PORTAL_ORIGIN: 'https://portal.elevrics.ai' },
  );
  // /finance on the portal is a proxied module, not a redirect. It never
  // reaches the asset layer, and it is certainly not a 301 to itself.
  assert.notEqual(response.status, 301);
  assert.deepEqual(seen, []);
});
