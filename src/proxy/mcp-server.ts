import type { JsonRpcMessage } from '../bridge/types.js';
import type { UpstreamClient } from './mcp-client.js';
import type { Logger } from '../logger.js';

const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
] as const;
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export interface ProxyServer {
  handleMessage(message: JsonRpcMessage, serverName: string): Promise<JsonRpcMessage>;
}

export function createProxyServer(
  upstreamClients: Map<string, UpstreamClient>,
  logger: Logger,
): ProxyServer {
  async function handleMessage(
    message: JsonRpcMessage,
    serverName: string,
  ): Promise<JsonRpcMessage> {
    const upstream = upstreamClients.get(serverName);
    if (!upstream) {
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32600, message: `Unknown server: ${serverName}` },
      };
    }

    if (upstream.status !== 'connected') {
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32603, message: `Server '${serverName}' is not connected` },
      };
    }

    const { method, params, id } = message;
    if (!method) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32600, message: 'Missing method in request' },
      };
    }

    try {
      const result = await routeMethod(upstream, method, params);
      return { jsonrpc: '2.0', id, result };
    } catch (err) {
      logger.error('Upstream request failed', {
        server: serverName,
        method,
        error: String(err),
      });
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: `Upstream error: ${String(err)}` },
      };
    }
  }

  return { handleMessage };
}

async function routeMethod(
  upstream: UpstreamClient,
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const client = upstream.client;

  switch (method) {
    case 'initialize': {
      const requestedVersion =
        typeof params?.['protocolVersion'] === 'string' ? params['protocolVersion'] : undefined;
      const protocolVersion =
        requestedVersion &&
        (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requestedVersion)
          ? requestedVersion
          : LATEST_PROTOCOL_VERSION;
      const instructions = client.getInstructions();

      return {
        protocolVersion,
        capabilities: client.getServerCapabilities() ?? {},
        serverInfo: client.getServerVersion() ?? {
          name: `mcp-guard-upstream-${upstream.name}`,
          version: 'unknown',
        },
        ...(instructions ? { instructions } : {}),
      };
    }

    case 'ping':
      return await client.ping();

    case 'tools/list':
      return await client.listTools(params as Parameters<typeof client.listTools>[0]);

    case 'tools/call':
      return await client.callTool(params as Parameters<typeof client.callTool>[0]);

    case 'resources/list':
      return await client.listResources(params as Parameters<typeof client.listResources>[0]);

    case 'resources/read':
      return await client.readResource(params as Parameters<typeof client.readResource>[0]);

    case 'resources/list_templates':
      return await client.listResourceTemplates(
        params as Parameters<typeof client.listResourceTemplates>[0],
      );

    case 'prompts/list':
      return await client.listPrompts(params as Parameters<typeof client.listPrompts>[0]);

    case 'prompts/get':
      return await client.getPrompt(params as Parameters<typeof client.getPrompt>[0]);

    default:
      // Notifications and unknown methods
      if (method.startsWith('notifications/')) {
        await client.notification({ method, params } as Parameters<typeof client.notification>[0]);
        return undefined;
      }

      throw new Error(`Method not found: ${method}`);
  }
}
