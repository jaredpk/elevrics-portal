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

/** A status chip, or nothing at all when the thing is simply live. */
function chip(status) {
  if (!status || status === 'live') return '';
  const label = { shell: 'Shell', soon: 'Soon', beta: 'Beta' }[status] ?? status;
  return `<span class="elv-chip elv-chip-${esc(status)}">${esc(label)}</span>`;
}

/**
 * The rail's contents for a given path. Returns the inner markup of <nav>, not
 * the element itself — the page owns the landmark, the registry owns what goes
 * in it.
 *
 * Collapsed, the tiles alone identify each destination, which is why they use
 * the same initials and accent as that module's launcher card: the rail and the
 * grid name things the same way.
 */
export function renderRail(pathname) {
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
  <ul class="elv-rail-links">
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

export { MODULES };
