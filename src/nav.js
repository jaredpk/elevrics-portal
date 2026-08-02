/**
 * Portal chrome, rendered from the registry.
 *
 * These are pure string builders with no DOM and no runtime dependency, so they
 * unit-test directly in Node — the part worth testing is the markup, not the
 * mechanism that staples it into a page. `chrome.js` is the thin Workers-only
 * glue that does the stapling.
 *
 * Both static pages used to carry a hand-copied <nav>; keeping them in sync was
 * already manual at two pages and would only get worse. Now there is one
 * renderer and one registry behind it.
 */

import { MODULES, entries, hrefFor, isCurrent, metaPathFor } from './modules.js';

/**
 * The registry is static and authored here, so this guards against typos in our
 * own copy rather than untrusted input — but chrome gets injected into proxied
 * module pages next, and markup that escapes by default is the version that's
 * safe to point at HTML we don't own.
 */
function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The Elevrics mark. Gradient ids are `elv-` prefixed because this markup gets
 * injected into pages we don't own, where a bare `n1` could collide with an
 * existing def and silently repaint someone else's icon.
 */
const LOGO = `<svg class="elv-rail-mark" width="24" height="20" viewBox="0 0 24 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="elv-n1" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#9B5CF6"/><stop offset="100%" stop-color="#7B2CBF"/></linearGradient>
    <linearGradient id="elv-n2" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#6D8EF8"/><stop offset="100%" stop-color="#3C6FF0"/></linearGradient>
    <linearGradient id="elv-n3" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#2EC4BD"/><stop offset="100%" stop-color="#00A19A"/></linearGradient>
  </defs>
  <rect x="0" y="11" width="6" height="9" rx="2" fill="url(#elv-n1)"/>
  <rect x="9" y="5.5" width="6" height="14.5" rx="2" fill="url(#elv-n2)"/>
  <rect x="18" y="0" width="6" height="20" rx="2" fill="url(#elv-n3)"/>
</svg>`;

/** Home's marker. Modules get their initials tile; the launcher gets a glyph. */
const HOME_GLYPH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/>
  <rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>
</svg>`;

/** The quick-switch affordance. Keyboard-only features nobody can see don't exist. */
const SEARCH_GLYPH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>
</svg>`;

/** Chevrons: point left to collapse when pinned, right to open when not. */
const PIN_GLYPH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="m11 17-5-5 5-5"/><path d="m18 17-5-5 5-5"/>
</svg>`;

/**
 * The attributes and affordance for a link that leaves the portal.
 *
 * The arrow is decorative, so it is hidden from assistive tech and paired with
 * real text — a new tab opening unannounced is disorienting for a screen-reader
 * user, and "↗" alone announces as nothing or as garbage.
 */
const EXTERNAL_ATTRS = ' target="_blank" rel="noopener"';
const EXTERNAL_MARK =
  '<span class="elv-ext-mark" aria-hidden="true">\u2197</span>' +
  '<span class="elv-sr-only"> (opens in a new tab)</span>';

/** Door-with-an-arrow. Sign out is the one destructive control in the rail. */
const SIGNOUT_GLYPH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M15 17l5-5-5-5"/><path d="M20 12H9"/><path d="M12 19H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6"/>
</svg>`;

/**
 * Who is signed in, at the foot of the rail.
 *
 * Takes either a bare email string (the Cloudflare Access header, which is all
 * there was) or `{ email, name, signOut, impersonator }` for a portal account.
 * Both shapes, rather than a migration, because both are live at once for the
 * length of the 'shadow' rollout — see src/auth/config.js.
 *
 * The Access header remains DISPLAY ONLY and must never gate anything: the
 * router is a convenience layer for as long as Access is the thing enforcing,
 * and a header that decided what you can see would quietly contradict that.
 * A portal session is different — it is verified server-side before this markup
 * is ever produced — but the rail still only renders it, and everything goes
 * through esc() regardless.
 */
function viewerFoot(viewer) {
  if (!viewer) return '';
  const { email, signOut = false, impersonator = null } =
    typeof viewer === 'string' ? { email: viewer } : viewer;
  if (!email) return '';

  const initial = email.trim().charAt(0).toUpperCase() || '?';

  // Sign-out is a POST, so it is a <form> rather than a link. A GET sign-out
  // fires from any <img> on any page and gets triggered speculatively by link
  // prefetchers; being signed out by a page you merely looked at is a real bug.
  // With SameSite=Lax on the session cookie, POST-only is also the CSRF defence.
  const signOutControl = signOut
    ? `<form class="elv-rail-signout" method="POST" action="/auth/logout">
      <button type="submit" title="Sign out" aria-label="Sign out">
        ${SIGNOUT_GLYPH}
      </button>
    </form>`
    : '';

  // An admin browsing as someone else must never look identical to that person
  // being signed in. Loud on purpose.
  const banner = impersonator
    ? `<span class="elv-rail-impersonating" title="Impersonated by ${esc(impersonator)}">Viewing as</span>`
    : '';

  return `<div class="elv-rail-foot">
    <span class="elv-rail-avatar" aria-hidden="true">${esc(initial)}</span>
    <span class="elv-rail-viewer">
      <span class="elv-rail-viewer-label">${banner || 'Signed in'}</span>
      <span class="elv-rail-viewer-email" title="${esc(email)}">${esc(email)}</span>
    </span>
    ${signOutControl}
  </div>`;
}

/**
 * How each registry status appears as a chip.
 *
 * The status VALUE and the chip's wording are separate on purpose: `coming_soon`
 * is what the router matches on, "Soon" is what fits in a 272px rail. Rendering
 * the raw status is what shipped first, and `COMING_SOON` was both unstyled and
 * wide enough to truncate the label beside it.
 */
