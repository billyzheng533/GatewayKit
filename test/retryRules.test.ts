import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/load.js';
import { CircuitOpenError, UpstreamTimeoutError, UpstreamUnavailableError } from '../src/errors.js';
import { retryFeature } from '../src/features/retry/index.js';
import { silentLogger } from '../src/logger.js';
import type { GatewayResponse, Handler, Middleware, RequestContext } from '../src/pipeline.js';

/**
 * Retry's decision rules, unit-tested against a fake upstream: which methods,
 * statuses and failures get retried, and when retrying must stop.
 */

const { config } = parseConfig(`
routes:
  - path: "/r"
    methods: ["GET", "HEAD", "OPTIONS", "PUT", "DELETE", "POST", "PATCH"]
    upstream: { url: "http://upstream" }
    retry: { attempts: 3, backoff: "fixed", initial_delay: "1ms", on: [502, 503, 504] }
`);
const route = config.routes[0]!;
const retry = retryFeature.create(route, { logger: silentLogger, now: Date.now }) as Middleware;

function contextFor(method: string, controller = new AbortController()): RequestContext {
  return {
    route,
    request: {
      method,
      path: '/r',
      query: '',
      headers: {},
      headersDistinct: {},
      readBody: async () => Buffer.alloc(0),
      clientIp: '127.0.0.1',
      forwarded: { for: '127.0.0.1', proto: 'http' },
    },
    requestId: 'test',
    receivedAt: new Date(),
    signal: controller.signal,
  };
}

const respond = (status: number): GatewayResponse => ({ status, headers: {}, body: Buffer.from('') });

/** A fake upstream that plays back `outcomes` in order: a status to answer with, or an error to throw. */
function fakeUpstream(outcomes: Array<number | Error>) {
  let calls = 0;
  const next: Handler = async () => {
    const outcome = outcomes[Math.min(calls, outcomes.length - 1)]!;
    calls += 1;
    if (outcome instanceof Error) throw outcome;
    return respond(outcome);
  };
  return { next, calls: () => calls };
}

const refused = () => new UpstreamUnavailableError('http://upstream', new Error('refused'), 'ECONNREFUSED');
const reset = () => new UpstreamUnavailableError('http://upstream', new Error('reset'), 'ECONNRESET');
const timedOut = () => new UpstreamTimeoutError('http://upstream', 100);

describe('which methods are retried after the upstream answered with a retryable status', () => {
  it.each(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'])('%s (idempotent): retried', async (method) => {
    const upstream = fakeUpstream([503, 503, 200]);
    expect((await retry(contextFor(method), upstream.next)).status).toBe(200);
    expect(upstream.calls()).toBe(3);
  });

  it.each(['POST', 'PATCH'])('%s (not idempotent): not retried, the upstream may have acted on it', async (method) => {
    const upstream = fakeUpstream([503, 200]);
    expect((await retry(contextFor(method), upstream.next)).status).toBe(503);
    expect(upstream.calls()).toBe(1);
  });
});

describe('which failures are retried', () => {
  it('a connection that was refused, for any method: the request never arrived', async () => {
    for (const method of ['GET', 'POST', 'PATCH']) {
      const upstream = fakeUpstream([refused(), 200]);
      expect((await retry(contextFor(method), upstream.next)).status).toBe(200);
      expect(upstream.calls()).toBe(2);
    }
  });

  it('a reset connection: retried for GET, but not for POST, which may have arrived', async () => {
    const getUpstream = fakeUpstream([reset(), 200]);
    expect((await retry(contextFor('GET'), getUpstream.next)).status).toBe(200);

    const postUpstream = fakeUpstream([reset(), 200]);
    await expect(retry(contextFor('POST'), postUpstream.next)).rejects.toBeInstanceOf(UpstreamUnavailableError);
    expect(postUpstream.calls()).toBe(1);
  });

  it('a timeout: retried for GET, but not for POST, which may have been processed', async () => {
    const getUpstream = fakeUpstream([timedOut(), 200]);
    expect((await retry(contextFor('GET'), getUpstream.next)).status).toBe(200);

    const postUpstream = fakeUpstream([timedOut(), 200]);
    await expect(retry(contextFor('POST'), postUpstream.next)).rejects.toBeInstanceOf(UpstreamTimeoutError);
    expect(postUpstream.calls()).toBe(1);
  });

  it('a status not listed in `on` is returned as is', async () => {
    const upstream = fakeUpstream([500, 200]);
    expect((await retry(contextFor('GET'), upstream.next)).status).toBe(500);
    expect(upstream.calls()).toBe(1);
  });

  it('a gateway decision (an open circuit breaker) is never retried', async () => {
    const upstream = fakeUpstream([new CircuitOpenError(10), 200]);
    await expect(retry(contextFor('GET'), upstream.next)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(upstream.calls()).toBe(1);
  });
});

describe('when retrying stops', () => {
  it('after `attempts` tries, returning the last response', async () => {
    const upstream = fakeUpstream([503, 502, 504, 200]);
    expect((await retry(contextFor('GET'), upstream.next)).status).toBe(504);
    expect(upstream.calls()).toBe(3);
  });

  it('after `attempts` tries, throwing the last error', async () => {
    const upstream = fakeUpstream([refused()]);
    await expect(retry(contextFor('GET'), upstream.next)).rejects.toBeInstanceOf(UpstreamUnavailableError);
    expect(upstream.calls()).toBe(3);
  });

  it('as soon as the client has disconnected', async () => {
    const controller = new AbortController();
    let calls = 0;
    const next: Handler = async () => {
      calls += 1;
      controller.abort(new Error('client gone'));
      return respond(503);
    };
    await expect(retry(contextFor('GET', controller), next)).rejects.toThrow('client gone');
    expect(calls).toBe(1);
  });

  it('discards the body of a response it is about to retry', async () => {
    const discarded = Readable.from(['unused body']);
    const responses: GatewayResponse[] = [{ status: 503, headers: {}, body: discarded }, respond(200)];
    let i = 0;
    await retry(contextFor('GET'), async () => responses[i++]!);
    expect(discarded.readableFlowing).toBe(true); // resumed, so its connection can be reused
  });
});
