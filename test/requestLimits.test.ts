import http from 'node:http';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_HEADER_BYTES, type RunningGateway } from '../src/server.js';
import { startMockUpstream, type MockUpstream } from '../mock/upstream.js';
import { startTestGateway } from './helpers.js';

/**
 * Limits on the request line and headers (where the query string lives), and
 * requests so malformed that Node rejects them before routing. Body size limits
 * (413) are in gateway.test.ts.
 */

let upstream: MockUpstream;
let gateway: RunningGateway;

beforeAll(async () => {
  upstream = await startMockUpstream('svc');
  gateway = await startTestGateway(`
routes:
  - path: "/api"
    methods: ["GET"]
    upstream: { url: "${upstream.url}" }
`);
});

afterAll(async () => {
  await gateway?.close();
  await upstream?.close();
});

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

function get(path: string, headers: http.OutgoingHttpHeaders = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: gateway.port, path, headers }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : {} }));
      })
      .on('error', reject);
  });
}

/** Writes raw bytes to the gateway and parses whatever comes back, for requests no HTTP client would send. */
function rawExchange(request: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(gateway.port, '127.0.0.1', () => socket.write(request));
    let data = '';
    socket.on('data', (chunk) => (data += chunk));
    socket.on('end', () => {
      const [head = '', body = ''] = data.split('\r\n\r\n');
      resolve({ status: Number(head.split(' ')[1]), body: body ? JSON.parse(body) : {} });
    });
    socket.on('error', reject);
  });
}

const upstreamHits = () => upstream.requests.length;

describe('request line and header size', () => {
  it('forwards a long query string that is within the limit, unchanged', async () => {
    const value = 'a'.repeat(MAX_HEADER_BYTES - 2_000);
    const res = await get(`/api/search?q=${value}`);
    expect(res.status).toBe(200);
    expect((res.body.query as Record<string, string>).q).toBe(value);
  });

  it('rejects a query string over the limit with a JSON 431, without calling the upstream', async () => {
    const before = upstreamHits();
    const res = await get(`/api/search?q=${'a'.repeat(MAX_HEADER_BYTES + 1)}`);
    expect(res.status).toBe(431);
    expect(res.body).toEqual({
      error: 'request_header_too_large',
      message: `request line and headers exceed ${MAX_HEADER_BYTES} bytes`,
    });
    expect(upstreamHits()).toBe(before);
  });

  it('rejects a single oversized header with 431', async () => {
    const res = await get('/api/x', { 'x-big': 'b'.repeat(MAX_HEADER_BYTES + 1) });
    expect(res.status).toBe(431);
  });

  it('rejects many headers that are too large together with 431', async () => {
    const headers: http.OutgoingHttpHeaders = {};
    for (let i = 0; i < 40; i += 1) headers[`x-h${i}`] = 'c'.repeat(500); // ~20 KB in total
    expect((await get('/api/x', headers)).status).toBe(431);
  });

  it('keeps serving normal requests afterwards', async () => {
    expect((await get('/api/after')).status).toBe(200);
  });
});

describe('malformed requests', () => {
  it('answers bytes that are not HTTP with a JSON 400', async () => {
    const res = await rawExchange('THIS IS NOT HTTP\r\n\r\n');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'bad_request', message: 'malformed HTTP request' });
  });

  it('answers a broken header line with a JSON 400', async () => {
    const res = await rawExchange('GET /api/x HTTP/1.1\r\nHost: localhost\r\nno colon here\r\n\r\n');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'bad_request' });
  });

  it('never forwards a malformed request, and keeps serving', async () => {
    const before = upstreamHits();
    await rawExchange('GET /api/x HTTP/1.1\r\nHost: localhost\r\nContent-Length: abc\r\n\r\n');
    expect(upstreamHits()).toBe(before);
    expect((await get('/api/after')).status).toBe(200);
  });
});
