import http from 'node:http';
import https from 'node:https';
import { UpstreamTimeoutError, UpstreamUnavailableError } from '../errors.js';
import type { GatewayResponse, RequestContext } from '../pipeline.js';
import { upstreamPath } from '../router.js';
import { upstreamRequestHeaders, withoutHopByHop } from './headers.js';

/**
 * Sends one request to one upstream target, using Node's built-in HTTP client.
 *
 * Connections are pooled with keep-alive agents shared by all routes. The
 * response body is returned as a stream, so large responses are not buffered.
 */
export class UpstreamClient {
  private readonly httpAgent = new http.Agent({ keepAlive: true, maxSockets: 256 });
  private readonly httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 256 });

  /**
   * Resolves once the upstream sends response headers. Rejects with:
   *   - UpstreamTimeoutError if headers don't arrive within `timeoutMs`
   *   - UpstreamUnavailableError on connection errors (refused, reset, DNS, ...)
   * The timeout covers time-to-headers only; once streaming starts, the body
   * is relayed until the upstream finishes or the client disconnects.
   */
  async send(ctx: RequestContext, target: URL, timeoutMs: number): Promise<GatewayResponse> {
    const { request } = ctx;
    // Read (or reuse, on retry) the body only now, after every rejecting middleware has run.
    const body = await request.readBody();
    const isHttps = target.protocol === 'https:';
    const path = joinTargetPath(target, upstreamPath(ctx.route, request.path)) + request.query;
    const targetLabel = target.origin;

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      };

      const upstreamReq = (isHttps ? https : http).request(
        {
          protocol: target.protocol,
          hostname: target.hostname.replace(/^\[|\]$/g, ''), // strip IPv6 brackets
          port: target.port || (isHttps ? 443 : 80),
          method: request.method,
          path,
          headers: upstreamRequestHeaders(request.headers, {
            clientIp: request.clientIp,
            requestId: ctx.requestId,
            upstreamHost: target.host,
            bodyLength: body.length,
          }),
          agent: isHttps ? this.httpsAgent : this.httpAgent,
          signal: ctx.signal,
        },
        (upstreamRes) => {
          if (settled) {
            upstreamRes.resume();
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve({
            status: upstreamRes.statusCode ?? 502,
            headers: withoutHopByHop(upstreamRes.headers),
            body: upstreamRes,
          });
        },
      );

      const timer = setTimeout(() => {
        fail(new UpstreamTimeoutError(targetLabel, timeoutMs));
        upstreamReq.destroy();
      }, timeoutMs);

      upstreamReq.on('error', (err) => {
        const { error, code } = describeConnectError(err);
        fail(new UpstreamUnavailableError(targetLabel, error, code));
      });
      upstreamReq.end(body);
    });
  }

  close(): void {
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }
}

/**
 * Connecting to a name like "localhost" tries IPv6 and IPv4; when both fail,
 * Node reports an AggregateError whose message is empty. Surface the error
 * code (e.g. ECONNREFUSED) so logs and 502 bodies say what actually happened.
 */
/** A target's own base path plus `path`: `http://svc/v2` + `/items` is `/v2/items`. */
export function joinTargetPath(target: URL, path: string): string {
  return target.pathname.replace(/\/+$/, '') + path;
}

export function describeConnectError(err: Error): { error: Error; code?: string } {
  const inner = err instanceof AggregateError && err.errors[0] instanceof Error ? err.errors[0] : err;
  const code = (err as NodeJS.ErrnoException).code ?? (inner as NodeJS.ErrnoException).code;
  const message = err.message || inner.message;
  if (code && message) {
    return { error: new Error(message.includes(code) ? message : `${code}: ${message}`, { cause: err }), code };
  }
  return { error: new Error(code ?? message ?? 'connection failed', { cause: err }), code };
}
