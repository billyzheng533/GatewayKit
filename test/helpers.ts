import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseConfig } from '../src/config/load.js';
import { startGateway, type RunningGateway } from '../src/server.js';

/** Starts a gateway on a random port from YAML text, through the real config loader. */
export function startTestGateway(yaml: string): Promise<RunningGateway> {
  const { config } = parseConfig(yaml);
  return startGateway(config, { port: 0 });
}

/** A port that nothing is listening on (for "upstream is down" tests). */
export async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
