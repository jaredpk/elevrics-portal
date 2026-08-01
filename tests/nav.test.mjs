import test from 'node:test';
import assert from 'node:assert/strict';

import { renderRail, renderCards } from '../src/nav.js';
import { MODULES, hrefFor, isCurrent } from '../src/modules.js';

/**
 * The rail and the launcher grid are rendered from the registry, so the property
 * worth asserting is that they STAY derived from it — a link that exists in the
 * markup but not the registry is exactly the drift this replaced.
 */

test('every registry entry appears in the rail', () => {
  const html = renderRail('/');
  for (const [prefix, entry] of Object.entries(MODULES)) {
    assert.match(html, new RegExp(`href="${hrefFor(prefix)}"`), `${prefix} missing from rail`);
    assert.match(html, new RegExp(entry.label), `${entry.label} missing from rail`);
  }
});

test('an external destination is linked, never routed', () => {
  // finapp takes Plaid webhooks and runs its own OAuth server; proxying it
  // would block every caller that cannot present an Access token, and those
  // failures are silent. Keying it by URL is what makes that impossible.
  for (const [prefix, entry] of Object.entries(MODULES)) {
    if (!entry.external) continue;
    assert.ok(!prefix.startsWith('/'), `${prefix} is external but keyed as a path`);
    assert.equal(entry.origin, undefined, `${prefix} is external AND has an origin — it would be proxied`);
  }
});

test('an external link opens away from the portal, and says so', () => {
  const rail = renderRail('/');
  const cards = renderCards();
  for (const [prefix, entry] of Object.entries(MODULES)) {
    if (!entry.external) continue;
    for (const [what, html] of [['rail', rail], ['card', cards]]) {
      const link = html.match(new RegExp(`<a[^>]*href="${prefix}"[^>]*>`))?.[0] ?? '';
      assert.match(link, /target="_blank"/, `${what}: ${prefix} does not open a new tab`);
      assert.match(link, /rel="noopener"/, `${what}: ${prefix} is missing rel=noopener`);
    }
  }
  // The arrow is decorative — the announcement has to be real text.
  assert.match(rail, /aria-hidden="true">\u2197</);
  assert.match(rail, /class="sr-only"> \(opens in a new tab\)</);
});

test('an external destination is never the current page', () => {
  // It is another origin; no portal path can be "inside" it.
  for (const prefix of Object.keys(MODULES)) {
    if (!MODULES[prefix].external) continue;
    for (const path of ['/', '/admin/', prefix, `${prefix}/accounts`]) {
      assert.ok(!isCurrent(prefix, path), `${prefix} marked current for ${path}`);
    }
  }
});

test('an external card shows its host, not its scheme', () => {
  assert.match(renderCards(), /finance\.elevrics\.ai · separate sign-in/);
  assert.doesNotMatch(renderCards(), /https:\/\/finance\.elevrics\.ai ·/);
});

test('the rail links nowhere the registry does not', () => {
  const hrefs = [...renderRail('/').matchAll(/<a class="rail-\w+" href="([^"]+)"/g)].map((m) => m[1]);
  const known = new Set(Object.keys(MODULES).map(hrefFor));
  // The brand links home, which is a registry entry itself.
  for (const href of hrefs) assert.ok(known.has(href), `rail links to unregistered ${href}`);
});

test('the current page is marked, and only the current page', () => {
  const marked = (html) => [...html.matchAll(/href="([^"]+)" aria-current="page"/g)].map((m) => m[1]);
  assert.deepEqual(marked(renderRail('/')), ['/']);
  assert.deepEqual(marked(renderRail('/admin/')), ['/admin/']);
  assert.deepEqual(marked(renderRail('/solayard')), ['/solayard']);
});

test('a page inside a module still marks that module current', () => {
  assert.match(renderRail('/solayard/reference'), /href="\/solayard" aria-current="page"/);
});

test('"/" is current only for itself, never for every path beneath it', () => {
  assert.ok(isCurrent('/', '/'));
  assert.ok(!isCurrent('/', '/solayard'));
  assert.ok(!isCurrent('/', '/admin/'));
});

test('a sibling prefix does not mark a module current', () => {
  // /solayardxyz is not inside /solayard — the same rule the router applies.
  assert.ok(!isCurrent('/solayard', '/solayardxyz'));
  assert.doesNotMatch(renderRail('/solayardxyz'), /aria-current/);
});

test('every module carries its identity tile into the rail', () => {
  const html = renderRail('/');
  for (const [prefix, entry] of Object.entries(MODULES)) {
    if (prefix === '/') continue;
    // Same initials and accent as the launcher card — the collapsed rail has
    // nothing else to identify a destination by.
    assert.match(html, new RegExp(`icon-${entry.accent}">${entry.initials}<`), `${prefix} tile`);
  }
});

test('the rail is operable without a mouse', () => {
  const html = renderRail('/');
  // The pin is a real button, not a div with a click handler — otherwise it is
  // unreachable by keyboard and invisible to assistive tech.
  assert.match(html, /<button type="button"[^>]*data-rail-pin/);
  assert.match(html, /aria-pressed="/);
  assert.match(html, /aria-label="/);
});

test('only a non-live status gets a chip', () => {
  const html = renderRail('/');
  assert.match(html, /class="chip chip-shell">Shell</, 'the admin shell went unchipped');
  // Three live modules + Home: nothing else should be chipped.
  assert.equal([...html.matchAll(/class="chip /g)].length, 1);
});

test('the launcher renders a card per grouped module, and none for Home', () => {
  const html = renderCards();
  const grouped = Object.entries(MODULES).filter(([, e]) => e.group === 'Modules');
  // `card` or `card card-external` — match the class token, not the whole value.
  assert.equal([...html.matchAll(/class="card[ "]/g)].length, grouped.length);
  for (const [prefix, entry] of grouped) {
    assert.match(html, new RegExp(`href="${hrefFor(prefix)}"`));
    assert.match(html, new RegExp(`icon-${entry.accent}`));
  }
  assert.doesNotMatch(html, /class="card[ "][^>]*href="\/"/, 'the launcher linked to itself');
});

test('a card meta line names the module path and its stack', () => {
  assert.match(renderCards(), /\/solayard · Flask · SQLite/);
});

test('the card and the rail agree about status', () => {
  assert.match(renderCards(), /class="chip chip-shell">Shell</);
  assert.equal([...renderCards().matchAll(/class="chip /g)].length, 1);
});

test('markup is escaped, so a stray angle bracket cannot break out', () => {
  const original = MODULES['/solayard'].blurb;
  MODULES['/solayard'].blurb = 'a <script>alert(1)</script> & "quotes"';
  try {
    const html = renderCards();
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&amp;/);
  } finally {
    MODULES['/solayard'].blurb = original;
  }
});
