import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { Socket } from 'node:net';
import { ensureDaemonKey, readDaemonKey } from '../../src/identity/daemon-key.js';
import { loadConfig } from '../../src/config/loader.js';
import { startDaemon, type DaemonHandle } from '../../src/daemon/index.js';
import { writeFramed, readFramed, connectSocket } from '../fixtures/framing.js';

let tempDir: string;
let socketPath: string;
let keyPath: string;
let daemonHandle: DaemonHandle;

describe('E2E: Proxy passthrough', () => {
  const mockServerPath = join(import.meta.dirname, '..', 'fixtures', 'mock-mcp-server.ts');

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'mcp-guard-e2e-'));
    socketPath = join(tempDir, 'daemon.sock');
    keyPath = join(tempDir, 'daemon.key');
    const dbPath = join(tempDir, 'mcp-guard.db');
    const pidFile = join(tempDir, 'daemon.pid');

    await mkdir(tempDir, { recursive: true });

    // Patch constants for test isolation
    const constantsModule = await import('../../src/constants.js');
    Object.defineProperty(constantsModule, 'DEFAULT_SOCKET_PATH', { value: socketPath });
    Object.defineProperty(constantsModule, 'DEFAULT_DAEMON_KEY_PATH', { value: keyPath });
    Object.defineProperty(constantsModule, 'DEFAULT_DB_PATH', { value: dbPath });
    Object.defineProperty(constantsModule, 'DEFAULT_PID_FILE', { value: pidFile });

    // Create daemon key
    await ensureDaemonKey(keyPath);

    // Write config
    const configPath = join(tempDir, 'config.yaml');
    await writeFile(
      configPath,
      `
servers:
  mock:
    transport: stdio
    command: npx
    args: ["tsx", "${mockServerPath}"]
daemon:
  socket_path: "${socketPath}"
  home: "${tempDir}"
  shutdown_timeout: 5
  dashboard_port: 0
`,
    );

    // Start daemon in-process
    const config = await loadConfig(configPath);
    daemonHandle = await startDaemon(config);

    // Give upstream server time to connect
    await new Promise((r) => setTimeout(r, 2000));
  }, 15000);

  afterAll(async () => {
    await daemonHandle.shutdown();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function authenticatedSocket(): Promise<Socket> {
    const socket = await connectSocket(socketPath);
    const key = await readDaemonKey(keyPath);
    writeFramed(socket, { type: 'auth', key: key.toString('hex') });
    const response = (await readFramed(socket)) as { type: string };
    expect(response.type).toBe('auth_ok');
    return socket;
  }

  it('authenticates bridge with correct daemon key', async () => {
    const socket = await connectSocket(socketPath);
    const key = await readDaemonKey(keyPath);
    writeFramed(socket, { type: 'auth', key: key.toString('hex') });
    const response = (await readFramed(socket)) as { type: string };
    expect(response.type).toBe('auth_ok');
    socket.destroy();
  });

  it('rejects bridge with wrong daemon key', async () => {
    const socket = await connectSocket(socketPath);
    const fakeKey = randomBytes(32);
    writeFramed(socket, { type: 'auth', key: fakeKey.toString('hex') });
    const response = (await readFramed(socket)) as { type: string; reason?: string };
    expect(response.type).toBe('auth_fail');
    socket.destroy();
  });

  it('closes socket when non-auth message sent first', async () => {
    const socket = await connectSocket(socketPath);
    writeFramed(socket, { type: 'mcp', server: 'mock', data: {} });
    // Socket should be destroyed by daemon
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Socket not closed')), 3000);
      socket.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  });

  it('responds to downstream initialize without reinitializing the upstream server', async () => {
    const socket = await authenticatedSocket();

    writeFramed(socket, {
      type: 'mcp',
      server: 'mock',
      data: {
        jsonrpc: '2.0',
        id: 10,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      },
    });

    const response = (await readFramed(socket)) as {
      type: string;
      data: {
        result: {
          protocolVersion: string;
          capabilities: Record<string, unknown>;
          serverInfo: { name: string; version: string };
        };
      };
    };

    expect(response.type).toBe('mcp');
    expect(response.data.result.protocolVersion).toBe('2024-11-05');
    expect(response.data.result.serverInfo).toEqual({ name: 'mock-mcp-server', version: '1.0.0' });
    expect(response.data.result.capabilities).toHaveProperty('tools');
    socket.destroy();
  });

  it('proxies tools/list through daemon', async () => {
    const socket = await authenticatedSocket();

    writeFramed(socket, {
      type: 'mcp',
      server: 'mock',
      data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });

    const response = (await readFramed(socket)) as {
      type: string;
      data: { result: { tools: Array<{ name: string }> } };
    };

    expect(response.type).toBe('mcp');
    const tools = response.data.result.tools.map((t) => t.name);
    expect(tools).toContain('echo');
    expect(tools).toContain('add');
    socket.destroy();
  });

  it('proxies tools/call (echo) through daemon', async () => {
    const socket = await authenticatedSocket();

    writeFramed(socket, {
      type: 'mcp',
      server: 'mock',
      data: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'echo', arguments: { message: 'hello world' } },
      },
    });

    const response = (await readFramed(socket)) as {
      type: string;
      data: { result: { content: Array<{ type: string; text: string }> } };
    };

    expect(response.type).toBe('mcp');
    expect(response.data.result.content[0].text).toBe('hello world');
    socket.destroy();
  });

  it('proxies tools/call (add) through daemon', async () => {
    const socket = await authenticatedSocket();

    writeFramed(socket, {
      type: 'mcp',
      server: 'mock',
      data: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'add', arguments: { a: 3, b: 7 } },
      },
    });

    const response = (await readFramed(socket)) as {
      type: string;
      data: { result: { content: Array<{ type: string; text: string }> } };
    };

    expect(response.type).toBe('mcp');
    expect(response.data.result.content[0].text).toBe('10');
    socket.destroy();
  });

  it('proxies resources/list through daemon', async () => {
    const socket = await authenticatedSocket();

    writeFramed(socket, {
      type: 'mcp',
      server: 'mock',
      data: { jsonrpc: '2.0', id: 4, method: 'resources/list' },
    });

    const response = (await readFramed(socket)) as {
      type: string;
      data: { result: { resources: Array<{ uri: string; name: string }> } };
    };

    expect(response.type).toBe('mcp');
    const uris = response.data.result.resources.map((r) => r.uri);
    expect(uris).toContain('test://hello');
    expect(uris).toContain('test://config');
    socket.destroy();
  });

  it('proxies resources/read through daemon', async () => {
    const socket = await authenticatedSocket();

    writeFramed(socket, {
      type: 'mcp',
      server: 'mock',
      data: {
        jsonrpc: '2.0',
        id: 5,
        method: 'resources/read',
        params: { uri: 'test://hello' },
      },
    });

    const response = (await readFramed(socket)) as {
      type: string;
      data: { result: { contents: Array<{ text: string }> } };
    };

    expect(response.type).toBe('mcp');
    expect(response.data.result.contents[0].text).toBe('Hello from mock server');
    socket.destroy();
  });

  it('returns error for unknown server', async () => {
    const socket = await authenticatedSocket();

    writeFramed(socket, {
      type: 'mcp',
      server: 'nonexistent',
      data: { jsonrpc: '2.0', id: 6, method: 'tools/list' },
    });

    const response = (await readFramed(socket)) as {
      type: string;
      data: { error: { message: string } };
    };

    expect(response.type).toBe('mcp');
    expect(response.data.error.message).toContain('Unknown server');
    socket.destroy();
  });

  it('bridge process exits non-zero when daemon key is wrong (fail-closed)', async () => {
    // Write a WRONG daemon key to a separate file
    const badKeyPath = join(tempDir, 'bad-daemon.key');
    await writeFile(badKeyPath, randomBytes(32), { mode: 0o600 });

    const helperPath = join(import.meta.dirname, '..', 'fixtures', 'bridge-connect-helper.ts');

    // Spawn the bridge helper process with the wrong key
    const bridgeProc = spawn('npx', ['tsx', helperPath, 'mock'], {
      env: {
        ...process.env,
        MCP_GUARD_TEST_SOCKET: socketPath,
        MCP_GUARD_TEST_KEY: badKeyPath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Close stdin immediately — we're testing auth failure, not MCP relay
    bridgeProc.stdin.end();

    // Capture stderr to verify auth rejection reason
    let stderr = '';
    bridgeProc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        bridgeProc.kill('SIGKILL');
        resolve(null);
      }, 10000);
      bridgeProc.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    // Bridge MUST exit 1 when auth fails and stderr must indicate auth failure
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/auth/i);
  }, 15000);
});
