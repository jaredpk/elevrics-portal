/**
 * Rail behaviour: the pin toggle, and the quick switcher.
 *
 * Both are progressive enhancement. The rail itself — links, current page,
 * identity, layout — is server-rendered and works with this file blocked; what
 * lives here is the part that genuinely needs a runtime.
 *
 * The pinned CLASS is applied before first paint by the inline snippet in
 * <head> (see src/chrome.js), so this file only handles the click and can
 * defer. It syncs aria-pressed on load because the button's markup is static
 * and can't know the stored state.
 */
(function () {
  'use strict';

  var KEY = 'elv:rail-pinned';
  var root = document.documentElement;

  // ---- Pin toggle ----

  function pinned() {
    return root.classList.contains('elv-rail-pinned');
  }

  function syncPin(button) {
    var on = pinned();
    button.setAttribute('aria-pressed', String(on));
    var label = on ? 'Unpin sidebar' : 'Keep sidebar open';
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
  }

  function initPin() {
    var button = document.querySelector('[data-rail-pin]');
    if (!button) return;
    syncPin(button);

    button.addEventListener('click', function () {
      root.classList.toggle('elv-rail-pinned');
      try {
        localStorage.setItem(KEY, pinned() ? '1' : '0');
      } catch (e) {
        // Storage blocked (private mode, cookie policy). The toggle still works
        // for this page view; it just won't be remembered.
      }
      syncPin(button);
    });
  }

  // ---- Quick switcher ----
  //
  // Its list is READ OFF THE RAIL rather than passed in separately. The rail is
  // already rendered from the registry, so reading it back means there is no
  // second copy to drift: whatever the server decided is in the nav — including
  // which entry is current and which leaves the portal — is what this offers.
  //
  // It earns its place inside the proxied modules most of all. Deep in SolaYard
  // there is no launcher grid to go back to, and the collapsed rail is six
  // unlabelled tiles; this is how you get from there to Opportunities without
  // going home first.

  var mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  var overlay = null;
  var input = null;
  var list = null;
  var options = [];
  var active = 0;
  var lastFocus = null;

  function destinations() {
    var links = document.querySelectorAll('.elv-rail-link');
    return Array.prototype.map.call(links, function (a) {
      var label = a.querySelector('.elv-rail-label');
      var tile = a.querySelector('.elv-rail-tile');
      return {
        href: a.getAttribute('href'),
        // textContent, not innerHTML: the label carries the external arrow and
        // its screen-reader text, neither of which belongs in a search string.
        label: label ? label.textContent.replace(/\s+/g, ' ').trim() : a.href,
        tile: tile ? tile.outerHTML : '',
        current: a.getAttribute('aria-current') === 'page',
        target: a.getAttribute('target'),
      };
    });
  }

  function matches(query) {
    var q = query.trim().toLowerCase();
    var all = destinations();
    if (!q) return all;
    return all.filter(function (d) {
      return d.label.toLowerCase().indexOf(q) !== -1 || d.href.toLowerCase().indexOf(q) !== -1;
    });
  }

  function render(query) {
    options = matches(query);
    if (active >= options.length) active = Math.max(0, options.length - 1);

    list.innerHTML = options
      .map(function (d, i) {
        return (
          '<li role="option" id="elv-switch-opt-' + i + '"' +
          ' aria-selected="' + (i === active) + '"' +
          ' class="elv-switch-opt' + (i === active ? ' is-active' : '') + '">' +
          d.tile +
          '<span class="elv-switch-opt-label">' + d.label + '</span>' +
          (d.current ? '<span class="elv-switch-here">Here</span>' : '') +
          '</li>'
        );
      })
      .join('');

    var empty = overlay.querySelector('.elv-switch-empty');
    empty.hidden = options.length > 0;
    input.setAttribute(
      'aria-activedescendant',
      options.length ? 'elv-switch-opt-' + active : ''
    );

    Array.prototype.forEach.call(list.children, function (li, i) {
      li.addEventListener('mouseenter', function () {
        active = i;
        highlight();
      });
      li.addEventListener('click', function () {
        go(i);
      });
    });
  }

  function highlight() {
    Array.prototype.forEach.call(list.children, function (li, i) {
      li.classList.toggle('is-active', i === active);
      li.setAttribute('aria-selected', String(i === active));
    });
    input.setAttribute(
      'aria-activedescendant',
      options.length ? 'elv-switch-opt-' + active : ''
    );
    if (list.children[active]) {
      list.children[active].scrollIntoView({ block: 'nearest' });
    }
  }

  function go(i) {
    var d = options[i];
    if (!d) return;
    close();
    // Honour whatever the rail said about this destination: Finance opens in a
    // new tab there, so it opens in a new tab from here too.
    if (d.target === '_blank') window.open(d.href, '_blank', 'noopener');
    else window.location.href = d.href;
  }

  function build() {
    overlay = document.createElement('div');
    overlay.className = 'elv-switch';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Jump to');
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="elv-switch-panel">' +
      '<input class="elv-switch-input" type="text" autocomplete="off" spellcheck="false"' +
      ' role="combobox" aria-expanded="true" aria-controls="elv-switch-list"' +
      ' aria-autocomplete="list" aria-label="Jump to" placeholder="Jump to…">' +
      '<ul class="elv-switch-list" id="elv-switch-list" role="listbox" aria-label="Destinations"></ul>' +
      '<p class="elv-switch-empty" hidden>No matching destination.</p>' +
      '</div>';
    document.body.appendChild(overlay);

    input = overlay.querySelector('.elv-switch-input');
    list = overlay.querySelector('.elv-switch-list');

    input.addEventListener('input', function () {
      active = 0;
      render(input.value);
    });

    overlay.addEventListener('mousedown', function (e) {
      if (e.target === overlay) close();
    });

    overlay.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (options.length) { active = (active + 1) % options.length; highlight(); }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (options.length) { active = (active - 1 + options.length) % options.length; highlight(); }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        go(active);
      } else if (e.key === 'Tab') {
        // The input is the only focusable thing in here; keeping Tab inside is
        // the whole focus trap.
        e.preventDefault();
      }
    });
  }

  function open() {
    if (!overlay) build();
    lastFocus = document.activeElement;
    overlay.hidden = false;
    root.classList.add('elv-switch-open');
    input.value = '';
    active = 0;
    render('');
    input.focus();
  }

  function close() {
    if (!overlay || overlay.hidden) return;
    overlay.hidden = true;
    root.classList.remove('elv-switch-open');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  /** Typing in a field means the module wants the keystroke, not us. */
  function editing(el) {
    if (!el) return false;
    var tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
  }

  function initSwitcher() {
    var button = document.querySelector('[data-rail-search]');
    if (!button) return;

    // Only now does the control do anything, so only now is it shown.
    button.hidden = false;
    var kbd = button.querySelector('[data-rail-kbd]');
    if (kbd) kbd.textContent = mac ? '⌘K' : 'Ctrl K';
    button.setAttribute('title', 'Jump to… (' + (mac ? '⌘K' : 'Ctrl+K') + ')');

    button.addEventListener('click', open);

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'k' && e.key !== 'K') return;
      if (!(mac ? e.metaKey : e.ctrlKey)) return;
      // A proxied module could bind this chord too. We can't detect that, but we
      // can at least never steal it mid-typing.
      if (editing(e.target) && !(overlay && !overlay.hidden)) return;
      e.preventDefault();
      if (overlay && !overlay.hidden) close();
      else open();
    });
  }

  function init() {
    initPin();
    initSwitcher();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
