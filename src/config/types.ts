/**
 * Normalized, validated gateway configuration.
 *
 * The YAML file is parsed and validated once at startup (see ./load.ts) into
 * these types. Everything downstream works with this shape, never raw YAML:
 * durations are milliseconds, defaults are already applied, and per-route
 * settings that fall back to gateway-wide values (timeout, rate limit) are
 * already resolved.
 */

export type RateLimitStrategy = 'fixed_window' | 'sliding_window';
export type RateLimitKey = 'ip' | 'global';
export type BalanceStrategy = 'round_robin' | 'weighted_round_robin';
export type BackoffStrategy = 'fixed' | 'exponential';

export interface RateLimitConfig {
  requests: number;
  windowMs: number;
  strategy: RateLimitStrategy;
  per: RateLimitKey;
}

export interface UpstreamTarget {
  url: URL;
  weight: number;
}

export interface UpstreamConfig {
  /** Always at least one. A single `url:` in YAML becomes one target with weight 1. */
  targets: UpstreamTarget[];
  balance: BalanceStrategy;
  /** Route `upstream.timeout`, or `gateway.global_timeout` when not set. */
  timeoutMs: number;
}

export interface RetryConfig {
  /** Total attempts, including the first request. */
  attempts: number;
  backoff: BackoffStrategy;
  initialDelayMs: number;
  onStatus: number[];
}

export interface HealthCheckConfig {
  path: string;
  intervalMs: number;
  unhealthyThreshold: number;
}

export interface HeaderTransform {
  add: Record<string, string>;
  remove: string[];
}

export interface RequestTransformConfig {
  headers?: HeaderTransform;
  /** destination dot-path -> source dot-path or `$` expression */
  bodyMapping?: Record<string, string>;
}

export interface ResponseTransformConfig {
  headers?: HeaderTransform;
  /** Envelope template; `$` expressions inside are resolved per response. */
  bodyEnvelope?: Record<string, unknown>;
}

export interface ApiKeyAuthConfig {
  type: 'api_key';
  header: string;
  keys: string[];
}

export interface CircuitBreakerConfig {
  threshold: number;
  windowMs: number;
  cooldownMs: number;
}

export interface RouteConfig {
  /** Normalized path prefix: leading slash, no trailing slash (except "/"). */
  path: string;
  /** Upper-cased HTTP methods. */
  methods: string[];
  stripPrefix: boolean;
  upstream: UpstreamConfig;
  /** Route `rate_limit`, or `gateway.global_rate_limit`, or null when neither is set. */
  rateLimit: RateLimitConfig | null;
  retry?: RetryConfig;
  healthCheck?: HealthCheckConfig;
  requestTransform?: RequestTransformConfig;
  responseTransform?: ResponseTransformConfig;
  auth?: ApiKeyAuthConfig;
  circuitBreaker?: CircuitBreakerConfig;
}

export interface GatewayConfig {
  port: number;
  /**
   * Load balancers / proxies in front of the gateway (IPs or CIDR ranges). Only
   * requests from these keep their X-Forwarded-* headers. Empty by default: the
   * gateway is the edge. An optional extension to the spec's schema.
   */
  trustedProxies: string[];
  globalTimeoutMs: number;
  globalRateLimit: RateLimitConfig | null;
  routes: RouteConfig[];
}
