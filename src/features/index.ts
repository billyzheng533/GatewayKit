import type { GatewayConfig, RouteConfig } from '../config/types.js';
import type { Logger } from '../logger.js';
import type { Middleware } from '../pipeline.js';
import { authFeature } from './auth/index.js';
import { circuitBreakerFeature } from './circuitBreaker/index.js';
import { rateLimitFeature } from './rateLimit/index.js';
import { retryFeature } from './retry/index.js';

/**
 * Feature registry: the extension point for config features.
 *
 * A feature looks at one route's config at startup and either returns a
 * middleware for that route or null if the route doesn't use it. Per-route
 * state (rate-limit counters, circuit-breaker state, ...) lives in the
 * middleware's closure, so routes never share state by accident.
 *
 * Adding a config feature = parse it in config/load.ts, write a module that
 * exports a Feature, and add it to FEATURES below.
 *
 * Order matters: FEATURES run outermost first. Cheap rejections (auth, rate
 * limiting) should come before anything that does upstream work.
 */
export interface FeatureDeps {
  logger: Logger;
  /** Current time in ms. Injected so time-based features can be tested without real waiting. */
  now: () => number;
}

export interface Feature {
  name: string;
  create(route: RouteConfig, deps: FeatureDeps): Middleware | null;
}

/**
 * Pipeline order, outermost first:
 *   rate_limit       reject over-limit clients before doing any work. It runs
 *                    before auth on purpose: failed key guesses use up the
 *                    budget, so keys can't be brute-forced at full speed
 *   auth             reject requests without a valid key before any upstream work
 *   retry            wraps the breaker, so each attempt is counted separately
 *                    and retrying stops once the breaker opens
 *   circuit_breaker  innermost, closest to the upstream call
 */
export const FEATURES: readonly Feature[] = [rateLimitFeature, authFeature, retryFeature, circuitBreakerFeature];

export function buildRouteMiddleware(route: RouteConfig, deps: FeatureDeps): Middleware[] {
  return FEATURES.map((feature) => feature.create(route, deps)).filter((mw): mw is Middleware => mw !== null);
}

/**
 * Config keys that are parsed and validated but not enforced yet. Logged at
 * startup so nobody assumes, say, auth is on when it isn't.
 */
const NOT_YET_ENFORCED: Array<[keyof RouteConfig, string]> = [
  ['healthCheck', 'health_check'],
  ['requestTransform', 'request_transform'],
  ['responseTransform', 'response_transform'],
];

export function unenforcedFeatureWarnings(config: GatewayConfig): string[] {
  const warnings: string[] = [];
  for (const route of config.routes) {
    for (const [key, label] of NOT_YET_ENFORCED) {
      if (route[key] !== undefined && route[key] !== null) {
        warnings.push(`route ${route.path}: "${label}" is configured but not implemented yet; it is ignored`);
      }
    }
  }
  return warnings;
}
