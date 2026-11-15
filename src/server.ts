import { randomUUID } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pipeline } from 'node:stream/promises';
import type { GatewayConfig, RouteConfig } from './config/types.js';
import { ClientClosedError, GatewayError, PayloadTooLargeError, ServerBusyError } from './errors.js';
import { buildRouteMiddleware } from './features/index.js';
import { silentLogger, type Logger } from './logger.js';
import { compose, type GatewayResponse, type Handler, type RequestContext } from './pipeline.js';
import { UpstreamClient } from './proxy/client.js';
import { HealthChecker } from './proxy/healthCheck.js';
import { createUpstreamHandler } from './proxy/upstream.js';
import { resolveClient, trustedProxyList } from './clientIdentity.js';
import { normalizePath } from './path.js';
import { Router } from './router.js';

/** Request bodies are buffered (for retries and transforms); cap them to protect memory. */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;
/**
 * Request line + headers (which is where the query string lives). Set
 * explicitly rather than relying on Node's default, so the limit can't change
 * underneath us. AWS API Gateway's HTTP APIs allow 10,240 bytes; 16 KB is a
 * little more generous for long query strings.
 */
export const MAX_HEADER_BYTES = 16 * 1024;
const SHUTDOWN_GRACE_MS = 10_000;

/** Request bodies held in memory at once, across all requests. Past it, uploads get 503. */
export const MAX_BUFFERED_BODY_BYTES = 256 * 1024 * 1024;
/** Time to receive a whole request, body included (Node's default is 5 minutes), and its headers. */
const REQUEST_TIMEOUT_MS = 60_000;
const HEADERS_TIMEOUT_MS = 20_000;
/** Open client connections; further ones are dropped until some close. */
const MAX_CONNECTIONS = 10_000;

export interface GatewayOptions {
  logger?: Logger;
  /** Overrides MAX_BUFFERED_BODY_BYTES (tests use a small budget). */
  maxBufferedBodyBytes?: number;
  /** Overrides REQUEST_TIMEOUT_MS (tests use a short one). */
  requestTimeoutMs?: number;
  /** Overrides MAX_CONNECTIONS. */
  maxConnections?: number;
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
  const trustedProxies = trustedProxyList(config.trustedProxies);

  // Routes with `health_check` get a checker; the load balancer skips targets it marks unhealthy.
  const healthCheckers: HealthChecker[] = [];
  const healthFilter = (route: RouteConfig) => {
    if (!route.healthCheck) return undefined;
    const checkTimeoutMs = Math.min(route.upstream.timeoutMs, route.healthCheck.intervalMs);
    const checker = new HealthChecker(route.path, route.upstream.targets, route.healthCheck, checkTimeoutMs, logger);
    healthCheckers.push(checker);
    return checker.isHealthy;
  };

  // Every route's pipeline is built once, at startup, from its config.
  const router = new Router<CompiledRoute>(
    config.routes.map((route) => ({
      path: route.path,
      config: route,
      handler: compose(
        buildRouteMiddleware(route, { logger, now: options.now ?? Date.now }),
        createUpstreamHandler(route, client, healthFilter(route)),
      ),
    })),
  );

  const bodyBudget = new ByteBudget(options.maxBufferedBodyBytes ?? MAX_BUFFERED_BODY_BYTES);
  const requestTimeout = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const server = http.createServer(
    {
      maxHeaderSize: MAX_HEADER_BYTES,
      requestTimeout,
      headersTimeout: Math.min(HEADERS_TIMEOUT_MS, requestTimeout),
      // How often Node checks those timeouts (default 30s, too coarse for a 60s limit).
      connectionsCheckingInterval: Math.max(100, Math.min(2_000, requestTimeout / 4)),
    },
    (req, res) => {
    handleRequest(req, res).catch((err: unknown) => {
      logger.error('unhandled error while handling request', { error: String(err) });
      res.destroy();
    });
    },
  );
  server.maxConnections = options.maxConnections ?? MAX_CONNECTIONS;

