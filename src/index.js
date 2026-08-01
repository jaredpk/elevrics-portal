import { handleRequest } from './router.js';

/**
 * Worker entrypoint for portal.elevrics.ai.
 *
 * Static assets in public/ are served by the assets binding before this Worker
 * is invoked, so in practice this only runs for module routes (/solayard,
 * /opportunities, /pathfinder) and genuine misses. Misses are handed back to
 * ASSETS so the 404 comes from the same place as the rest of the shell.
 */
export default {
  async fetch(request, env) {
    return handleRequest(request, (req) => env.ASSETS.fetch(req));
  },
};
