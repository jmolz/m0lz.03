import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import type { Command } from 'commander';
import * as yaml from 'js-yaml';
import { configSchema } from '../config/schema.js';

interface DiscoveredServer {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  source: string;
}

interface ClientConfig {
  name: string;
  paths: string[];
  serverKey: string;
}

function getClientConfigs(): ClientConfig[] {
  const home = homedir();
  const os = platform();

  const configs: ClientConfig[] = [];

  // Claude Desktop
  if (os === 'darwin') {
    configs.push({
      name: 'claude-desktop',
      paths: [join(home, 'Library/Application Support/Claude/claude_desktop_config.json')],
      serverKey: 'mcpServers',
    });
  } else if (os === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData/Roaming');
    configs.push({
      name: 'claude-desktop',
      paths: [join(appData, 'Claude/claude_desktop_config.json')],
      serverKey: 'mcpServers',
    });
  }

  // Claude Code
  configs.push({
    name: 'claude-code',
    paths: [
      join(home, '.claude.json'),
      join(home, '.config/claude/settings.json'),
    ],
    serverKey: 'mcpServers',
  });

  // Cursor
  configs.push({
    name: 'cursor',
    paths: [
      join(home, '.cursor/mcp.json'),
      join(home, '.config/cursor/mcp.json'),
    ],
    serverKey: 'mcpServers',
  });

  // VS Code (Copilot)
  configs.push({
    name: 'vscode',
    paths: [
      join(home, '.vscode/mcp.json'),
    ],
    serverKey: 'servers',
  });

  // Windsurf
  configs.push({
    name: 'windsurf',
    paths: [
      join(home, '.codeium/windsurf/mcp_config.json'),
    ],
    serverKey: 'mcpServers',
  });

  return configs;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function extractServers(
  data: Record<string, unknown>,
  serverKey: string,
  source: string,
): DiscoveredServer[] {
  const serversObj = data[serverKey] as Record<string, Record<string, unknown>> | undefined;
  if (!serversObj || typeof serversObj !== 'object') return [];

  const servers: DiscoveredServer[] = [];

  for (const [name, config] of Object.entries(serversObj)) {
    if (!config || typeof config !== 'object') continue;

    const command = typeof config.command === 'string' ? config.command : undefined;
    if (!command) continue;

    const args = Array.isArray(config.args)
      ? config.args.filter((a): a is string => typeof a === 'string')
      : [];

    const env: Record<string, string> = {};
    if (config.env && typeof config.env === 'object') {
      for (const [k, v] of Object.entries(config.env as Record<string, unknown>)) {
        if (typeof v === 'string') {
          // Emit env var reference instead of raw secret value
          env[k] = `\${${k}}`;
        }
      }
    }

    servers.push({ name, command, args, env, source });
  }

  return servers;
}

function deduplicateServers(servers: DiscoveredServer[]): DiscoveredServer[] {
  const seen = new Map<string, DiscoveredServer>();

  for (const server of servers) {
    // Include env keys in dedup key so servers with different env configs aren't merged
    const envKey = Object.keys(server.env).sort().join(',');
    const key = `${server.command}:${server.args.join(',')}:${envKey}`;
    if (!seen.has(key)) {
      seen.set(key, server);
    }
  }

  return [...seen.values()];
}

function generateConfig(servers: DiscoveredServer[]): string {
  const serversObj: Record<string, Record<string, unknown>> = {};

  for (const server of servers) {
    const entry: Record<string, unknown> = {
      transport: 'stdio',
      command: server.command,
      args: server.args,
    };
    if (Object.keys(server.env).length > 0) {
      entry.env = server.env;
    }
    serversObj[server.name] = entry;
  }

  const config = {
    servers: serversObj,
    daemon: {
      log_level: 'info',
    },
  };

  return yaml.dump(config, { lineWidth: 120, forceQuotes: false });
}

function generateInstructions(servers: DiscoveredServer[]): string {
  const lines: string[] = [
    '',
    'To use MCP-Guard, update your MCP client config to route servers through the proxy:',
    '',
  ];

  const serverNames = [...new Set(servers.map((s) => s.name))];

  for (const name of serverNames) {
    lines.push(`  "${name}": {`);
    lines.push(`    "command": "mcp-guard",`);
    lines.push(`    "args": ["connect", "--server", "${name}"]`);
    lines.push(`  }`);
    lines.push('');
  }

  lines.push('The daemon auto-starts on first connection.');

  return lines.join('\n');
}

export interface InitOptions {
  output: string;
  dryRun?: boolean;
  client?: string;
}

export async function runInit(opts: InitOptions): Promise<void> {
  const clientConfigs = getClientConfigs();

  const toScan = opts.client
    ? clientConfigs.filter((c) => c.name === opts.client)
    : clientConfigs;

  if (opts.client && toScan.length === 0) {
    const validClients = clientConfigs.map((c) => c.name).join(', ');
    console.error(`Unknown client: ${opts.client}. Valid clients: ${validClients}`);
    process.exit(1);
  }

  const allServers: DiscoveredServer[] = [];

  for (const client of toScan) {
    for (const configPath of client.paths) {
      if (!(await fileExists(configPath))) continue;

      try {
        const content = await readFile(configPath, 'utf-8');
        const data = JSON.parse(content) as Record<string, unknown>;
        const servers = extractServers(data, client.serverKey, client.name);
        if (servers.length > 0) {
          console.log(`Found ${servers.length} server(s) in ${client.name} (${configPath})`);
          allServers.push(...servers);
        }
      } catch (err) {
        console.warn(`Skipping ${configPath}: ${err instanceof SyntaxError ? 'invalid JSON' : err}`);
      }
    }
  }

  if (allServers.length === 0) {
    console.log('No MCP server configurations found.');
    console.log('');
    console.log('Looked in:');
    for (const client of toScan) {
      for (const p of client.paths) {
        console.log(`  ${client.name}: ${p}`);
      }
    }
    console.log('');
    console.log('You can create a config manually — see mcp-guard.example.yaml');
    return;
  }

  const deduplicated = deduplicateServers(allServers);
  const yamlContent = generateConfig(deduplicated);

  // Validate generated config passes Zod schema
  const parsed = yaml.load(yamlContent);
  const validation = configSchema.safeParse(parsed);
  if (!validation.success) {
    console.error('Generated config failed validation (this is a bug):');
    for (const issue of validation.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }

  if (opts.dryRun) {
    console.log('---');
    process.stdout.write(yamlContent);
  } else {
    await writeFile(opts.output, yamlContent, 'utf-8');
    console.log(`Config written to ${opts.output}`);
  }

  console.log(generateInstructions(deduplicated));
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Generate mcp-guard.yaml from existing MCP client configs')
    .option('-o, --output <path>', 'Output path', 'mcp-guard.yaml')
    .option('--dry-run', 'Print config to stdout instead of writing')
    .option('--client <name>', 'Only scan a specific client (claude-desktop, claude-code, cursor, vscode, windsurf)')
    .action(async (opts: { output: string; dryRun?: boolean; client?: string }) => {
      try {
        await runInit(opts);
      } catch (err) {
        console.error(`Failed to initialize: ${err}`);
        process.exit(1);
      }
    });
}
