import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { invalidTrustedProxy } from '../clientIdentity.js';
import { normalizePath } from '../path.js';
import { MAX_TIMER_MS, parseDuration } from './duration.js';
import type {
  ApiKeyAuthConfig,
  CircuitBreakerConfig,
  GatewayConfig,
  HealthCheckConfig,
  HeaderTransform,
  RateLimitConfig,
  RequestTransformConfig,
  ResponseTransformConfig,
  RetryConfig,
  RouteConfig,
  UpstreamConfig,
  UpstreamTarget,
} from './types.js';

export const DEFAULT_PORT = 8080;
export const DEFAULT_TIMEOUT_MS = 30_000;

const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
/** A valid HTTP header name (RFC 9110 "token"). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Thrown when the config can't be read or is invalid. Lists every problem, not just the first. */
export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid gateway config:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

export interface LoadedConfig {
  config: GatewayConfig;
  /** Non-fatal problems, such as unknown keys (often typos). */
  warnings: string[];
}

export async function loadConfigFile(path: string): Promise<LoadedConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new ConfigError([`cannot read config file "${path}": ${(err as Error).message}`]);
  }
  return parseConfig(text);
}

export function parseConfig(yamlText: string): LoadedConfig {
  let raw: unknown;
  try {
    // merge: allow `<<: *anchor`, a common way to share settings between routes.
    raw = parseYaml(yamlText, { merge: true });
  } catch (err) {
    throw new ConfigError([`YAML syntax error: ${(err as Error).message}`]);
  }
  return validateConfig(raw);
}

/**
 * Validates raw parsed YAML and normalizes it into a GatewayConfig.
 *
 * Validators record an issue and return a harmless placeholder instead of
 * throwing, so a single pass reports every problem. If any issue was recorded
 * the placeholders never escape: we throw a ConfigError at the end.
 */
export function validateConfig(raw: unknown): LoadedConfig {
  const v = new Validator();
  const root = v.mapping(raw, 'config');
  // Top-level keys starting with "x-" are allowed silently, as a home for YAML anchors.
  v.knownKeys(root, 'config', ['gateway', 'routes'], { allowPrefix: 'x-' });

  const gateway = root.gateway === undefined ? {} : v.mapping(root.gateway, 'gateway');
  v.knownKeys(gateway, 'gateway', ['port', 'global_timeout', 'global_rate_limit', 'trusted_proxies']);

  const port = gateway.port === undefined ? DEFAULT_PORT : v.integer(gateway.port, 'gateway.port', 0, 65_535);
  if (port === 0 && gateway.port === 0) v.warn('gateway.port: 0 means "any free port"; the actual port is logged at startup');
  const globalTimeoutMs =
    gateway.global_timeout === undefined
      ? DEFAULT_TIMEOUT_MS
      : v.duration(gateway.global_timeout, 'gateway.global_timeout', { timer: true });
  const trustedProxies =
    gateway.trusted_proxies === undefined ? [] : v.stringList(gateway.trusted_proxies, 'gateway.trusted_proxies');
  trustedProxies.forEach((entry, i) => {
    const problem = entry === '' ? undefined : invalidTrustedProxy(entry);
    if (problem) v.error(`gateway.trusted_proxies[${i}]`, problem);
  });
  const globalRateLimit =
    gateway.global_rate_limit === undefined ? null : parseRateLimit(v, gateway.global_rate_limit, 'gateway.global_rate_limit');

  const rawRoutes = root.routes === undefined ? [] : v.list(root.routes, 'routes');
  if (rawRoutes.length === 0) v.warn('routes: no routes configured; every request except /health will return 404');

  const routes = rawRoutes.map((route, i) => parseRoute(v, route, `routes[${i}]`, { globalTimeoutMs, globalRateLimit }));

  // Case-insensitive, like routing: "/API" and "/api" would be the same route.
  const seen = new Map<string, number>();
  routes.forEach((route, i) => {
    const first = seen.get(route.path.toLowerCase());
    if (first !== undefined) {
      const firstPath = routes[first]?.path ?? route.path;
      const caseNote = firstPath === route.path ? '' : ' (route paths match regardless of case)';
      v.error(`routes[${i}].path`, `duplicates routes[${first}].path "${firstPath}"${caseNote}`);
    }
    else seen.set(route.path.toLowerCase(), i);
  });

  if (v.issues.length > 0) throw new ConfigError(v.issues);
  return { config: { port, globalTimeoutMs, globalRateLimit, trustedProxies, routes }, warnings: v.warnings };
}

