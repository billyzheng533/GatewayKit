import { ConfigError, loadConfigFile } from './config/load.js';
import { unenforcedFeatureWarnings } from './features/index.js';
import { createJsonLogger } from './logger.js';
import { startGateway } from './server.js';

const USAGE = `Usage: gatewaykit <path/to/gateway.yaml>
   or: GATEWAY_CONFIG=<path/to/gateway.yaml> gatewaykit`;

async function main(): Promise<void> {
  const logger = createJsonLogger();
  const configPath = process.argv[2] ?? process.env.GATEWAY_CONFIG;
  if (!configPath) {
    console.error(USAGE);
    process.exit(2);
  }

  let loaded;
  try {
    loaded = await loadConfigFile(configPath);
  } catch (err) {
    // Fail fast and loudly on bad config: never start with a guessed-at configuration.
    console.error(err instanceof ConfigError ? err.message : String(err));
    process.exit(1);
  }

  const { config, warnings } = loaded;
  for (const warning of [...warnings, ...unenforcedFeatureWarnings(config)]) logger.warn(warning);

  let gateway;
  try {
    gateway = await startGateway(config, { logger });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE' || code === 'EACCES') {
      const reason = code === 'EADDRINUSE' ? 'is already in use' : 'needs elevated permissions';
      console.error(`Cannot listen on port ${config.port}: it ${reason}. Change gateway.port in ${configPath}.`);
      process.exit(1);
    }
    throw err;
  }
  logger.info('gateway listening', { port: gateway.port, config: configPath, routes: config.routes.map((r) => r.path) });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    gateway.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('fatal:', err);
  process.exit(1);
});
