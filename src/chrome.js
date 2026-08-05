/**
 * Chrome injection — the Workers-only half of the nav story.
 *
 * `run_worker_first` means this Worker runs on every request, including ones the
 * assets binding ultimately answers. That makes it the one place that sees every
 * page — the portal's own AND the proxied modules' — which is why the rail is
 * rendered here rather than pasted into each HTML file or added to three
 * separate module repos in three different languages.
 *
 * HTMLRewriter is a Workers runtime global with no Node equivalent, so it is
 * passed IN rather than imported — the same dependency-injection shape
 * `handleRequest` already uses for the asset fallback. The router works without
 * an injector (the local harness and the unit tests pass none); it just doesn't
 * decorate. The markup itself is tested directly against `nav.js`, where no
 * runtime is involved at all.
 *
 * TWO MODES, because the two kinds of page offer different footholds:
 *
 *   'placeholder' — the portal's own pages carry `data-portal-nav` and
 *                   `data-portal-cards` elements for this to fill.
 *   'standalone'  — a proxied module has neither, so the rail is appended to
 *                   <body> and the stylesheet link to <head>. Appended, not
 *                   prepended: it is the least invasive place to put a node in
 *                   someone else's document, and chrome.css keeps the rail
 *                   position-fixed at every breakpoint precisely so its DOM
 *                   position never matters.
 */

import { renderRail, renderCards, renderComingSoon } from './nav.js';

/**
 * Restores the pinned rail before first paint.
 *
 * This has to be inline and in <head>: an external script would still let the
 * page paint at the collapsed width first and jump. (The concept has this flash
 * by construction — React can't read localStorage until after hydration, so its
 * rail starts unpinned every load. Static HTML can just do it right.)
 */
const BOOT = `<script>try{if(localStorage.getItem('elv:rail-pinned')==='1')` +
  `document.documentElement.classList.add('elv-rail-pinned')}catch(e){}</script>`;

/** The pin toggle's click handling — no paint dependency, so it can defer. */
const BEHAVIOUR = `<script src="/js/portal.js" defer></script>`;

/** Same origin as the portal, so a proxied page can load it by absolute path. */
const CHROME_CSS = `<link rel="stylesheet" href="/css/chrome.css">`;

/** Does this response carry markup we can rewrite? */
function isHtml(response) {
  return (response.headers.get('Content-Type') ?? '').includes('text/html');
}

/**
 * Build an injector over a runtime's HTMLRewriter.
 *
 * @param HTMLRewriterCtor  the runtime's HTMLRewriter constructor
 * @returns (response, context) => Response — non-HTML passes through untouched.
 *   context: { pathname, mode, viewer } — an object rather than positional
 *   arguments because `viewer` is the third thing the rail needs to know and a
 *   three-argument call site stops reading as anything in particular.
 */
export function makeChromeInjector(HTMLRewriterCtor) {
  return function injectChrome(response, { pathname, mode = 'placeholder', viewer = null } = {}) {
    if (!isHtml(response)) return response;

    const standalone = mode === 'standalone';

    let rewriter = new HTMLRewriterCtor()
      // Marks the page as decorated. Set server-side rather than from script so
      // the body inset that clears the fixed rail applies even without JS.
      .on('html', {
        element(el) {
          const existing = el.getAttribute('class');
          el.setAttribute('class', existing ? `${existing} elv-chrome` : 'elv-chrome');
        },
      })
      .on('head', {
        element(el) {
          if (standalone) el.append(CHROME_CSS, { html: true });
          el.append(BOOT, { html: true });
          el.append(BEHAVIOUR, { html: true });
        },
      });

    if (standalone) {
      rewriter = rewriter.on('body', {
        element(el) {
          el.append(
            `<nav class="elv-rail" aria-label="Portal">${renderRail(pathname, viewer)}</nav>`,
            { html: true },
          );
        },
      });
    } else {
      rewriter = rewriter
        .on('[data-portal-nav]', {
          element(el) {
            el.setInnerContent(renderRail(pathname, viewer), { html: true });
          },
        })
        .on('[data-portal-cards]', {
          element(el) {
            el.setInnerContent(renderCards(), { html: true });
          },
        });
    }

    return rewriter.transform(response);
  };
}

/**
 * Is this a top-level page load, rather than a fetch for a fragment?
 *
 * A proxied Flask or Express app may answer XHR with `text/html` partials, and
 * injecting a whole navigation rail into a fragment that's about to be spliced
 * into a table would be a mess. `Sec-Fetch-Dest: document` distinguishes them.
 * Where the header is absent entirely (older browsers, curl) we fall back to
 * the Accept header, since an XHR overwhelmingly sends `*​/*` rather than
 * asking for HTML — and if neither says so, we decline to inject. Failing
 * closed costs a rail; failing open corrupts a page.
 */
export function isDocumentRequest(request) {
  const dest = request.headers.get('Sec-Fetch-Dest');
  if (dest) return dest === 'document';
  return (request.headers.get('Accept') ?? '').includes('text/html');
}
