import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningGateway } from '../src/server.js';
import { startTestGateway } from './helpers.js';

/**
 * Proxy details the echo mock can't exercise, against a purpose-built upstream:
 * response headers, cookies, redirects, large streamed bodies, HEAD, and what
 * happens to an in-flight request when the gateway shuts down.
 */

const BIG_SIZE = 5 * 1024 * 1024;
const bigBody = Buffer.alloc(BIG_SIZE, 'abcdefghij');
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

const received: Array<{ method: string; url: string }> = [];
let upstream: http.Server;
let upstreamUrl: string;
let gateway: RunningGateway;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    received.push({ method: req.method ?? '', url: req.url ?? '' });
    switch (req.url) {
      case '/hop':
        res.writeHead(200, { connection: 'keep-alive, x-hop-secret', 'x-hop-secret': 'internal', 'x-end-to-end': 'kept' });
        return res.end('ok');
      case '/cookies':
        res.setHeader('set-cookie', ['session=abc; HttpOnly', 'theme=dark']);
        return res.end('ok');
      case '/redirect':
        res.writeHead(302, { location: '/moved-here' });
        return res.end();
      case '/big': {
        // Sent in 64 KB chunks without a Content-Length, so it must be streamed through.
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        let offset = 0;
        const sendMore = () => {
          while (offset < bigBody.length) {
            const chunk = bigBody.subarray(offset, offset + 64 * 1024);
            offset += chunk.length;
            if (!res.write(chunk)) return res.once('drain', sendMore);
          }
          res.end();
        };
        return sendMore();
      }
      case '/head':
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '11' });
        return res.end(req.method === 'HEAD' ? undefined : 'hello world');
      case '/slow':
        setTimeout(() => res.end('finished'), 300);
        return;
      default:
        res.writeHead(404);
        return res.end();
    }
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  gateway = await startTestGateway(`
routes:
  - path: "/"
    methods: ["GET", "HEAD"]
    upstream: { url: "${upstreamUrl}" }
`);
});

afterAll(async () => {
  await gateway?.close();
  upstream?.closeAllConnections();
  await new Promise<void>((resolve) => upstream?.close(() => resolve()));
});

describe('response handling', () => {
  it('drops hop-by-hop response headers, including ones the upstream lists in Connection', async () => {
    const res = await fetch(`${gateway.url}/hop`);
    expect(res.headers.get('x-hop-secret')).toBeNull();
    expect(res.headers.get('x-end-to-end')).toBe('kept');
  });

  it('keeps every Set-Cookie header', async () => {
    const res = await fetch(`${gateway.url}/cookies`);
    expect(res.headers.getSetCookie()).toEqual(['session=abc; HttpOnly', 'theme=dark']);
  });

  it('passes redirects to the client instead of following them', async () => {
    const res = await fetch(`${gateway.url}/redirect`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/moved-here');
    expect(received.some((r) => r.url === '/moved-here')).toBe(false);
  });

  it('streams a 5 MB response through intact', async () => {
    const res = await fetch(`${gateway.url}/big`);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(BIG_SIZE);
    expect(sha256(body)).toBe(sha256(bigBody));
  });

  it('forwards HEAD as HEAD and returns headers without a body', async () => {
    const res = await fetch(`${gateway.url}/head`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('11');
    expect(await res.text()).toBe('');
    expect(received.at(-1)).toEqual({ method: 'HEAD', url: '/head' });
  });
});

describe('graceful shutdown', () => {
  it('lets a request already in flight finish, then stops accepting new ones', async () => {
    const draining = await startTestGateway(`routes: [{ path: "/", methods: ["GET"], upstream: { url: "${upstreamUrl}" } }]`);
    const inFlight = fetch(`${draining.url}/slow`, { headers: { connection: 'close' } });
    await new Promise((resolve) => setTimeout(resolve, 50)); // the upstream is still working on it

    const closed = draining.close();
    const res = await inFlight;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('finished');
    await closed;

    await expect(fetch(`${draining.url}/slow`)).rejects.toThrow();
  });
});
