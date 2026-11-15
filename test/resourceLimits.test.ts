import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/load.js';
import { startGateway, type GatewayOptions, type RunningGateway } from '../src/server.js';

/**
 * Limits that stop slow or numerous clients and upstreams from tying up the
 * gateway: idle upstream bodies, the gateway-wide body budget, the request
 * timeout and the connection cap. Each test uses small limits via options.
 */

let upstream: http.Server;
let upstreamUrl: string;
const gateways: RunningGateway[] = [];

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    if (req.url === '/stall') {
      res.writeHead(200, { 'content-length': '100' });
      res.write('x'); // then nothing: the body stalls
      return;
    }
    if (req.url === '/trickle') {
      // Slow but steady: a chunk every 100ms, 6 chunks. Never idle for the full timeout.
      res.writeHead(200);
      let sent = 0;
      const timer = setInterval(() => {
        res.write('y');
        if (++sent === 6) {
          clearInterval(timer);
          res.end();
        }
      }, 100);
      return;
    }
    req.resume();
    req.on('end', () => res.end('ok'));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await Promise.all(gateways.map((g) => g.close()));
  upstream?.closeAllConnections();
  await new Promise<void>((resolve) => upstream?.close(() => resolve()));
});

async function gatewayWith(options: GatewayOptions = {}): Promise<RunningGateway> {
  const { config } = parseConfig(
    `routes: [{ path: "/", methods: ["GET", "POST"], upstream: { url: "${upstreamUrl}", timeout: "300ms" } }]`,
  );
  const gateway = await startGateway(config, { port: 0, ...options });
  gateways.push(gateway);
  return gateway;
}

describe('a stalled upstream body', () => {
  it('is cut after the route timeout of silence, instead of holding the client forever', async () => {
    const gateway = await gatewayWith();
    const started = Date.now();
    const outcome = await new Promise<string>((resolve) => {
      http.get(`${gateway.url}/stall`, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve('completed'));
        res.on('close', () => resolve('cut'));
      });
    });
    expect(outcome).toBe('cut');
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('a slow but steady body is not cut', async () => {
    const gateway = await gatewayWith();
    const res = await fetch(`${gateway.url}/trickle`); // 600ms in total, but never 300ms idle
    expect(await res.text()).toBe('yyyyyy');
  });
});

describe('the gateway-wide budget for buffered request bodies', () => {
  it('answers 503 with Retry-After when an upload would exceed it', async () => {
    const gateway = await gatewayWith({ maxBufferedBodyBytes: 1_000 });
    const res = await fetch(`${gateway.url}/upload`, { method: 'POST', body: Buffer.alloc(2_000) });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(await res.json()).toMatchObject({ error: 'server_busy' });
  });

  it('frees a request\'s share once it is done, so later uploads fit', async () => {
    const gateway = await gatewayWith({ maxBufferedBodyBytes: 1_000 });
    for (let i = 0; i < 5; i += 1) {
      expect((await fetch(`${gateway.url}/upload`, { method: 'POST', body: Buffer.alloc(800) })).status).toBe(200);
    }
  });
});

describe('the request timeout', () => {
  it('cuts off a client that sends its body too slowly, with a JSON 408', async () => {
    const gateway = await gatewayWith({ requestTimeoutMs: 300 });
    const reply = await new Promise<string>((resolve) => {
      const socket = net.connect(gateway.port, '127.0.0.1', () => {
        socket.write('POST /upload HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\npartial'); // and nothing more
      });
      let data = '';
      socket.on('data', (chunk) => (data += chunk));
      socket.on('close', () => resolve(data));
    });
    expect(reply).toMatch(/^HTTP\/1\.1 408/);
    expect(reply).toContain('"error":"request_timeout"');
  });
});

describe('the connection cap', () => {
  it('drops connections beyond the cap', async () => {
    const gateway = await gatewayWith({ maxConnections: 1 });
    const holder = net.connect(gateway.port, '127.0.0.1'); // takes the only slot
    await new Promise((resolve) => holder.once('connect', resolve));
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      await expect(fetch(`${gateway.url}/x`, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
    } finally {
      holder.destroy();
    }
  });
});