interface RouteDefaults {
  globalTimeoutMs: number;
  globalRateLimit: RateLimitConfig | null;
}

const ROUTE_KEYS = [
  'path',
  'methods',
  'strip_prefix',
  'upstream',
  'rate_limit',
  'retry',
  'health_check',
  'request_transform',
  'response_transform',
  'auth',
  'circuit_breaker',
];

function parseRoute(v: Validator, raw: unknown, at: string, defaults: RouteDefaults): RouteConfig {
  const r = v.mapping(raw, at);
  v.knownKeys(r, at, ROUTE_KEYS);

  const path = normalizeRoutePath(v.string(r.path, `${at}.path`));
  if (r.path !== undefined && path !== '') checkRoutePath(v, path, `${at}.path`);

  const methods = v.stringList(r.methods, `${at}.methods`, { nonEmpty: true }).map((m) => m.toUpperCase());
  methods.forEach((method, i) => {
    if (!HTTP_METHODS.has(method)) v.error(`${at}.methods[${i}]`, `unknown HTTP method "${method}"`);
  });

  const route: RouteConfig = {
    path,
    methods: [...new Set(methods)],
    stripPrefix: r.strip_prefix === undefined ? false : v.boolean(r.strip_prefix, `${at}.strip_prefix`),
    upstream: parseUpstream(v, r.upstream, `${at}.upstream`, defaults.globalTimeoutMs),
    rateLimit: r.rate_limit === undefined ? defaults.globalRateLimit : parseRateLimit(v, r.rate_limit, `${at}.rate_limit`),
  };

  if (r.retry !== undefined) route.retry = parseRetry(v, r.retry, `${at}.retry`);
  if (r.health_check !== undefined) route.healthCheck = parseHealthCheck(v, r.health_check, `${at}.health_check`);
  if (r.request_transform !== undefined)
    route.requestTransform = parseRequestTransform(v, r.request_transform, `${at}.request_transform`);
  if (r.response_transform !== undefined)
    route.responseTransform = parseResponseTransform(v, r.response_transform, `${at}.response_transform`);
  if (r.auth !== undefined) route.auth = parseAuth(v, r.auth, `${at}.auth`);
  if (r.circuit_breaker !== undefined) route.circuitBreaker = parseCircuitBreaker(v, r.circuit_breaker, `${at}.circuit_breaker`);

  return route;
}

