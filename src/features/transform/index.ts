import type { OutgoingHttpHeaders } from 'node:http';
import type { HeaderTransform } from '../../config/types.js';
import { GatewayError } from '../../errors.js';
import type { RequestContext } from '../../pipeline.js';
import type { Feature } from '../index.js';

/**
 * Applies the header parts of `request_transform` and `response_transform`:
 *
 *   request_transform.headers   removed from / added to the request before it's forwarded
 *   response_transform.headers  removed from / added to the upstream's response
 *
 * `remove` runs before `add`, names are case-insensitive, and `add` replaces any
 * existing value. Removing is what keeps clients from sending internal headers
 * (X-Internal, X-Debug) to a backend that trusts them, and keeps backend details
 * (Server, X-Powered-By) out of responses.
 *
 * Values can use (checked at startup, see config/load.ts):
 *   $request_time    when the gateway received the request (ISO 8601)
 *   $response_time   when the response is sent on (ISO 8601; responses only)
 *   $route_path      the matched route's path
 *   $literal:<text>  <text>, for a value that would otherwise start with "$"
 *
 * The body parts (request `mapping`, response `envelope`) are not implemented;
 * the gateway warns about them at startup.
 */
export const transformFeature: Feature = {
  name: 'transform',
  create(route) {
    const requestHeaders = route.requestTransform?.headers;
    const responseHeaders = route.responseTransform?.headers;
    if (!requestHeaders && !responseHeaders) return null;

    return async (ctx, next) => {
      let forwarded = ctx;
      if (requestHeaders) {
        const headers = applyHeaderTransform({ ...ctx.request.headers }, requestHeaders, ctx);
        forwarded = { ...ctx, request: { ...ctx.request, headers } };
      }
      if (!responseHeaders) return next(forwarded);

      try {
        const response = await next(forwarded);
        return { ...response, headers: applyHeaderTransform({ ...response.headers }, responseHeaders, ctx) };
      } catch (err) {
        // Gateway errors (502, 504, ...) become responses later; they get the same treatment.
        if (err instanceof GatewayError) applyHeaderTransform(err.headers as OutgoingHttpHeaders, responseHeaders, ctx);
        throw err;
      }
    };
  },
};

/** Removes, then adds, on a header object whose names are lower-case. Mutates and returns it. */
export function applyHeaderTransform<T extends Record<string, unknown>>(
  headers: T,
  transform: HeaderTransform,
  ctx: Pick<RequestContext, 'receivedAt' | 'route'>,
  now: () => Date = () => new Date(),
): T {
  for (const name of transform.remove) delete headers[name.toLowerCase()];
  for (const [name, template] of Object.entries(transform.add)) {
    (headers as Record<string, unknown>)[name.toLowerCase()] = resolveValue(template, ctx, now);
  }
  return headers;
}

export const HEADER_VARIABLES = ['$request_time', '$response_time', '$route_path'] as const;

export function resolveValue(
  template: string,
  ctx: Pick<RequestContext, 'receivedAt' | 'route'>,
  now: () => Date = () => new Date(),
): string {
  if (template.startsWith('$literal:')) return template.slice('$literal:'.length);
  switch (template) {
    case '$request_time':
      return ctx.receivedAt.toISOString();
    case '$response_time':
      return now().toISOString();
    case '$route_path':
      return ctx.route.path;
    default:
      return template;
  }
}
