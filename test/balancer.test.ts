import { describe, expect, it } from 'vitest';
import type { UpstreamConfig, UpstreamTarget } from '../src/config/types.js';
import { createBalancer } from '../src/proxy/balancer.js';

const target = (name: string, weight = 1): UpstreamTarget => ({ url: new URL(`http://${name}`), weight });
const upstream = (balance: UpstreamConfig['balance'], targets: UpstreamTarget[]): UpstreamConfig => ({
  targets,
  balance,
  timeoutMs: 1_000,
});

/** Host names of `count` picks. */
function picks(balancer: ReturnType<typeof createBalancer>, count: number, eligible?: (t: UpstreamTarget) => boolean) {
  return Array.from({ length: count }, () => balancer.pick(eligible)?.url.hostname ?? 'none');
}

describe('round_robin', () => {
  it('takes each target in turn', () => {
    const balancer = createBalancer(upstream('round_robin', [target('a'), target('b'), target('c')]));
    expect(picks(balancer, 7)).toEqual(['a', 'b', 'c', 'a', 'b', 'c', 'a']);
  });

  it('ignores weights', () => {
    const balancer = createBalancer(upstream('round_robin', [target('a', 3), target('b', 1)]));
    expect(picks(balancer, 4)).toEqual(['a', 'b', 'a', 'b']);
  });
});

describe('weighted_round_robin', () => {
  it('gives each target its exact share per cycle, spread out rather than in a burst', () => {
    const balancer = createBalancer(upstream('weighted_round_robin', [target('a', 3), target('b', 1)]));
    expect(picks(balancer, 8)).toEqual(['a', 'a', 'b', 'a', 'a', 'a', 'b', 'a']);
  });

  it('keeps proportions over many picks with several targets', () => {
    const balancer = createBalancer(
      upstream('weighted_round_robin', [target('a', 5), target('b', 3), target('c', 2)]),
    );
    const counts = picks(balancer, 1_000).reduce<Record<string, number>>((acc, name) => {
      acc[name] = (acc[name] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ a: 500, b: 300, c: 200 });
  });

  it('behaves like round robin when all weights are equal', () => {
    const balancer = createBalancer(upstream('weighted_round_robin', [target('a'), target('b')]));
    expect(picks(balancer, 4)).toEqual(['a', 'b', 'a', 'b']);
  });
});

describe('a single target', () => {
  it('always picks it, whatever the balance strategy', () => {
    expect(picks(createBalancer(upstream('round_robin', [target('only')])), 3)).toEqual(['only', 'only', 'only']);
    expect(picks(createBalancer(upstream('weighted_round_robin', [target('only', 5)])), 2)).toEqual(['only', 'only']);
  });
});

describe('skipping targets (used by health checks)', () => {
  const notB = (t: UpstreamTarget) => t.url.hostname !== 'b';

  it('round robin skips ineligible targets', () => {
    const balancer = createBalancer(upstream('round_robin', [target('a'), target('b'), target('c')]));
    expect(picks(balancer, 4, notB)).toEqual(['a', 'c', 'a', 'c']);
  });

  it('weighted round robin shares out among the eligible targets only', () => {
    const balancer = createBalancer(
      upstream('weighted_round_robin', [target('a', 1), target('b', 5), target('c', 1)]),
    );
    expect(picks(balancer, 4, notB)).toEqual(['a', 'c', 'a', 'c']);
  });

  it('returns nothing when no target is eligible', () => {
    const none = () => false;
    expect(picks(createBalancer(upstream('round_robin', [target('a'), target('b')])), 1, none)).toEqual(['none']);
    expect(picks(createBalancer(upstream('weighted_round_robin', [target('a', 2), target('b')])), 1, none)).toEqual([
      'none',
    ]);
    expect(picks(createBalancer(upstream('round_robin', [target('a')])), 1, none)).toEqual(['none']);
  });
});
