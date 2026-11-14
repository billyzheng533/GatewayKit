import { afterEach, describe, expect, it } from 'vitest';
import { startMockUpstream, type MockUpstream } from '../mock/upstream.js';

/**
 * The mock's /flaky endpoint, tested directly (no gateway). The retry and
 * circuit breaker tests depend on it behaving exactly as documented.
 */

const mocks: MockUpstream[] = [];
afterEach(async () => {
  await Promise.all(mocks.splice(0).map((m) => m.close()));
});

async function freshMock(): Promise<MockUpstream> {
  const mock = await startMockUpstream('flaky-test');
  mocks.push(mock);
  return mock;
}

/** Status codes of `count` sequential GETs to `path` on the mock. */
async function statuses(mock: MockUpstream, path: string, count: number): Promise<number[]> {
  const result: number[] = [];
  for (let i = 0; i < count; i += 1) result.push((await fetch(`${mock.url}${path}`)).status);
  return result;
}

describe('mock /flaky endpoint', () => {
  it('fails the first `fail` calls with 503, then echoes with 200', async () => {
    const mock = await freshMock();
    expect(await statuses(mock, '/flaky?fail=2&key=a', 4)).toEqual([503, 503, 200, 200]);
  });

  it('numbers each failure in the 503 body', async () => {
    const mock = await freshMock();
    const first = await fetch(`${mock.url}/flaky?fail=2&key=a`);
    const second = await fetch(`${mock.url}/flaky?fail=2&key=a`);
    expect(await first.json()).toEqual({ upstream: 'flaky-test', error: 'flaky', call: 1 });
    expect(await second.json()).toEqual({ upstream: 'flaky-test', error: 'flaky', call: 2 });
  });

  it('keeps a separate counter for each key', async () => {
    const mock = await freshMock();
    expect(await statuses(mock, '/flaky?fail=2&key=a', 3)).toEqual([503, 503, 200]);
    expect(await statuses(mock, '/flaky?fail=2&key=b', 3)).toEqual([503, 503, 200]); // unaffected by "a"
  });

  it('uses the key "default" when none is given', async () => {
    const mock = await freshMock();
    expect(await statuses(mock, '/flaky?fail=2', 2)).toEqual([503, 503]);
    expect(await statuses(mock, '/flaky?fail=2&key=default', 1)).toEqual([200]); // same counter
  });

  it('fails once when `fail` is not given', async () => {
    const mock = await freshMock();
    expect(await statuses(mock, '/flaky?key=a', 3)).toEqual([503, 200, 200]);
  });

  it('never fails with fail=0', async () => {
    const mock = await freshMock();
    expect(await statuses(mock, '/flaky?fail=0&key=a', 2)).toEqual([200, 200]);
  });

  it('counts by key only: the path before /flaky and the `fail` value are not part of the counter', async () => {
    const mock = await freshMock();
    await statuses(mock, '/api/orders/flaky?fail=2&key=a', 2); // calls 1 and 2 fail
    expect(await statuses(mock, '/api/other/flaky?fail=2&key=a', 1)).toEqual([200]); // call 3: same counter
    expect(await statuses(mock, '/flaky?fail=5&key=a', 1)).toEqual([503]); // call 4 <= 5: `fail` is read per call
  });

  it('starts every counter over when the mock restarts', async () => {
    const first = await freshMock();
    expect(await statuses(first, '/flaky?fail=1&key=a', 2)).toEqual([503, 200]);
    const restarted = await freshMock(); // a new mock instance has no counters yet
    expect(await statuses(restarted, '/flaky?fail=1&key=a', 2)).toEqual([503, 200]);
  });

  it('echoes the request once it stops failing', async () => {
    const mock = await freshMock();
    await fetch(`${mock.url}/api/orders/flaky?fail=1&key=a`);
    const res = await fetch(`${mock.url}/api/orders/flaky?fail=1&key=a&extra=1`);
    expect(await res.json()).toMatchObject({
      upstream: 'flaky-test',
      method: 'GET',
      path: '/api/orders/flaky',
      query: { fail: '1', key: 'a', extra: '1' },
    });
  });
});