  // Requests Node rejects while parsing (too-large headers, malformed HTTP) never
  // reach handleRequest. Answer them in the same JSON error format as everything else.
  server.on('clientError', (err: NodeJS.ErrnoException, socket) => {
    // A client that hangs up (even mid-upload) isn't sending malformed HTTP: just close quietly.
    if ((err.code !== undefined && CLIENT_GONE_CODES.has(err.code)) || !socket.writable) {
      socket.destroy();
      return;
    }
    const error =
      err.code === 'HPE_HEADER_OVERFLOW'
        ? new GatewayError(431, 'request_header_too_large', `request line and headers exceed ${MAX_HEADER_BYTES} bytes`)
        : err.code === 'HPE_REQUEST_TIMEOUT' || err.code === 'ERR_HTTP_REQUEST_TIMEOUT'
          ? new GatewayError(408, 'request_timeout', 'request was not received in time')
          : new GatewayError(400, 'bad_request', 'malformed HTTP request');
    logger.warn('rejected malformed request', { status: error.status, reason: err.code ?? err.message });
    const body = JSON.stringify(error.toBody());
    socket.end(
      `HTTP/1.1 ${error.status} ${http.STATUS_CODES[error.status]}\r\n` +
        'Content-Type: application/json\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        'Connection: close\r\n\r\n' +
        body,
    );
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now();
    const method = (req.method ?? 'GET').toUpperCase();
    const { path: rawPath, query } = splitUrl(req.url ?? '/');
    const requestId = acceptableRequestId(singleHeader(req.headers['x-request-id'])) ?? randomUUID();
    let routePath: string | undefined;

    res.setHeader('x-request-id', requestId);
    res.on('finish', () => {
      logger.info('request', {
        request_id: requestId,
        method,
        path: rawPath, // as the client sent it, so odd or malicious paths show up in logs
        route: routePath ?? null,
        status: res.statusCode,
        duration_ms: Math.round(performance.now() - started),
      });
    });

    // Resolve "..", "%2e%2e" etc. first, so routing and forwarding see the same path.
    let path: string;
    try {
      path = normalizePath(rawPath);
    } catch (err) {
      return sendError(res, err as GatewayError);
    }

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
    // Bytes of this request's body counted against the gateway-wide budget, released when it's done.
    let reservedBytes = 0;
    const reserve = (bytes: number) => {
      if (!bodyBudget.tryReserve(bytes)) return false;
      reservedBytes += bytes;
      return true;
    };
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
      bodyBudget.release(reservedBytes);
    });

    let response: GatewayResponse;
    try {
      let bodyRead: Promise<Buffer> | undefined;
      const client = resolveClient(req.socket.remoteAddress, req.headers, trustedProxies);
      const ctx: RequestContext = {
        route: route.config,
        request: {
          method,
          path,
          query,
          headers: req.headers,
          headersDistinct: req.headersDistinct,
          // Lazy and memoized: read on first call (by the upstream handler), reused on retries.
          readBody: () => (bodyRead ??= readBody(req, MAX_BODY_BYTES, reserve)),
          clientIp: client.clientIp,
          forwarded: {
            for: client.forwardedFor,
            proto: client.forwardedProto,
            ...(client.forwardedHost ? { host: client.forwardedHost } : {}),
          },
        },
        requestId,
        receivedAt: new Date(),
        signal: abort.signal,
      };
      response = await route.handler(ctx);
    } catch (err) {
      if (abort.signal.aborted || err instanceof ClientClosedError) return; // client is gone; nothing to send
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

  // Health checks start only once the gateway is actually serving.
  for (const checker of healthCheckers) checker.start();

  const { port } = server.address() as AddressInfo;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    async close() {
      for (const checker of healthCheckers) checker.stop();
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

/** Parser errors that mean the client went away, not that it sent bad HTTP. */
const CLIENT_GONE_CODES = new Set(['ECONNRESET', 'EPIPE', 'HPE_INVALID_EOF_STATE']);

/**
 * A client-supplied X-Request-Id is kept only if it looks like an ID: short and
 * made of safe characters. Anything else (very long, odd characters) is
 * replaced with a fresh UUID, so a client can't bloat logs or forge entries.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
function acceptableRequestId(value: string | undefined): string | undefined {
  return value !== undefined && SAFE_REQUEST_ID.test(value) ? value : undefined;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** How long to keep draining an oversized body before giving up on the connection. */
const DISCARD_BODY_MS = 5_000;

/** Bytes held in memory across all requests, with a hard limit. */
class ByteBudget {
  private used = 0;

  constructor(private readonly limit: number) {}

  tryReserve(bytes: number): boolean {
    if (this.used + bytes > this.limit) return false;
    this.used += bytes;
    return true;
  }

  release(bytes: number): void {
    this.used -= bytes;
  }
}

function readBody(req: IncomingMessage, limitBytes: number, reserve: (bytes: number) => boolean): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limitBytes) {
      discardBody(req);
      reject(new PayloadTooLargeError(limitBytes));
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('close', onClose);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        cleanup();
        discardBody(req);
        reject(new PayloadTooLargeError(limitBytes));
        return;
      }
      if (!reserve(chunk.length)) {
        cleanup();
        discardBody(req);
        reject(new ServerBusyError());
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onClose = () => {
      cleanup();
      if (!req.complete) reject(new ClientClosedError());
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('close', onClose);
  });
}

/**
 * Reads and drops the rest of an oversized body. Stopping mid-upload would
 * reset the connection, and most clients would then report a broken pipe
 * instead of our 413. Draining is bounded in time so a client can't stream forever.
 */
function discardBody(req: IncomingMessage): void {
  const timer = setTimeout(() => req.destroy(), DISCARD_BODY_MS);
  timer.unref();
  req.once('end', () => clearTimeout(timer));
  req.resume();
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
