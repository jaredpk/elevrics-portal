/**
 * Integration harness: runs the REAL portal router (src/router.js) in front of
 * the REAL local app origins, so the prefix-strip + rewrite design is exercised
 * end to end rather than unit-tested in isolation.
 *
 * No chrome injector is passed — HTMLRewriter is a Workers global with no Node
 * equivalent. Routing behaves identically without it; only the nav markup is
 * absent, and that is tested directly in tests/nav.test.mjs.
 */
import http from 'node:http';
import { handleRequest } from '../src/router.js';
import { MODULES } from '../src/modules.js';

// Point the module origins at the locally running apps.
MODULES['/solayard'].origin = 'http://127.0.0.1:8077';
MODULES['/opportunities'].origin = 'http://127.0.0.1:8099';
MODULES['/pathfinder'].origin = 'http://127.0.0.1:3999';

const server = http.createServer(async (req, res) => {
  const url = `http://127.0.0.1:8090${req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v);
  }

  const request = new Request(url, { method: req.method, headers });
  // Stands in for env.ASSETS.fetch in the deployed Worker.
  const next = async () => new Response('SHELL', { status: 200, headers: { 'x-served-by': 'shell' } });

  let out;
  try {
    out = await handleRequest(request, next);
  } catch (e) {
    out = new Response(`harness error: ${e.stack}`, { status: 500 });
  }

  res.statusCode = out.status;
  out.headers.forEach((v, k) => {
    if (k.toLowerCase() !== 'content-encoding') res.setHeader(k, v);
  });
  res.end(Buffer.from(await out.arrayBuffer()));
});

server.listen(8090, '127.0.0.1', () => console.log('harness on 8090'));
