import type { RouteConfig } from '../config/types.js';
import { GatewayError } from '../errors.js';
import type { Handler } from '../pipeline.js';
import { createBalancer } from './balancer.js';
import type { UpstreamClient } from './client.js';

/**
 * The terminal handler of every route's pipeline: pick a target and forward.
 *
 * The target is picked per call, so when retry calls this again after a
 * failure, the next attempt goes to the next target in the rotation rather
 * than back to the one that just failed.
 */
export function createUpstreamHandler(route: RouteConfig, client: UpstreamClient): Handler {
  const balancer = createBalancer(route.upstream);
  const { timeoutMs } = route.upstream;

  return (ctx) => {
    const target = balancer.pick();
    if (!target) {
      // Unreachable until something filters targets out (health checks will).
      throw new GatewayError(503, 'no_healthy_upstream', `no healthy upstream target for ${route.path}`);
    }
    return client.send(ctx, target.url, timeoutMs);
  };
}
