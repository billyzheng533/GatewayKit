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

  const server = http.createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (req, res) => {
    handleRequest(req, res).catch((err: unknown) => {
      logger.error('unhandled error while handling request', { error: String(err) });
      res.destroy();
    });
  });

  // Requests Node rejects while parsing (too-large headers, malformed HTTP) never
  // reach handleRequest. Answer them in the same JSON error format as everything else.
  server.on('clientError', (err: NodeJS.ErrnoException, socket) => {
    if (err.code === 'ECONNRESET' || !socket.writable) {
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
    const requestId = singleHeader(req.headers['x-request-id']) ?? randomUUID();
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

/** How long to keep draining an oversized body before giving up on the connection. */
const DISCARD_BODY_MS = 5_000;

function readBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
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
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onClose = () => {
      cleanup();
      if (!req.complete) reject(new Error('client disconnected while sending the request body'));
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