/** "/api/users/" -> "/api/users"; "/" stays "/". */
function normalizeRoutePath(path: string): string {
  if (path.trim() === '') return '';
  const trimmed = path.trim().replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * Request paths are normalized before routing (see src/path.ts), so a route
 * path that isn't already in normalized form could never match anything.
 * Reject it instead of starting with a dead route.
 */
function checkRoutePath(v: Validator, path: string, at: string): void {
  if (!path.startsWith('/')) {
    v.error(at, 'must start with "/"');
    return;
  }
  if (path.includes('?') || path.includes('#')) {
    v.error(at, 'must be a path only, without "?" or "#"; routes match on the path, never the query string');
    return;
  }
  let normalized: string;
  try {
    normalized = normalizePath(path);
  } catch {
    v.error(at, 'must not contain encoded slashes (%2F, %5C), backslashes, null bytes, ";", or ".." above "/"');
    return;
  }
  if (normalized !== path) {
    v.error(at, `must be written in normalized form ("${normalized}"): requests are normalized before routing, so "${path}" could never match`);
  }
  if (path === '/health') {
    v.warn(`${at}: "/health" is answered by the gateway's built-in health endpoint, so this route only gets paths under /health/`);
  }
}

function parseUpstream(v: Validator, raw: unknown, at: string, globalTimeoutMs: number): UpstreamConfig {
  const u = v.mapping(raw, at);
  v.knownKeys(u, at, ['url', 'targets', 'balance', 'timeout']);

  let targets: UpstreamTarget[] = [];
  if (u.url !== undefined && u.targets !== undefined) {
    v.error(at, 'set either "url" or "targets", not both');
  } else if (u.url !== undefined) {
    targets = [{ url: v.httpUrl(u.url, `${at}.url`), weight: 1 }];
    if (u.balance !== undefined) v.warn(`${at}.balance: has no effect with a single "url"; it applies to "targets"`);
  } else if (u.targets !== undefined) {
    const list = v.list(u.targets, `${at}.targets`);
    if (list.length === 0) v.error(`${at}.targets`, 'must contain at least one target');
    targets = list.map((item, i) => {
      const t = v.mapping(item, `${at}.targets[${i}]`);
      v.knownKeys(t, `${at}.targets[${i}]`, ['url', 'weight']);
      return {
        url: v.httpUrl(t.url, `${at}.targets[${i}].url`),
        weight: t.weight === undefined ? 1 : v.integer(t.weight, `${at}.targets[${i}].weight`, 1),
      };
    });
  } else if (u === raw) {
    // Only when `upstream` is a real mapping; a missing/invalid one was already reported.
    v.error(at, 'must set "url" or "targets"');
  }

  // Without an explicit `balance`, honor weights if any were given. With equal
  // weights, weighted round robin behaves exactly like round robin anyway.
  const anyWeight = Array.isArray(u.targets) && u.targets.some((t) => (t as Mapping | null)?.weight !== undefined);
  const balance =
    u.balance === undefined
      ? anyWeight
        ? 'weighted_round_robin'
        : 'round_robin'
      : v.oneOf(u.balance, `${at}.balance`, ['round_robin', 'weighted_round_robin']);
  if (balance === 'round_robin' && u.balance !== undefined && targets.some((t) => t.weight !== 1)) {
    v.warn(`${at}: target weights are ignored with balance "round_robin"; use "weighted_round_robin" to apply them`);
  }

  return {
    targets,
    balance,
    timeoutMs: u.timeout === undefined ? globalTimeoutMs : v.duration(u.timeout, `${at}.timeout`, { timer: true }),
  };
}

function parseRateLimit(v: Validator, raw: unknown, at: string): RateLimitConfig {
  const r = v.mapping(raw, at);
  v.knownKeys(r, at, ['requests', 'window', 'strategy', 'per']);
  return {
    requests: v.integer(r.requests, `${at}.requests`, 1),
    windowMs: v.duration(r.window, `${at}.window`),
    strategy:
      r.strategy === undefined ? 'fixed_window' : v.oneOf(r.strategy, `${at}.strategy`, ['fixed_window', 'sliding_window']),
    per: r.per === undefined ? 'ip' : v.oneOf(r.per, `${at}.per`, ['ip', 'global']),
  };
}

function parseRetry(v: Validator, raw: unknown, at: string): RetryConfig {
  const r = v.mapping(raw, at);
  v.knownKeys(r, at, ['attempts', 'backoff', 'initial_delay', 'on']);
  return {
    attempts: v.integer(r.attempts, `${at}.attempts`, 1),
    backoff: r.backoff === undefined ? 'fixed' : v.oneOf(r.backoff, `${at}.backoff`, ['fixed', 'exponential']),
    initialDelayMs:
      r.initial_delay === undefined ? 100 : v.duration(r.initial_delay, `${at}.initial_delay`, { timer: true }),
    onStatus: r.on === undefined ? [502, 503, 504] : parseRetryOn(v, r.on, `${at}.on`),
  };
}

function parseRetryOn(v: Validator, raw: unknown, at: string): number[] {
  const list = v.list(raw, at);
  if (Array.isArray(raw) && list.length === 0) v.error(at, 'must not be empty: with no status codes, nothing would ever be retried');
  return list.map((code, i) => v.integer(code, `${at}[${i}]`, 100, 599));
}

function parseHealthCheck(v: Validator, raw: unknown, at: string): HealthCheckConfig {
  const h = v.mapping(raw, at);
  v.knownKeys(h, at, ['path', 'interval', 'unhealthy_threshold']);
  const path = v.string(h.path, `${at}.path`);
  if (h.path !== undefined && !path.startsWith('/')) v.error(`${at}.path`, 'must start with "/"');
  return {
    path,
    intervalMs: h.interval === undefined ? 30_000 : v.duration(h.interval, `${at}.interval`, { timer: true }),
    unhealthyThreshold:
      h.unhealthy_threshold === undefined ? 3 : v.integer(h.unhealthy_threshold, `${at}.unhealthy_threshold`, 1),
  };
}

/** Headers that `add` must not set: they belong to the connection or the gateway's own framing. */
const UNSETTABLE_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'proxy-connection',
]);

