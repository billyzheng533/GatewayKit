import type { UpstreamConfig, UpstreamTarget } from '../config/types.js';

/**
 * Picks which target of a route's upstream gets the next request.
 *
 * `pick` is synchronous and Node runs one callback at a time, so concurrent
 * requests can't race on the balancer's state: 40 simultaneous requests at 3:1
 * weights get exactly 30 and 10.
 *
 * The optional `eligible` filter lets callers skip targets (health checks
 * will use it to skip unhealthy ones). It returns undefined when no target
 * is eligible.
 */
export interface Balancer {
  pick(eligible?: (target: UpstreamTarget) => boolean): UpstreamTarget | undefined;
}

export function createBalancer(upstream: UpstreamConfig): Balancer {
  if (upstream.targets.length === 1) return new SingleTarget(upstream.targets[0] as UpstreamTarget);
  return upstream.balance === 'weighted_round_robin'
    ? new WeightedRoundRobin(upstream.targets)
    : new RoundRobin(upstream.targets);
}

class SingleTarget implements Balancer {
  constructor(private readonly target: UpstreamTarget) {}

  pick(eligible: (target: UpstreamTarget) => boolean = () => true): UpstreamTarget | undefined {
    return eligible(this.target) ? this.target : undefined;
  }
}

/** Each target in turn; weights are ignored. */
export class RoundRobin implements Balancer {
  private next = 0;

  constructor(private readonly targets: readonly UpstreamTarget[]) {}

  pick(eligible: (target: UpstreamTarget) => boolean = () => true): UpstreamTarget | undefined {
    for (let tried = 0; tried < this.targets.length; tried += 1) {
      const target = this.targets[this.next] as UpstreamTarget;
      this.next = (this.next + 1) % this.targets.length;
      if (eligible(target)) return target;
    }
    return undefined;
  }
}

/**
 * Smooth weighted round robin (the algorithm nginx uses). Each pick, every
 * eligible target's score grows by its weight; the highest score wins and is
 * lowered by the total weight. Over any cycle each target gets exactly its
 * share, spread out rather than in bursts: weights 3:1 give A, A, B, A
 * instead of A, A, A, B, so the lighter target isn't idle for long stretches.
 */
export class WeightedRoundRobin implements Balancer {
  private readonly scores: number[];

  constructor(private readonly targets: readonly UpstreamTarget[]) {
    this.scores = targets.map(() => 0);
  }

  pick(eligible: (target: UpstreamTarget) => boolean = () => true): UpstreamTarget | undefined {
    let best = -1;
    let totalWeight = 0;
    this.targets.forEach((target, i) => {
      if (!eligible(target)) return;
      this.scores[i] = (this.scores[i] as number) + target.weight;
      totalWeight += target.weight;
      if (best === -1 || (this.scores[i] as number) > (this.scores[best] as number)) best = i;
    });
    if (best === -1) return undefined;
    this.scores[best] = (this.scores[best] as number) - totalWeight;
    return this.targets[best];
  }
}
