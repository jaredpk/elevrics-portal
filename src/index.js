import { handleRequest } from './router.js';
import { makeChromeInjector } from './chrome.js';

/**
 * Worker entrypoint for portal.elevrics.ai.
 *
 * `assets.run_worker_first` is set, so this Worker runs on EVERY request — not
 * just module routes. That is what makes the parked-host guard reachable, and
 * it is also what lets the nav be rendered from the registry here instead of
 * hand-copied into each static page.
 *
 * HTMLRewriter is a runtime global with no Node equivalent, so the injector is
 * built here and handed to the router. The router and the local harness both
 * work without it.
 */
const injectChrome = makeChromeInjector(HTMLRewriter);

export default {
  async fetch(request, env) {
    return handleRequest(request, (req) => env.ASSETS.fetch(req), injectChrome);
  },
};
