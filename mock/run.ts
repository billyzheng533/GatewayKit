import { startMockUpstream } from './upstream.js';

/** Starts mock upstreams on the ports used by the example gateway.yaml. */
const MOCKS: Array<[name: string, port: number]> = [
  ['users', 3001],
  ['orders', 3002],
  ['products-a', 3003],
  ['products-b', 3004],
  ['legacy', 3005],
  ['internal', 3006],
];

const running = await Promise.all(MOCKS.map(([name, port]) => startMockUpstream(name, port)));
for (const mock of running) console.log(`mock upstream "${mock.name}" listening on ${mock.url}`);

const stop = async () => {
  await Promise.all(running.map((mock) => mock.close()));
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
