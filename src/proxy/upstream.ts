import type { RouteConfig } from '../config/types.js';
import type { Handler } from '../pipeline.js';
import type { UpstreamClient } from './client.js';

/**
 * The terminal handler of every route's pipeline: pick a target and forward.
 * For now this always uses the first target; load balancing will replace the
 * target selection here without touching the rest of the pipeline.
 */
export function createUpstreamHandler(route: RouteConfig, client: UpstreamClient): Handler {
  const { targets, timeoutMs } = route.upstream;
  const target = targets[0];
  if (!target) throw new Error(`route ${route.path} has no upstream targets`);
  return (ctx) => client.send(ctx, target.url, timeoutMs);
}
