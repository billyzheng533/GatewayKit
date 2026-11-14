export type LogFields = Record<string, unknown>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/** Structured JSON lines: info to stdout, warnings and errors to stderr. */
export function createJsonLogger(): Logger {
  const write = (level: string, stream: NodeJS.WriteStream) => (message: string, fields: LogFields = {}) => {
    stream.write(`${JSON.stringify({ time: new Date().toISOString(), level, message, ...fields })}\n`);
  };
  return {
    info: write('info', process.stdout),
    warn: write('warn', process.stderr),
    error: write('error', process.stderr),
  };
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
