/**
 * Rail pin toggle.
 *
 * The rail auto-collapses to an icon strip and hover-expands over the content.
 * Pinning keeps it open and reflows the page instead, and the choice persists.
 *
 * The pinned CLASS is applied before first paint by the inline snippet in
 * <head> (see src/chrome.js) — this file only handles the click, so it can
 * defer. It syncs aria-pressed on load because the button's markup is static
 * and can't know the stored state.
 */
(function () {
  'use strict';

  var KEY = 'elv:rail-pinned';
  var root = document.documentElement;

  function pinned() {
    return root.classList.contains('rail-pinned');
  }

  function sync(button) {
    var on = pinned();
    button.setAttribute('aria-pressed', String(on));
    var label = on ? 'Unpin sidebar' : 'Keep sidebar open';
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
  }

  function init() {
    var button = document.querySelector('[data-rail-pin]');
    if (!button) return;
    sync(button);

    button.addEventListener('click', function () {
      root.classList.toggle('rail-pinned');
      try {
        localStorage.setItem(KEY, pinned() ? '1' : '0');
      } catch (e) {
        // Storage blocked (private mode, cookie policy). The toggle still works
        // for this page view; it just won't be remembered.
      }
      sync(button);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
