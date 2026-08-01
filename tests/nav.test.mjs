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
