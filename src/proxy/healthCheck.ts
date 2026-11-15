import http from 'node:http';
import https from 'node:https';
import type { HealthCheckConfig, UpstreamTarget } from '../config/types.js';
import type { Logger } from '../logger.js';
import { describeConnectError, joinTargetPath } from './client.js';

/**
 * Active health checks for one route's upstream targets.
 *
 * Every `interval`, each target's health check path is requested. A target is
 * marked unhealthy after `unhealthy_threshold` failures in a row, and healthy
 * again after one success. The load balancer skips unhealthy targets.
 *
 * - Success is any 2xx response. Connection errors, timeouts and other
 *   statuses are failures.
 * - Each check times out after the route's upstream timeout or the interval,
 *   whichever is shorter, so a hanging target can't stall its own checks.
 * - Targets start healthy, so traffic flows from the moment the gateway
 *   starts; the first round of checks runs immediately.
 * - A target's next check is skipped if its previous one is still running.
 * - Timers are unref'd and stop() aborts checks in flight, so health checks
 *   never keep the process alive or delay shutdown.
 */

/** The outcome of one health check. A failure says why, so logs can explain it. */
export type CheckResult = { ok: true } | { ok: false; reason: string; status?: number };

/** Requests `url` and reports whether it answered with a 2xx in time, and if not, why. */
export type Probe = (url: URL, timeoutMs: number, signal: AbortSignal) => Promise<CheckResult>;

interface TargetState {
  healthy: boolean;
  consecutiveFailures: number;
  checking: boolean;
}

export class HealthChecker {
  private readonly states = new Map<UpstreamTarget, TargetState>();
  private readonly abort = new AbortController();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly routePath: string,
    private readonly targets: readonly UpstreamTarget[],
    private readonly config: HealthCheckConfig,
    private readonly checkTimeoutMs: number,
    private readonly logger: Logger,
    private readonly probe: Probe = httpProbe,
  ) {
    for (const target of targets) this.states.set(target, { healthy: true, consecutiveFailures: 0, checking: false });
  }

  start(): void {
    this.logger.info('health checks started', {
      route: this.routePath,
      targets: this.targets.map((t) => healthCheckUrl(t.url, this.config.path).href),
      interval_ms: this.config.intervalMs,
      unhealthy_threshold: this.config.unhealthyThreshold,
    });
    const round = () =>
      this.checkAll().catch((err: unknown) => {
        // A bug in one round must never take the gateway down (an unhandled rejection would).
        this.logger.error('health check round failed', { route: this.routePath, error: String(err) });
      });
    void round();
    this.timer = setInterval(() => void round(), this.config.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.abort.abort();
  }

  isHealthy = (target: UpstreamTarget): boolean => this.states.get(target)?.healthy ?? true;

  /** Runs one round of checks (exposed so tests can drive rounds directly). */
  async checkAll(): Promise<void> {
    await Promise.all(this.targets.map((target) => this.checkOne(target)));
  }

  /** Applies one check result to a target's state. A bare boolean is accepted for convenience in tests. */
  record(target: UpstreamTarget, outcome: CheckResult | boolean): void {
    const result: CheckResult =
      typeof outcome === 'boolean' ? (outcome ? { ok: true } : { ok: false, reason: 'failed' }) : outcome;
    const state = this.states.get(target);
    if (!state) return;
    if (result.ok) {
      state.consecutiveFailures = 0;
      if (!state.healthy) {
        state.healthy = true;
        this.logger.info('upstream target healthy again', { route: this.routePath, target: target.url.origin });
      }
      return;
    }
    state.consecutiveFailures += 1;
    if (state.healthy && state.consecutiveFailures >= this.config.unhealthyThreshold) {
      state.healthy = false;
      this.logger.warn('upstream target unhealthy', {
        route: this.routePath,
        target: target.url.origin,
        consecutive_failures: state.consecutiveFailures,
        reason: result.reason,
        ...hintFor(result, healthCheckUrl(target.url, this.config.path)),
      });
    }
  }

  private async checkOne(target: UpstreamTarget): Promise<void> {
    const state = this.states.get(target);
    if (!state || state.checking || this.abort.signal.aborted) return;
    state.checking = true;
    try {
      const result = await this.probe(healthCheckUrl(target.url, this.config.path), this.checkTimeoutMs, this.abort.signal);
      if (!this.abort.signal.aborted) this.record(target, result);
    } finally {
      state.checking = false;
    }
  }
}

/** The health check path is relative to the target, including any base path in its URL. */
export function healthCheckUrl(target: URL, path: string): URL {
  const url = new URL(target.href);
  url.pathname = joinTargetPath(target, path.split('?')[0] as string);
  url.search = path.includes('?') ? path.slice(path.indexOf('?')) : '';
  return url;
}

/**
 * A 404 or 405 from the health check path almost always means the path is
 * wrong (or the service has no health endpoint), not that the service is
 * sick. Say so, since otherwise this looks like an outage.
 */
function hintFor(result: CheckResult, url: URL): { hint?: string } {
  if (result.ok || (result.status !== 404 && result.status !== 405)) return {};
  return {
    hint: `${url.href} returned ${result.status}: the target may not have a health endpoint at this path; check health_check.path`,
  };
}

export const httpProbe: Probe = (url, timeoutMs, signal) =>
  new Promise((resolve) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const req = (url.protocol === 'https:' ? https : http).get(
      url,
      { signal: AbortSignal.any([signal, timeout]), agent: false },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        resolve(status >= 200 && status < 300 ? { ok: true } : { ok: false, reason: `status ${status}`, status });
      },
    );
    req.on('error', (err: Error) => {
      if (timeout.aborted) return resolve({ ok: false, reason: `timed out after ${timeoutMs}ms` });
      // Same description the proxy uses, including dual-stack "localhost" failures.
      const { error, code } = describeConnectError(err);
      resolve({ ok: false, reason: code === 'ECONNREFUSED' ? 'connection refused' : error.message });
    });
  });
