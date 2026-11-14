import { randomUUID } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pipeline } from 'node:stream/promises';
import type { GatewayConfig, RouteConfig } from './config/types.js';
import { GatewayError, PayloadTooLargeError } from './errors.js';
import { buildRouteMiddleware } from './features/index.js';
import { silentLogger, type Logger } from './logger.js';
import { compose, type GatewayResponse, type Handler, type RequestContext } from './pipeline.js';
import { UpstreamClient } from './proxy/client.js';
import { createUpstreamHandler } from './proxy/upstream.js';
import { Router } from './router.js';

/** Request bodies are buffered (for retries and transforms); cap them to protect memory. */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;
const SHUTDOWN_GRACE_MS = 10_000;

export interface GatewayOptions {
  logger?: Logger;
  /** Overrides config.gateway.port (tests use 0 for a random free port). */
  port?: number;
  host?: string;
  /** Clock for time-based features (rate limits, circuit breakers). Defaults to Date.now. */
  now?: () => number;
}

export interface RunningGateway {
  port: number;
  url: string;
  close(): Promise<void>;
}

interface CompiledRoute {
  path: string;
  config: RouteConfig;
  handler: Handler;
}

export async function startGateway(config: GatewayConfig, options: GatewayOptions = {}): Promise<RunningGateway> {
  const logger = options.logger ?? silentLogger;
  const client = new UpstreamClient();
  const startedAt = Date.now();

  // Every route's pipeline is built once, at startup, from its config.
  const router = new Router<CompiledRoute>(
    config.routes.map((route) => ({
      path: route.path,
      config: route,
      handler: compose(
        buildRouteMiddleware(route, { logger, now: options.now ?? Date.now }),
        createUpstreamHandler(route, client),
      ),
    })),
  );

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err: unknown) => {
      logger.error('unhandled error while handling request', { error: String(err) });
      res.destroy();
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now();
    const method = (req.method ?? 'GET').toUpperCase();
    const { path, query } = splitUrl(req.url ?? '/');
    const requestId = singleHeader(req.headers['x-request-id']) ?? randomUUID();
    let routePath: string | undefined;

    res.setHeader('x-request-id', requestId);
    res.on('finish', () => {
      logger.info('request', {
        request_id: requestId,
        method,
        path,
        route: routePath ?? null,
        status: res.statusCode,
        duration_ms: Math.round(performance.now() - started),
      });
    });

    // Built in, takes precedence over any configured route.
    if (path === '/health') {
      if (method !== 'GET' && method !== 'HEAD') {
        return sendError(res, new GatewayError(405, 'method_not_allowed', `${method} is not allowed on /health`, { allow: 'GET, HEAD' }));
      }
      return sendJson(res, 200, { status: 'healthy', uptime_seconds: Math.floor((Date.now() - startedAt) / 1000) });
    }

    const route = router.match(path);
    if (!route) {
      return sendError(res, new GatewayError(404, 'not_found', `no route matches ${path}`));
    }
    routePath = route.path;

    if (!route.config.methods.includes(method)) {
      return sendError(
        res,
        new GatewayError(405, 'method_not_allowed', `${method} is not allowed on ${route.path}`, {
          allow: route.config.methods.join(', '),
        }),
      );
    }

    // Cancel upstream work if the client disconnects before we've responded.
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });

    let response: GatewayResponse;
    try {
      const body = await readBody(req, MAX_BODY_BYTES);
      const ctx: RequestContext = {
        route: route.config,
        request: {
          method,
          path,
          query,
          headers: req.headers,
          body,
          clientIp: req.socket.remoteAddress ?? 'unknown',
        },
        requestId,
        receivedAt: new Date(),
        signal: abort.signal,
      };
      response = await route.handler(ctx);
    } catch (err) {
      if (abort.signal.aborted) return; // client is gone; nothing to send
      if (err instanceof GatewayError) {
        logger.warn('request failed', { request_id: requestId, route: route.path, status: err.status, error: err.message });
        return sendError(res, err);
      }
      logger.error('unexpected error in pipeline', { request_id: requestId, route: route.path, error: String(err) });
      return sendError(res, new GatewayError(500, 'internal_error', 'internal gateway error'));
    }

    await sendResponse(res, response, requestId, logger);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? config.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const { port } = server.address() as AddressInfo;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    async close() {
      // Stop accepting connections, let in-flight requests finish, then force-close stragglers.
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      const force = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS);
      await closed;
      clearTimeout(force);
      client.close();
    },
  };
}

function splitUrl(rawUrl: string): { path: string; query: string } {
  const q = rawUrl.indexOf('?');
  return q === -1 ? { path: rawUrl, query: '' } : { path: rawUrl.slice(0, q), query: rawUrl.slice(q) };
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function readBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limitBytes) throw new PayloadTooLargeError(limitBytes);

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) throw new PayloadTooLargeError(limitBytes);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function sendResponse(res: ServerResponse, response: GatewayResponse, requestId: string, logger: Logger): Promise<void> {
  const { status, headers, body } = response;
  if (Buffer.isBuffer(body)) {
    res.writeHead(status, { ...headers, 'content-length': body.length });
    res.end(body);
    return;
  }
  res.writeHead(status, headers);
  try {
    await pipeline(body, res);
  } catch (err) {
    // Headers are already sent, so the only honest signal left is a broken connection.
    logger.warn('response stream failed', { request_id: requestId, error: String(err) });
    res.destroy();
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown, headers: http.OutgoingHttpHeaders = {}): void {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { ...headers, 'content-type': 'application/json', 'content-length': body.length });
  res.end(body);
}

function sendError(res: ServerResponse, err: GatewayError): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  sendJson(res, err.status, err.toBody(), err.headers);
}
