import test from 'node:test';
import assert from 'node:assert/strict';

import { renderRail, renderCards, renderComingSoon } from '../src/nav.js';
import { MODULES, hrefFor, isCurrent } from '../src/modules.js';

/** Registry entries that live on another host. */
const externals = () => Object.entries(MODULES).filter(([, e]) => e.external);

/**
 * A synthetic external entry.
 *
 * No module uses `external: true` today — Finance did until it moved behind
 * Access and became a proxied module. The kind is still supported code, and the
 * guard it carries ("keyed by URL, so no pathname can ever match") is the thing
 * that would matter again the moment something with token-less callers gets
 * added. Testing it against a fixture keeps that property covered without
 * requiring a real external module to exist.
 */
const EXTERNAL_KEY = 'https://example.invalid';
const EXTERNAL_ENTRY = {
  external: true,
  label: 'Example',
  initials: 'EX',
  accent: 'gray',
  group: 'Modules',
  status: 'live',
  stack: 'separate sign-in',
  blurb: 'A destination on another host, linked and never proxied.',
};

/** Run `fn` with the fixture present in the registry, then remove it. */
function withExternal(fn) {
  MODULES[EXTERNAL_KEY] = { ...EXTERNAL_ENTRY };
  try { return fn(EXTERNAL_KEY); } finally { delete MODULES[EXTERNAL_KEY]; }
}


/**
 * The rail and the launcher grid are rendered from the registry, so the property
 * worth asserting is that they STAY derived from it — a link that exists in the
 * markup but not the registry is exactly the drift this replaced.
 */

/**
 * Assert a collection is non-empty before iterating it.
 *
 * Every `for (…) { assert(…) }` here is a test that proves nothing when its
 * collection is empty, and it passes while proving nothing. That is not
 * hypothetical: the `elv-` rename left one of these matching a class prefix
 * that no longer existed, and the test went on passing against zero links.
 */
function some(list, what) {
  assert.ok(list.length > 0, `nothing to check — ${what} matched nothing`);
  return list;
}

test('every registry entry appears in the rail', () => {
  const html = renderRail('/');
  for (const [prefix, entry] of Object.entries(MODULES)) {
    assert.match(html, new RegExp(`href="${hrefFor(prefix)}"`), `${prefix} missing from rail`);
    assert.match(html, new RegExp(entry.label), `${entry.label} missing from rail`);
  }
});

test('an external destination is linked, never routed', () => {
  withExternal(() => {
  for (const [prefix, entry] of some(externals(), 'external registry entries')) {
    assert.ok(!prefix.startsWith('/'), `${prefix} is external but keyed as a path`);
    assert.equal(entry.origin, undefined, `${prefix} is external AND has an origin — it would be proxied`);
  }
  });
});

test('an external link opens away from the portal, and says so', () => {
  withExternal(() => {
  const rail = renderRail('/');
  const cards = renderCards();
  for (const [prefix] of some(externals(), 'external registry entries')) {
    for (const [what, html] of [['rail', rail], ['card', cards]]) {
      const link = html.match(new RegExp(`<a[^>]*href="${prefix}"[^>]*>`))?.[0] ?? '';
      assert.match(link, /target="_blank"/, `${what}: ${prefix} does not open a new tab`);
      assert.match(link, /rel="noopener"/, `${what}: ${prefix} is missing rel=noopener`);
    }
  }
  // The arrow is decorative — the announcement has to be real text.
  assert.match(rail, /aria-hidden="true">\u2197</);
  assert.match(rail, /class="elv-sr-only"> \(opens in a new tab\)</);
  });
});

test('an external destination is never the current page', () => {
  // It is another origin; no portal path can be "inside" it.
  withExternal(() => {
    for (const [prefix] of some(externals(), 'external registry entries')) {
      for (const path of ['/', '/admin/', prefix, `${prefix}/accounts`]) {
        assert.ok(!isCurrent(prefix, path), `${prefix} marked current for ${path}`);
      }
    }
  });
});

test('an external card shows its host, not its scheme', () => {
  withExternal(() => {
    assert.match(renderCards(), /example\.invalid · separate sign-in/);
    assert.doesNotMatch(renderCards(), /https:\/\/example\.invalid ·/);
  });
});

