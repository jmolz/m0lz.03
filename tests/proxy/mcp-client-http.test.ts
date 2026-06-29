import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerConfig } from '../../src/config/schema.js';
import { configSchema } from '../../src/config/schema.js';

// Mock the MCP SDK transport modules to verify they get instantiated correctly
vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: vi.fn().mockImplementation(function (url: URL, opts: unknown) {
    return {
    url,
    opts,
    onclose: null,
    onerror: null,
    };
  }),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(function (url: URL, opts: unknown) {
    return {
    url,
    opts,
    onclose: null,
    onerror: null,
    };
  }),
}));

vi.mock('@modelcontextprotocol/sdk/client', () => ({
  Client: vi.fn().mockImplementation(function () {
    return {
    connect: vi.fn(),
    close: vi.fn(),
    };
  }),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn().mockImplementation(function () {
    return {
    onclose: null,
    onerror: null,
    };
  }),
}));

import { createUpstreamClient } from '../../src/proxy/mcp-client.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('MCP Client HTTP Transport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeServerConfig(overrides: Partial<ServerConfig>): ServerConfig {
    return configSchema.parse({
      servers: { test: { command: 'echo', transport: 'stdio', ...overrides } },
    }).servers['test'];
  }

  it('creates SSEClientTransport for transport: sse with url', async () => {
    const config = makeServerConfig({
      transport: 'sse',
      url: 'https://mcp.example.com/sse',
    });

    const client = await createUpstreamClient('test-sse', config, mockLogger as never);
    await client.connect();

    expect(SSEClientTransport).toHaveBeenCalledWith(
      new URL('https://mcp.example.com/sse'),
      expect.objectContaining({
        requestInit: { headers: {} },
      }),
    );
  });

  it('creates StreamableHTTPClientTransport for transport: streamable-http', async () => {
    const config = makeServerConfig({
      transport: 'streamable-http',
      url: 'https://mcp.example.com/stream',
    });

    const client = await createUpstreamClient('test-http', config, mockLogger as never);
    await client.connect();

    expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
      new URL('https://mcp.example.com/stream'),
      expect.objectContaining({
        requestInit: { headers: {} },
      }),
    );
  });

  it('throws when transport is sse but no url specified', async () => {
    const config = makeServerConfig({
      transport: 'sse',
    });
    // url is undefined because we didn't set it

    const client = await createUpstreamClient('test-no-url', config, mockLogger as never);
    await expect(client.connect()).rejects.toThrow('no url specified');
  });

  it('passes Authorization header when authToken is provided', async () => {
    const config = makeServerConfig({
      transport: 'sse',
      url: 'https://mcp.example.com/sse',
    });

    const client = await createUpstreamClient('test-auth', config, mockLogger as never, {
      authToken: 'my-secret-token',
    });
    await client.connect();

    expect(SSEClientTransport).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        requestInit: { headers: { Authorization: 'Bearer my-secret-token' } },
      }),
    );
  });

  it('stdio transport still works (no regression)', async () => {
    const config = makeServerConfig({
      transport: 'stdio',
      command: 'echo',
    });

    const client = await createUpstreamClient('test-stdio', config, mockLogger as never);
    await client.connect();

    expect(StdioClientTransport).toHaveBeenCalled();
    expect(SSEClientTransport).not.toHaveBeenCalled();
    expect(StreamableHTTPClientTransport).not.toHaveBeenCalled();
  });
});