const STATUS_CHIP = {
  shell: { label: 'Shell', variant: 'shell' },
  coming_soon: { label: 'Soon', variant: 'soon' },
  beta: { label: 'Beta', variant: 'beta' },
};

/** A status chip, or nothing at all when the thing is simply live. */
function chip(status) {
  if (!status || status === 'live') return '';
  // An unrecognised status still renders, in the neutral variant: a typo in the
  // registry should look wrong, not vanish.
  const { label, variant } = STATUS_CHIP[status] ?? { label: status, variant: 'shell' };
  return `<span class="elv-chip elv-chip-${esc(variant)}">${esc(label)}</span>`;
}

/**
 * The rail's contents for a given path. Returns the inner markup of <nav>, not
 * the element itself — the page owns the landmark, the registry owns what goes
 * in it.
 *
 * Collapsed, the tiles alone identify each destination, which is why they use
 * the same initials and accent as that module's launcher card: the rail and the
 * grid name things the same way.
 *
 * The quick-switch button ships `hidden` and is revealed by
 * portal.js: it does nothing without JavaScript, and a control that does nothing
 * is worse than no control. Everything else in the rail works either way.
 */
export function renderRail(pathname, viewer = null) {
  const links = entries()
    .map(([prefix, entry]) => {
      const current = isCurrent(prefix, pathname);
      const marker =
        prefix === '/'
          ? `<span class="elv-rail-tile elv-rail-tile-home">${HOME_GLYPH}</span>`
          : `<span class="elv-rail-tile elv-icon-${esc(entry.accent)}">${esc(entry.initials)}</span>`;
      const external = entry.external ? EXTERNAL_ATTRS : '';
      return `<li>
        <a class="elv-rail-link" href="${esc(hrefFor(prefix))}"${current ? ' aria-current="page"' : ''}${external}>
          ${marker}
          <span class="elv-rail-label">${esc(entry.label)}${entry.external ? EXTERNAL_MARK : ''}</span>
          ${chip(entry.status)}
        </a>
      </li>`;
    })
    .join('\n      ');

  return `<a class="elv-rail-brand" href="/">
    ${LOGO}
    <span class="elv-rail-brand-text">
      <span class="elv-rail-brand-name">Elevrics</span>
      <span class="elv-rail-brand-tag">Portal</span>
    </span>
  </a>
  <button type="button" class="elv-rail-pin" data-rail-pin aria-pressed="false" aria-label="Keep sidebar open">
    ${PIN_GLYPH}
  </button>
  <button type="button" class="elv-rail-search" data-rail-search hidden aria-haspopup="dialog">
    <span class="elv-rail-tile elv-rail-tile-search">${SEARCH_GLYPH}</span>
    <span class="elv-rail-label">Search</span>
    <kbd class="elv-rail-kbd" data-rail-kbd></kbd>
  </button>
  <ul class="elv-rail-links">
      ${links}
  </ul>
  ${viewerFoot(viewer)}`;
}

/**
 * The launcher's card grid. Returns the inner markup of the grid container.
 * Only entries that declare a `group` get a card — Home doesn't link to itself.
 */
export function renderCards(group = 'Modules') {
  return entries()
    .filter(([, entry]) => entry.group === group)
    .map(([prefix, entry]) => {
      const meta = `${metaPathFor(prefix)} · ${entry.stack}`;
      const external = entry.external ? EXTERNAL_ATTRS : '';
      return `<a class="card${entry.external ? ' card-external' : ''}" href="${esc(hrefFor(prefix))}"${external}>
        <div class="card-head">
          <div class="card-icon elv-icon-${esc(entry.accent)}">${esc(entry.initials)}</div>
          ${chip(entry.status)}
        </div>
        <h2>${esc(entry.label)}${entry.external ? EXTERNAL_MARK : ''}</h2>
        <p>${esc(entry.blurb)}</p>
        <div class="card-meta">${esc(meta)}</div>
      </a>`;
    })
    .join('\n      ');
}

/**
 * A branded page for a module that is listed but not built.
 *
 * The point of this is that the hub reads as complete on day one: a department
 * can be announced the day it is decided rather than the day it ships, and the
 * "Soon" chip in the rail then leads somewhere that looks deliberate instead of
 * to a 404. It carries the same placeholders as the portal's own pages, so the
 * injector fills it by the ordinary path — a coming-soon page is not a special
 * kind of page, just an empty one.
 */
export function renderComingSoon(prefix, entry) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(entry.label)} · Elevrics Portal</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/chrome.css">
<link rel="stylesheet" href="/css/portal.css">
</head>
<body>

<nav class="elv-rail" aria-label="Portal" data-portal-nav></nav>

<header class="hero">
  <div class="hero-inner">
    <p class="hero-eyebrow">Elevrics Internal</p>
    <div class="hero-rule"></div>
    <h1>${esc(entry.label)} <span class="elv-chip elv-chip-soon">Soon</span></h1>
    <p class="hero-sub">${esc(entry.blurb)}</p>
  </div>
</header>

<main>
  <section class="section">
    <p class="section-label">Status</p>
    <div class="empty">
      <h2>This module is on the way</h2>
      <p>It will appear at <code>${esc(prefix)}</code> with the same chrome as
         the rest of the portal, behind the same sign-in. Nothing is deployed
         here yet.</p>
    </div>
  </section>
</main>

<footer>Elevrics internal · not indexed · sign-in required</footer>

</body>
</html>`;
}

export { MODULES };