test('the rail links nowhere the registry does not', () => {
  const hrefs = some(
    [...renderRail('/').matchAll(/<a class="elv-rail-\w+" href="([^"]+)"/g)].map((m) => m[1]),
    'rail anchors',
  );
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
    // Anchored on the prefix: `icon-purple` alone is a substring of
    // `elv-icon-purple`, so an unprefixed class would have slipped through.
    assert.match(html, new RegExp(`"elv-rail-tile elv-icon-${entry.accent}">${entry.initials}<`), `${prefix} tile`);
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

test('only a non-live status gets a elv-chip', () => {
  const html = renderRail('/');
  assert.match(html, /class="elv-chip elv-chip-shell">Shell</, 'the admin shell went unchipped');
  // Three live modules + Home: nothing else should be chipped.
  assert.equal([...html.matchAll(/class="elv-chip /g)].length, 1);
});

test('the launcher renders a card per grouped module, and none for Home', () => {
  const html = renderCards();
  const grouped = some(
    Object.entries(MODULES).filter(([, e]) => e.group === 'Modules'),
    'grouped registry entries',
  );
  // `card` or `card card-external` — match the class token, not the whole value.
  assert.equal([...html.matchAll(/class="card[ "]/g)].length, grouped.length);
  for (const [prefix, entry] of grouped) {
    assert.match(html, new RegExp(`href="${hrefFor(prefix)}"`));
    assert.match(html, new RegExp(`"card-icon elv-icon-${entry.accent}"`));
  }
  assert.doesNotMatch(html, /class="card[ "][^>]*href="\/"/, 'the launcher linked to itself');
});

test('a card meta line names the module path and its stack', () => {
  assert.match(renderCards(), /\/solayard · Flask · SQLite/);
});

test('the card and the rail agree about status', () => {
  assert.match(renderCards(), /class="elv-chip elv-chip-shell">Shell</);
  assert.equal([...renderCards().matchAll(/class="elv-chip /g)].length, 1);
});

// ---- Quick switch ----

test('the quick-switch button ships hidden, for script to reveal', () => {
  // It does nothing without JavaScript, and a control that does nothing is
  // worse than no control. Everything else in the rail works either way.
  const html = renderRail('/');
  assert.match(html, /<button type="button" class="elv-rail-search"[^>]*\shidden/);
  assert.match(html, /data-rail-search/);
  assert.match(html, /aria-haspopup="dialog"/);
});

test('the keyboard hint is left empty for the platform to fill', () => {
  // ⌘K on a Mac, Ctrl K elsewhere — the server has no idea which, so it renders
  // the element and portal.js writes the text.
  assert.match(renderRail('/'), /<kbd class="elv-rail-kbd" data-rail-kbd><\/kbd>/);
});

test('the switcher has a list to read: every rail link is labelled', () => {
  // It reads its destinations off the rail rather than carrying a second copy
  // of the registry, so every link needs a label element to read.
  const links = some(
    [...renderRail('/').matchAll(/<a class="elv-rail-link"[\s\S]*?<\/a>/g)].map((m) => m[0]),
    'rail links',
  );
  for (const link of links) {
    assert.match(link, /class="elv-rail-label"/, `a rail link has no label: ${link.slice(0, 60)}`);
    assert.match(link, /class="elv-rail-tile/, `a rail link has no tile: ${link.slice(0, 60)}`);
  }
});

// ---- Who is signed in ----

test('the rail names the signed-in viewer', () => {
  const html = renderRail('/', 'jared@elevrics.ai');
  assert.match(html, /elv-rail-viewer-email[^>]*>jared@elevrics\.ai</);
  assert.match(html, /elv-rail-avatar" aria-hidden="true">J</, 'no collapsed marker');
});

test('no identity means no footer, not an empty one', () => {
  // Local dev has no Access in front of it. A blank "Signed in as" reads as a
  // bug; an absent one reads as local.
  assert.doesNotMatch(renderRail('/', null), /elv-rail-foot/);
  assert.doesNotMatch(renderRail('/'), /elv-rail-foot/);
});

test('the identity is escaped like everything else', () => {
  // Display-only and Access-set, but it is the one value in the rail that does
  // not come from our own registry.
  const html = renderRail('/', '<img src=x onerror=alert(1)>@evil.test');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test('a coming-soon module is chipped "Soon", not its raw status', () => {
  // The status value and the chip wording are separate: `coming_soon` is what
  // the router matches on, and it is too wide for the rail — rendering it raw
  // truncated the label next to it and picked up no chip styling at all.
  MODULES['/demands'] = {
    label: 'Demands', initials: 'DM', accent: 'blue', group: 'Modules',
    status: 'coming_soon', stack: 'not built yet', blurb: 'Demand drafting.',
  };
  try {
    for (const html of [renderRail('/'), renderCards()]) {
      assert.match(html, /class="elv-chip elv-chip-soon">Soon</);
      assert.doesNotMatch(html, /coming_soon</, 'the raw status reached the chip');
      assert.doesNotMatch(html, /elv-chip-coming_soon/, 'chip variant has no styles');
    }
  } finally {
    delete MODULES['/demands'];
  }
});

test('an unrecognised status still renders, so a typo is visible', () => {
  MODULES['/typo'] = { label: 'Typo', initials: 'TY', accent: 'gray', status: 'lve' };
  try {
    // Neutral variant rather than nothing — a status that silently vanishes is
    // a status nobody notices is wrong.
    assert.match(renderRail('/'), /class="elv-chip elv-chip-shell">lve</);
  } finally {
    delete MODULES['/typo'];
  }
});

// ---- Listed but not built ----

test('an unbuilt module renders a whole branded page', () => {
  const entry = {
    label: 'Demands', status: 'coming_soon',
    blurb: 'Demand drafting throughput and the settlement pipeline.',
  };
  const html = renderComingSoon('/demands', entry);
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<title>Demands · Elevrics Portal<\/title>/);
  assert.match(html, /elv-chip elv-chip-soon">Soon</);
  assert.match(html, /Demand drafting throughput/);
  // Same chrome as every other portal page — it is an empty page, not a
  // different kind of page.
  assert.match(html, /data-portal-nav/);
  assert.match(html, /href="\/css\/chrome.css"/);
  assert.match(html, /href="\/css\/portal.css"/);
  // Listed but unbuilt is still internal.
  assert.match(html, /noindex/);
});

test('an unbuilt module escapes its own registry copy', () => {
  const html = renderComingSoon('/x', { label: '<b>X</b>', status: 'coming_soon', blurb: 'a & b' });
  assert.doesNotMatch(html, /<b>X<\/b>/);
  assert.match(html, /&lt;b&gt;X/);
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
