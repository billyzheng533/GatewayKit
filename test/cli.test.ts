import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * Starts the real CLI (`src/index.ts`) as a separate process, the way someone
 * running the gateway would: config path from argv or GATEWAY_CONFIG, refusal
 * to start on a bad config, and clean shutdown on SIGTERM.
 */

const TSX = join(process.cwd(), 'node_modules', '.bin', 'tsx');
let dir: string;
const children: ChildProcess[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gatewaykit-cli-'));
});

afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeConfig(name: string, yaml: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, yaml);
  return path;
}

interface CliRun {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<number | null>;
}

function runCli(args: string[], env: Record<string, string> = {}): CliRun {
  const child = spawn(TSX, ['src/index.ts', ...args], { env: { ...process.env, ...env }, stdio: 'pipe' });
  children.push(child);
  let out = '';
  let err = '';
  child.stdout?.on('data', (chunk) => (out += chunk));
  child.stderr?.on('data', (chunk) => (err += chunk));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, stdout: () => out, stderr: () => err, exited };
}

/** Resolves with the port from the "gateway listening" log line. */
function listeningPort(run: CliRun): Promise<number> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const line = run.stdout().split('\n').find((l) => l.includes('"gateway listening"'));
      if (line) {
        run.child.stdout?.off('data', check);
        resolve((JSON.parse(line) as { port: number }).port);
      }
    };
    run.child.stdout?.on('data', check);
    run.exited.then((code) => reject(new Error(`exited with ${code} before listening: ${run.stderr()}`)));
  });
}

const VALID = `
gateway:
  port: 0   # any free port, so tests never collide with a running gateway
routes:
  - path: "/api"
    methods: ["GET"]
    strip_prefx: true   # typo on purpose: should warn, not fail
    upstream: { url: "http://127.0.0.1:1" }
`;

describe('gatewaykit CLI', () => {
  it('starts from a config path argument, serves /health, and exits 0 on SIGTERM', async () => {
    const run = runCli([await writeConfig('valid.yaml', VALID)]);
    const port = await listeningPort(run);

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'healthy' });
    expect(run.stderr()).toContain('routes[0].strip_prefx: unknown key (ignored)');

    run.child.kill('SIGTERM');
    expect(await run.exited).toBe(0);
  });

  it('reads the config path from GATEWAY_CONFIG', async () => {
    const run = runCli([], { GATEWAY_CONFIG: await writeConfig('env.yaml', VALID) });
    const port = await listeningPort(run);
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
  });

  it('refuses to start on an invalid config, listing every problem, and exits 1', async () => {
    const path = await writeConfig(
      'invalid.yaml',
      `
routes:
  - path: "api"
    methods: ["GET"]
    upstream: { url: "http://127.0.0.1:1", timeout: "soon" }
`,
    );
    const run = runCli([path]);
    expect(await run.exited).toBe(1);
    expect(run.stderr()).toContain('Invalid gateway config');
    expect(run.stderr()).toContain('routes[0].path: must start with "/"');
    expect(run.stderr()).toContain('routes[0].upstream.timeout: invalid duration "soon"');
    expect(run.stdout()).not.toContain('gateway listening');
  });

  it('exits 1 with a clear message when the config file does not exist', async () => {
    const run = runCli([join(dir, 'missing.yaml')]);
    expect(await run.exited).toBe(1);
    expect(run.stderr()).toContain('cannot read config file');
  });

  it('prints usage and exits 2 when no config is given', async () => {
    const run = runCli([], { GATEWAY_CONFIG: '' }); // in case the developer's shell sets it
    expect(await run.exited).toBe(2);
    expect(run.stderr()).toContain('Usage: gatewaykit');
  });
});
