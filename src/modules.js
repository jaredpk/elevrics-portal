/**
 * The portal registry — routing and information architecture in one object.
 *
 * This is the single source of truth for what the portal contains. The router
 * proxies from it, the nav renders from it, and the launcher's card grid renders
 * from it. Adding a module is an entry here; it is never new plumbing, and it is
 * never a second copy of the nav pasted into another page.
 *
 * Two kinds of entry, distinguished by ONE field:
 *
 *   - has `origin`  → a proxied module. The router forwards to it.
 *   - no `origin`   → a portal-owned page served from public/ by the assets
 *                     binding. It still appears in the nav; it just isn't
 *                     something the router forwards anywhere.
 *
 * `matchModule()` keys off exactly that, so a portal-owned page can never be
 * mistaken for a proxy target — see the guard there.
 *
 * Key = the routing prefix, and also the path shown in a card's meta line.
 * `href` overrides the link target when the two differ (/admin vs /admin/).
 *
 * `status` drives the chip in the rail and on the card. Only a non-`live`
 * status renders one — chipping everything is noise, and the point of the chip
 * is that something is NOT yet what it looks like.
 */

export const MODULES = {
  '/': {
    label: 'Home',
    // Nav only — the launcher IS this page, so it doesn't get a card on itself.
  },

  '/solayard': {
    origin: 'https://solayard-intel.fly.dev',
    // Flask registers its 9 routes at root. Strip the prefix inbound; the app
    // emits portal-space URLs itself via its URL_PREFIX env var.
    stripPrefix: true,
    label: 'SolaYard Intel',
    initials: 'SI',
    accent: 'purple',
    group: 'Modules',
    status: 'live',
    stack: 'Flask · SQLite',
    blurb:
      'External deadlines and signals the SolaYard roadmap depends on — ' +
      'funding cycles, plug-in solar legislation, UL 3700 milestones.',
  },

  '/opportunities': {
    origin: 'https://elevrics-opportunities.fly.dev',
    // Express router + static assets, same arrangement as above.
    stripPrefix: true,
    label: 'Opportunities',
    initials: 'OP',
    accent: 'blue',
    group: 'Modules',
    status: 'live',
    stack: 'Express · SQLite',
    blurb:
      'Lead-intelligence scanner and review queue. Scores public sources ' +
      'against the Tier 1 offers with an explainable rules engine.',
  },

  '/pathfinder': {
    origin: 'https://elevrics-relocation.fly.dev',
    // Next.js basePath means the app expects to see /pathfinder in the path
    // and generates its own prefixed asset URLs. Pass the path through whole.
    stripPrefix: false,
    label: 'Pathfinder',
    initials: 'PF',
    accent: 'teal',
    group: 'Modules',
    status: 'live',
    stack: 'Next.js · static dataset',
    blurb:
      'Relocation screen — 103 locations across 40 factors, with weighting, ' +
      'must-have thresholds and per-row confidence bands.',
  },

  '/admin': {
    // No origin: static markup in public/admin/, served by the assets binding.
    href: '/admin/',
    label: 'Admin',
    initials: 'AD',
    accent: 'gray',
    group: 'Modules',
    // Not 'live': the console is inert markup. The chip says so everywhere it
    // appears, rather than only in the prose on the page itself.
    status: 'shell',
    stack: 'shell',
    blurb:
      'Cross-tenant console for the client portal. Shell only — there are ' +
      'no tenants provisioned yet.',
  },
};

/** Where an entry links to. Defaults to its routing prefix. */
export function hrefFor(prefix) {
  return MODULES[prefix].href ?? prefix;
}

/** Registry entries in nav order, as [prefix, entry] pairs. */
export function entries() {
  return Object.entries(MODULES);
}

/**
 * Is this entry the page currently being viewed?
 *
 * "/" matches only itself — every path starts with it. Everything else matches
 * its own subtree, so /solayard/reference still marks SolaYard Intel current.
 */
export function isCurrent(prefix, pathname) {
  if (prefix === '/') return pathname === '/';
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}