function parseHeaderTransform(v: Validator, raw: unknown, at: string, side: 'request' | 'response'): HeaderTransform {
  const h = v.mapping(raw, at);
  v.knownKeys(h, at, ['add', 'remove']);
  const add: Record<string, string> = {};
  if (h.add !== undefined) {
    for (const [name, value] of Object.entries(v.mapping(h.add, `${at}.add`))) {
      v.headerName(name, `${at}.add.${name}`);
      if (UNSETTABLE_HEADERS.has(name.toLowerCase())) v.error(`${at}.add.${name}`, 'cannot be set by a transform');
      const value_ = v.headerValue(v.scalarString(value, `${at}.add.${name}`), `${at}.add.${name}`);
      checkHeaderVariable(v, value_, `${at}.add.${name}`, side);
      add[name] = value_;
    }
  }
  const remove = h.remove === undefined ? [] : v.stringList(h.remove, `${at}.remove`);
  remove.forEach((name, i) => v.headerName(name, `${at}.remove[${i}]`));
  return { add, remove };
}

/**
 * A header value starting with "$" must be a known variable (or "$literal:..."),
 * so a typo like "$requst_time" is caught at startup instead of being sent as text.
 */
function checkHeaderVariable(v: Validator, value: string, at: string, side: 'request' | 'response'): void {
  if (!value.startsWith('$') || value.startsWith('$literal:')) return;
  const allowed = side === 'request' ? ['$request_time', '$route_path'] : ['$request_time', '$response_time', '$route_path'];
  if (!allowed.includes(value)) {
    v.error(at, `unknown variable "${value}" (use one of ${allowed.join(', ')}, or "$literal:..." for literal text)`);
  }
}

function parseRequestTransform(v: Validator, raw: unknown, at: string): RequestTransformConfig {
  const t = v.mapping(raw, at);
  v.knownKeys(t, at, ['headers', 'body']);
  const result: RequestTransformConfig = {};
  if (t.headers !== undefined) result.headers = parseHeaderTransform(v, t.headers, `${at}.headers`, 'request');
  if (t.body !== undefined) {
    const body = v.mapping(t.body, `${at}.body`);
    v.knownKeys(body, `${at}.body`, ['mapping']);
    const mapping: Record<string, string> = {};
    for (const [dest, source] of Object.entries(v.mapping(body.mapping, `${at}.body.mapping`))) {
      mapping[dest] = v.string(source, `${at}.body.mapping.${dest}`);
    }
    result.bodyMapping = mapping;
  }
  return result;
}

function parseResponseTransform(v: Validator, raw: unknown, at: string): ResponseTransformConfig {
  const t = v.mapping(raw, at);
  v.knownKeys(t, at, ['headers', 'body']);
  const result: ResponseTransformConfig = {};
  if (t.headers !== undefined) result.headers = parseHeaderTransform(v, t.headers, `${at}.headers`, 'response');
  if (t.body !== undefined) {
    const body = v.mapping(t.body, `${at}.body`);
    v.knownKeys(body, `${at}.body`, ['envelope']);
    result.bodyEnvelope = v.mapping(body.envelope, `${at}.body.envelope`);
  }
  return result;
}

function parseAuth(v: Validator, raw: unknown, at: string): ApiKeyAuthConfig {
  const a = v.mapping(raw, at);
  v.knownKeys(a, at, ['type', 'header', 'keys']);
  return {
    type: v.oneOf(a.type, `${at}.type`, ['api_key']),
    header: a.header === undefined ? 'X-API-Key' : v.headerName(v.string(a.header, `${at}.header`), `${at}.header`),
    keys: v.stringList(a.keys, `${at}.keys`, { nonEmpty: true }),
  };
}

function parseCircuitBreaker(v: Validator, raw: unknown, at: string): CircuitBreakerConfig {
  const c = v.mapping(raw, at);
  v.knownKeys(c, at, ['threshold', 'window', 'cooldown']);
  return {
    threshold: v.integer(c.threshold, `${at}.threshold`, 1),
    windowMs: v.duration(c.window, `${at}.window`),
    cooldownMs: v.duration(c.cooldown, `${at}.cooldown`),
  };
}

type Mapping = Record<string, unknown>;

/** Collects issues instead of throwing; returns placeholders for invalid values. */
class Validator {
  readonly issues: string[] = [];
  readonly warnings: string[] = [];

