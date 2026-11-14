import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A small mock upstream service used by the tests and for running the gateway locally.
 *
 * Endpoints (any method, at any path prefix):
 *   GET  /healthz          200 {"status":"ok"}  (or 503 while `setHealthy(false)`)
 *   ANY  /status/<code>    responds with that status code
 *   ANY  /slow?ms=<n>      waits n milliseconds, then echoes
 *   ANY  /flaky?fail=<n>&key=<k>   fails with 503 for the first n calls with that key
 *                          (default key "default"), then echoes
 *   ANY  /reset            destroys the connection without responding
 *   ANY  /truncate         sends headers and part of the body, then destroys the connection
 *   ANY  /garbage          answers with bytes that aren't HTTP
 *   ANY  anything else     echoes the request back as JSON
 *
 * Every response carries `Server` and `X-Powered-By` headers (so header removal
 * can be tested) and `X-Upstream: <name>` (so tests can see which target answered).
 */

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  /** Set when the caller (the gateway) closed the connection before the response finished. */
  callerDisconnected: boolean;
}

export interface MockUpstream {
  name: string;
  port: number;
  url: string;
  /** Every request received, in order. */
  requests: RecordedRequest[];
  setHealthy(healthy: boolean): void;
  close(): Promise<void>;
}

export async function startMockUpstream(name: string, port = 0): Promise<MockUpstream> {
  const requests: RecordedRequest[] = [];
  let healthy = true;
  const flakyCalls = new Map<string, number>();

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const recorded: RecordedRequest = {
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers: req.headers,
      body,
      callerDisconnected: false,
    };
    requests.push(recorded);
    res.on('close', () => {
      if (!res.writableFinished) recorded.callerDisconnected = true;
    });

    const url = new URL(recorded.url, 'http://mock.local');
    const segments = url.pathname.split('/').filter(Boolean);
    const last = segments.at(-1) ?? '';
    const parent = segments.at(-2) ?? '';

    res.setHeader('server', `mock-upstream/${name}`);
    res.setHeader('x-powered-by', 'mock');
    res.setHeader('x-upstream', name);

    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const echo = () =>
      json(200, {
        upstream: name,
        method: recorded.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: recorded.headers,
        body: parseBody(body),
      });

    if (last === 'healthz') return healthy ? json(200, { status: 'ok' }) : json(503, { status: 'unhealthy' });
    if (parent === 'status' && /^\d{3}$/.test(last)) return json(Number(last), { upstream: name, status: Number(last) });
    if (last === 'slow') {
      const ms = Number(url.searchParams.get('ms') ?? 1000);
      await new Promise((resolve) => setTimeout(resolve, ms));
      if (!res.destroyed) echo();
      return;
    }
    if (last === 'reset') {
      req.socket.destroy();
      return;
    }
    if (last === 'truncate') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '1000' });
      res.write('only part of the body');
      setTimeout(() => req.socket.destroy(), 20);
      return;
    }
    if (last === 'garbage') {
      req.socket.end('this is not an HTTP response\r\n\r\n');
      return;
    }
    if (last === 'flaky') {
      const key = url.searchParams.get('key') ?? 'default';
      const call = (flakyCalls.get(key) ?? 0) + 1;
      flakyCalls.set(key, call);
      const failures = Number(url.searchParams.get('fail') ?? 1);
      if (call <= failures) return json(503, { upstream: name, error: 'flaky', call });
      return echo();
    }
    return echo();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // No host: listen dual-stack, so both "localhost" (may resolve to ::1) and 127.0.0.1 work.
    server.listen(port, () => resolve());
  });
  const actualPort = (server.address() as AddressInfo).port;

  return {
    name,
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    requests,
    setHealthy(value) {
      healthy = value;
    },
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function parseBody(body: string): unknown {
  if (body === '') return null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}
