import test from 'node:test';
import assert from 'node:assert/strict';

import { renderNav, renderCards } from '../src/nav.js';
import { MODULES, hrefFor, isCurrent } from '../src/modules.js';

/**
 * The nav and the launcher grid are rendered from the registry, so the property
 * worth asserting is that they STAY derived from it — a link that exists in the
 * markup but not the registry is exactly the drift this replaced.
 */

test('every registry entry appears in the nav', () => {
  const html = renderNav('/');
  for (const [prefix, entry] of Object.entries(MODULES)) {
    assert.match(html, new RegExp(`href="${hrefFor(prefix)}"`), `${prefix} missing from nav`);
    assert.match(html, new RegExp(entry.label), `${entry.label} missing from nav`);
  }
});

test('the nav links nowhere the registry does not', () => {
  const hrefs = [...renderNav('/').matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
  const known = new Set(Object.keys(MODULES).map(hrefFor));
  // The logo links home, which is a registry entry itself.
  for (const href of hrefs) assert.ok(known.has(href), `nav links to unregistered ${href}`);
});

test('the current page is marked, and only the current page', () => {
  const marked = (html) => [...html.matchAll(/<a href="([^"]+)" aria-current="page"/g)].map((m) => m[1]);
  assert.deepEqual(marked(renderNav('/')), ['/']);
  assert.deepEqual(marked(renderNav('/admin/')), ['/admin/']);
  assert.deepEqual(marked(renderNav('/solayard')), ['/solayard']);
});

test('a page inside a module still marks that module current', () => {
  assert.match(renderNav('/solayard/reference'), /href="\/solayard" aria-current="page"/);
});

test('"/" is current only for itself, never for every path beneath it', () => {
  assert.ok(isCurrent('/', '/'));
  assert.ok(!isCurrent('/', '/solayard'));
  assert.ok(!isCurrent('/', '/admin/'));
});

test('a sibling prefix does not mark a module current', () => {
  // /solayardxyz is not inside /solayard — the same rule the router applies.
  assert.ok(!isCurrent('/solayard', '/solayardxyz'));
  assert.doesNotMatch(renderNav('/solayardxyz'), /aria-current/);
});

test('the launcher renders a card per grouped module, and none for Home', () => {
  const html = renderCards();
  const grouped = Object.entries(MODULES).filter(([, e]) => e.group === 'Modules');
  assert.equal([...html.matchAll(/class="card"/g)].length, grouped.length);
  for (const [prefix, entry] of grouped) {
    assert.match(html, new RegExp(`href="${hrefFor(prefix)}"`));
    assert.match(html, new RegExp(`icon-${entry.accent}`));
  }
  assert.doesNotMatch(html, /class="card" href="\/"/, 'the launcher linked to itself');
});

test('a card meta line names the module path and its stack', () => {
  assert.match(renderCards(), /\/solayard · Flask · SQLite/);
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