  error(at: string, message: string): void {
    this.issues.push(`${at}: ${message}`);
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  knownKeys(obj: Mapping, at: string, allowed: string[], opts: { allowPrefix?: string } = {}): void {
    for (const key of Object.keys(obj)) {
      if (allowed.includes(key) || (opts.allowPrefix && key.startsWith(opts.allowPrefix))) continue;
      this.warn(`${at}.${key}: unknown key (ignored)`);
    }
  }

  /** Returns the name; records an issue if it isn't a valid HTTP header name. */
  headerName(name: string, at: string): string {
    if (name !== '' && !HEADER_NAME.test(name)) this.error(at, `"${name}" is not a valid HTTP header name`);
    return name;
  }

  /** Header values must not contain line breaks: they would end the header and start another. */
  headerValue(value: string, at: string): string {
    if (/[\r\n\0]/.test(value)) this.error(at, 'must not contain line breaks or null bytes');
    return value;
  }

  mapping(value: unknown, at: string): Mapping {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Mapping;
    this.error(at, value === undefined ? 'is required' : 'must be a mapping');
    return {};
  }

  list(value: unknown, at: string): unknown[] {
    if (Array.isArray(value)) return value;
    this.error(at, value === undefined ? 'is required' : 'must be a list');
    return [];
  }

  string(value: unknown, at: string): string {
    if (typeof value === 'string' && value.trim() !== '') return value;
    this.error(at, value === undefined ? 'is required' : 'must be a non-empty string');
    return '';
  }

  /** Header values may be written as numbers or booleans in YAML; accept them as strings. */
  scalarString(value: unknown, at: string): string {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
    this.error(at, 'must be a string');
    return '';
  }

  stringList(value: unknown, at: string, opts: { nonEmpty?: boolean } = {}): string[] {
    const items = this.list(value, at);
    if (opts.nonEmpty && Array.isArray(value) && items.length === 0) this.error(at, 'must not be empty');
    return items.map((item, i) => this.string(item, `${at}[${i}]`));
  }

  boolean(value: unknown, at: string): boolean {
    if (typeof value === 'boolean') return value;
    this.error(at, 'must be true or false');
    return false;
  }

  integer(value: unknown, at: string, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number {
    if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) return value;
    const range = max === Number.MAX_SAFE_INTEGER ? `>= ${min}` : `between ${min} and ${max}`;
    this.error(at, value === undefined ? 'is required' : `must be an integer ${range}`);
    return min;
  }

  oneOf<T extends string>(value: unknown, at: string, allowed: readonly T[]): T {
    if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
    this.error(at, `must be one of ${allowed.map((a) => `"${a}"`).join(', ')}`);
    return allowed[0] as T;
  }

  /** `timer`: the value becomes a setTimeout delay, so it must fit Node's timer limit. */
  duration(value: unknown, at: string, opts: { timer?: boolean } = {}): number {
    if (typeof value !== 'string') {
      this.error(at, value === undefined ? 'is required' : 'must be a duration string such as "30s"');
      return 1;
    }
    try {
      const ms = parseDuration(value);
      if (ms <= 0) {
        this.error(at, 'must be greater than zero');
      } else if (opts.timer && ms > MAX_TIMER_MS) {
        // Node fires longer timers after 1 ms, which would make every request time out at once.
        this.error(at, `must be at most 24 days ("${value}" is longer than a Node timer can wait)`);
      } else {
        return ms;
      }
    } catch (err) {
      this.error(at, (err as Error).message);
    }
    return 1;
  }

  httpUrl(value: unknown, at: string): URL {
    const placeholder = new URL('http://invalid.invalid');
    const text = this.string(value, at);
    if (text === '') return placeholder;
    try {
      const url = new URL(text);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        this.error(at, `must be an http:// or https:// URL, got "${text}"`);
      } else if (url.search || url.hash) {
        // Request paths are appended to the URL's path; a query or fragment here would be silently dropped.
        this.error(at, 'must not include a query string or "#fragment"; the client\'s own query string is forwarded');
      } else if (url.username || url.password) {
        this.error(at, 'must not include credentials ("user:pass@"); they would not be sent to the upstream');
      } else {
        return url;
      }
    } catch {
      this.error(at, `is not a valid URL: "${text}"`);
    }
    return placeholder;
  }
}
