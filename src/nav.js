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

import { MODULES, entries, hrefFor, isCurrent } from './modules.js';

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
const LOGO = `<svg width="24" height="20" viewBox="0 0 24 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="elv-n1" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#9B5CF6"/><stop offset="100%" stop-color="#7B2CBF"/></linearGradient>
    <linearGradient id="elv-n2" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#6D8EF8"/><stop offset="100%" stop-color="#3C6FF0"/></linearGradient>
    <linearGradient id="elv-n3" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#2EC4BD"/><stop offset="100%" stop-color="#00A19A"/></linearGradient>
  </defs>
  <rect x="0" y="11" width="6" height="9" rx="2" fill="url(#elv-n1)"/>
  <rect x="9" y="5.5" width="6" height="14.5" rx="2" fill="url(#elv-n2)"/>
  <rect x="18" y="0" width="6" height="20" rx="2" fill="url(#elv-n3)"/>
</svg>`;

/**
 * The nav bar's contents for a given path. Returns the inner markup of <nav>,
 * not the element itself — the page owns the landmark, the registry owns what
 * goes in it.
 */
export function renderNav(pathname) {
  const links = entries()
    .map(([prefix, entry]) => {
      const current = isCurrent(prefix, pathname) ? ' aria-current="page"' : '';
      return `<li><a href="${esc(hrefFor(prefix))}"${current}>${esc(entry.label)}</a></li>`;
    })
    .join('\n    ');

  return `<a href="/" class="nav-logo">
    ${LOGO}
    <span class="nav-logo-text">Elevrics</span>
    <span class="nav-tag">Portal</span>
  </a>
  <ul class="nav-links">
    ${links}
  </ul>`;
}

/**
 * The launcher's card grid. Returns the inner markup of the grid container.
 * Only entries that declare a `group` get a card — Home doesn't link to itself.
 */
export function renderCards(group = 'Modules') {
  return entries()
    .filter(([, entry]) => entry.group === group)
    .map(([prefix, entry]) => {
      const meta = `${prefix} · ${entry.stack}`;
      return `<a class="card" href="${esc(hrefFor(prefix))}">
        <div class="card-icon icon-${esc(entry.accent)}">${esc(entry.initials)}</div>
        <h2>${esc(entry.label)}</h2>
        <p>${esc(entry.blurb)}</p>
        <div class="card-meta">${esc(meta)}</div>
      </a>`;
    })
    .join('\n      ');
}

export { MODULES };
