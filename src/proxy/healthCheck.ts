import http from 'node:http';
import https from 'node:https';
import type { HealthCheckConfig, UpstreamTarget } from '../config/types.js';
import type { Logger } from '../logger.js';

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

/** Requests `url` and reports whether it answered with a 2xx in time. */
export type Probe = (url: URL, timeoutMs: number, signal: AbortSignal) => Promise<boolean>;

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
    void this.checkAll();
    this.timer = setInterval(() => void this.checkAll(), this.config.intervalMs);
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

  /** Applies one check result to a target's state. */
  record(target: UpstreamTarget, ok: boolean): void {
    const state = this.states.get(target);
    if (!state) return;
    if (ok) {
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
      });
    }
  }

  private async checkOne(target: UpstreamTarget): Promise<void> {
    const state = this.states.get(target);
    if (!state || state.checking || this.abort.signal.aborted) return;
    state.checking = true;
    try {
      const ok = await this.probe(healthCheckUrl(target.url, this.config.path), this.checkTimeoutMs, this.abort.signal);
      if (!this.abort.signal.aborted) this.record(target, ok);
    } finally {
      state.checking = false;
    }
  }
}

/** The health check path is relative to the target, including any base path in its URL. */
export function healthCheckUrl(target: URL, path: string): URL {
  const url = new URL(target.href);
  url.pathname = target.pathname.replace(/\/+$/, '') + path.split('?')[0];
  url.search = path.includes('?') ? path.slice(path.indexOf('?')) : '';
  return url;
}

export const httpProbe: Probe = (url, timeoutMs, signal) =>
  new Promise((resolve) => {
    const req = (url.protocol === 'https:' ? https : http).get(
      url,
      { signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]), agent: false },
      (res) => {
        res.resume();
        resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300);
      },
    );
    req.on('error', () => resolve(false));
  });
