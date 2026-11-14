import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UpstreamTarget } from '../src/config/types.js';
import { silentLogger, type Logger } from '../src/logger.js';
import { HealthChecker, healthCheckUrl, httpProbe, type Probe } from '../src/proxy/healthCheck.js';
import { startMockUpstream, type MockUpstream } from '../mock/upstream.js';
import { closedPort } from './helpers.js';

const target = (url: string): UpstreamTarget => ({ url: new URL(url), weight: 1 });
const config = { path: '/healthz', intervalMs: 60_000, unhealthyThreshold: 3 };

describe('HealthChecker state', () => {
  const a = target('http://a');
  const make = (logger: Logger = silentLogger) => new HealthChecker('/r', [a], config, 1_000, logger);

  it('starts healthy', () => {
    expect(make().isHealthy(a)).toBe(true);
  });

  it('marks a target unhealthy only after `unhealthy_threshold` failures in a row', () => {
    const checker = make();
    checker.record(a, false);
    checker.record(a, false);
    expect(checker.isHealthy(a)).toBe(true);
    checker.record(a, false);
    expect(checker.isHealthy(a)).toBe(false);
  });

  it('resets the failure count on a success, so failures must be consecutive', () => {
    const checker = make();
    for (const ok of [false, false, true, false, false]) checker.record(a, ok);
    expect(checker.isHealthy(a)).toBe(true);
  });

  it('marks an unhealthy target healthy again after one success', () => {
    const checker = make();
    for (let i = 0; i < 3; i += 1) checker.record(a, false);
    checker.record(a, true);
    expect(checker.isHealthy(a)).toBe(true);
  });

  it('logs each change of state once', () => {
    const lines: string[] = [];
    const logger: Logger = { info: (m) => lines.push(`info ${m}`), warn: (m) => lines.push(`warn ${m}`), error: () => {} };
    const checker = make(logger);
    for (const ok of [false, false, false, false, true, true]) checker.record(a, ok);
    expect(lines).toEqual(['warn upstream target unhealthy', 'info upstream target healthy again']);
  });

  it('skips a target whose previous check is still running', async () => {
    let calls = 0;
    let release!: () => void;
    const slowProbe: Probe = () => {
      calls += 1;
      return new Promise((resolve) => (release = () => resolve(true)));
    };
    const checker = new HealthChecker('/r', [a], config, 1_000, silentLogger, slowProbe);
    const first = checker.checkAll();
    await checker.checkAll(); // previous check still in flight: skipped
    expect(calls).toBe(1);
    release();
    await first;
  });

  it('ignores results that arrive after stop()', async () => {
    let release!: () => void;
    const probe: Probe = () => new Promise((resolve) => (release = () => resolve(false)));
    const checker = new HealthChecker('/r', [a], { ...config, unhealthyThreshold: 1 }, 1_000, silentLogger, probe);
    const pending = checker.checkAll();
    checker.stop();
    release();
    await pending;
    expect(checker.isHealthy(a)).toBe(true);
  });
});

describe('healthCheckUrl', () => {
  it('appends the check path to the target, including its base path', () => {
    expect(healthCheckUrl(new URL('http://x:3003'), '/healthz').href).toBe('http://x:3003/healthz');
    expect(healthCheckUrl(new URL('http://x:3003/v2/'), '/healthz').href).toBe('http://x:3003/v2/healthz');
    expect(healthCheckUrl(new URL('http://x'), '/status?verbose=1').href).toBe('http://x/status?verbose=1');
  });
});

describe('httpProbe', () => {
  let mock: MockUpstream;
  let deadPort: number;
  const never = new AbortController().signal;

  beforeAll(async () => {
    mock = await startMockUpstream('probe');
    deadPort = await closedPort();
  });
  afterAll(async () => {
    await mock?.close();
  });

  it('passes on a 2xx', async () => {
    expect(await httpProbe(new URL(`${mock.url}/healthz`), 500, never)).toBe(true);
  });

  it('fails on a non-2xx status', async () => {
    mock.setHealthy(false);
    try {
      expect(await httpProbe(new URL(`${mock.url}/healthz`), 500, never)).toBe(false);
      expect(await httpProbe(new URL(`${mock.url}/status/301`), 500, never)).toBe(false);
    } finally {
      mock.setHealthy(true);
    }
  });

  it('fails when the target refuses the connection', async () => {
    expect(await httpProbe(new URL(`http://127.0.0.1:${deadPort}/healthz`), 500, never)).toBe(false);
  });

  it('fails when the target answers too slowly', async () => {
    const started = Date.now();
    expect(await httpProbe(new URL(`${mock.url}/slow?ms=1000`), 100, never)).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
