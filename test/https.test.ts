import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestGateway } from './helpers.js';

/**
 * HTTPS upstreams. The test upstream uses a self-signed certificate from
 * test/fixtures/tls (for localhost and 127.0.0.1; test-only, never used for
 * anything real). The gateway must refuse it by default, and accept it once
 * it's trusted, the way an operator would: NODE_EXTRA_CA_CERTS.
 */

const CERT = resolve('test/fixtures/tls/cert.pem');
let upstream: https.Server;
let upstreamUrl: string;
let dir: string;
const children: ChildProcess[] = [];

beforeAll(async () => {
  upstream = https.createServer(
    { key: await readFile('test/fixtures/tls/key.pem'), cert: await readFile(CERT) },
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ secure: true, path: req.url }));
    },
  );
  await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
  upstreamUrl = `https://localhost:${(upstream.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), 'gatewaykit-https-'));
});

afterAll(async () => {
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  upstream?.closeAllConnections();
  await new Promise<void>((done) => upstream?.close(() => done()));
  await rm(dir, { recursive: true, force: true });
});

describe('HTTPS upstreams', () => {
  it('rejects an upstream whose certificate is not trusted, with a 502', async () => {
    const gateway = await startTestGateway(`routes: [{ path: "/s", methods: ["GET"], upstream: { url: "${upstreamUrl}" } }]`);
    try {
      const res = await fetch(`${gateway.url}/s/x`);
      expect(res.status).toBe(502);
      expect(((await res.json()) as { message: string }).message).toMatch(/certificate/i);
    } finally {
      await gateway.close();
    }
  });

  it('proxies to an HTTPS upstream once its certificate is trusted', async () => {
    const config = join(dir, 'https.yaml');
    await writeFile(
      config,
      `gateway: { port: 0 }\nroutes: [{ path: "/s", methods: ["GET"], strip_prefix: true, upstream: { url: "${upstreamUrl}" } }]`,
    );
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', config], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: CERT },
      stdio: 'pipe',
    });
    children.push(child);

    const port = await new Promise<number>((done, fail) => {
      let out = '';
      child.stdout?.on('data', (chunk) => {
        out += chunk;
        const line = out.split('\n').find((l) => l.includes('"gateway listening"'));
        if (line) done((JSON.parse(line) as { port: number }).port);
      });
      child.on('exit', (code) => fail(new Error(`gateway exited with ${code}`)));
    });

    const res = await fetch(`http://127.0.0.1:${port}/s/items?id=1`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ secure: true, path: '/items?id=1' });
    child.kill('SIGTERM');
  });
});
