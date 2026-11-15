import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config/load.js';
import { FEATURES, buildRouteMiddleware } from '../src/features/index.js';
import { createJsonLogger, silentLogger } from '../src/logger.js';
import { compose, type GatewayResponse, type Handler, type Middleware, type RequestContext } from '../src/pipeline.js';

const ok: GatewayResponse = { status: 200, headers: {}, body: Buffer.from('') };
const ctx = {} as RequestContext;

describe('compose', () => {
  it('runs middleware outermost first, then the terminal handler, and unwinds in reverse', async () => {
    const order: string[] = [];
    const named =
      (name: string): Middleware =>
      async (c, next) => {
        order.push(`${name} in`);
        const response = await next(c);
        order.push(`${name} out`);
        return response;
      };
    const terminal: Handler = async () => {
      order.push('upstream');
      return ok;
    };
    await compose([named('a'), named('b')], terminal)(ctx);
    expect(order).toEqual(['a in', 'b in', 'upstream', 'b out', 'a out']);
  });

  it('lets a middleware answer without calling the rest', async () => {
    const terminal = vi.fn(async () => ok);
    const reject: Middleware = async () => ({ status: 401, headers: {}, body: Buffer.from('') });
    expect((await compose([reject], terminal)(ctx)).status).toBe(401);
    expect(terminal).not.toHaveBeenCalled();
  });

  it('with no middleware, is just the terminal handler', async () => {
    expect((await compose([], async () => ok)(ctx)).status).toBe(200);
  });
});

describe('the feature pipeline', () => {
  it('runs features in this order: rate limit, auth, transform, retry, circuit breaker', () => {
    expect(FEATURES.map((f) => f.name)).toEqual(['rate_limit', 'auth', 'transform', 'retry', 'circuit_breaker']);
  });

  it('only includes the features a route configures', () => {
    const { config } = parseConfig(`
routes:
  - { path: "/bare", methods: [GET], upstream: { url: "http://x" } }
  - path: "/full"
    methods: [GET]
    upstream: { url: "http://x" }
    rate_limit: { requests: 1, window: "1s" }
    auth: { type: "api_key", keys: ["k"] }
    retry: { attempts: 2 }
    circuit_breaker: { threshold: 1, window: "1s", cooldown: "1s" }
`);
    const deps = { logger: silentLogger, now: Date.now };
    expect(buildRouteMiddleware(config.routes[0]!, deps)).toHaveLength(0);
    expect(buildRouteMiddleware(config.routes[1]!, deps)).toHaveLength(4); // no transform configured
  });
});

describe('createJsonLogger', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes one JSON line per message: info to stdout, warn and error to stderr', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const logger = createJsonLogger();

    logger.info('started', { port: 8080 });
    logger.warn('careful');
    logger.error('broken', { code: 'X' });

    const lines = (spy: typeof out) => spy.mock.calls.map(([chunk]) => JSON.parse(String(chunk)));
    expect(lines(out)).toEqual([{ time: expect.any(String), level: 'info', message: 'started', port: 8080 }]);
    expect(lines(err)).toEqual([
      { time: expect.any(String), level: 'warn', message: 'careful' },
      { time: expect.any(String), level: 'error', message: 'broken', code: 'X' },
    ]);
    expect(String(out.mock.calls[0]?.[0])).toMatch(/\n$/);
    expect(new Date(lines(out)[0].time).toISOString()).toBe(lines(out)[0].time);
  });

  it('silentLogger writes nothing', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    silentLogger.info('x');
    silentLogger.warn('x');
    silentLogger.error('x');
    expect(out).not.toHaveBeenCalled();
  });
});
