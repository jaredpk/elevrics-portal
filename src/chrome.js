/**
 * Chrome injection — the Workers-only half of the nav story.
 *
 * `run_worker_first` means this Worker runs on every request, including ones the
 * assets binding ultimately answers. That makes it the one place that sees every
 * page, which is why the nav is rendered here rather than pasted into each HTML
 * file: there is no build step to template with, and hand-copying was already
 * drifting at two pages.
 *
 * HTMLRewriter is a Workers runtime global with no Node equivalent, so it is
 * passed IN rather than imported — the same dependency-injection shape
 * `handleRequest` already uses for the asset fallback. The router works without
 * an injector (the local harness and the unit tests pass none); it just doesn't
 * decorate. The markup itself is tested directly against `nav.js`, where no
 * runtime is involved at all.
 *
 * Portal-owned pages carry `data-portal-nav` / `data-portal-cards` placeholders
 * for this to fill. Proxied module pages won't have those, and will need an
 * append-to-body strategy instead — a different target, but the same renderer.
 */

import { renderRail, renderCards } from './nav.js';

/**
 * Restores the pinned rail before first paint.
 *
 * This has to be inline and in <head>: an external script would still let the
 * page paint at the collapsed width first and jump. (The concept has this flash
 * by construction — React can't read localStorage until after hydration, so its
 * rail starts unpinned every load. Static HTML can just do it right.)
 */
const BOOT = `<script>try{if(localStorage.getItem('elv:rail-pinned')==='1')` +
  `document.documentElement.classList.add('rail-pinned')}catch(e){}</script>`;

/** The pin toggle's click handling — no paint dependency, so it can defer. */
const BEHAVIOUR = `<script src="/js/portal.js" defer></script>`;

/** Does this response carry markup we can rewrite? */
function isHtml(response) {
  return (response.headers.get('Content-Type') ?? '').includes('text/html');
}

/**
 * Build an injector over a runtime's HTMLRewriter.
 *
 * @param HTMLRewriterCtor  the runtime's HTMLRewriter constructor
 * @returns (response, pathname) => Response — non-HTML passes through untouched
 */
export function makeChromeInjector(HTMLRewriterCtor) {
  return function injectChrome(response, pathname) {
    if (!isHtml(response)) return response;

    return new HTMLRewriterCtor()
      .on('head', {
        element(el) {
          el.append(BOOT, { html: true });
          el.append(BEHAVIOUR, { html: true });
        },
      })
      .on('[data-portal-nav]', {
        element(el) {
          el.setInnerContent(renderRail(pathname), { html: true });
        },
      })
      .on('[data-portal-cards]', {
        element(el) {
          el.setInnerContent(renderCards(), { html: true });
        },
      })
      .transform(response);
  };
}
