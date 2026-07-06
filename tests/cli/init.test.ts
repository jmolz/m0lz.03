import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as yaml from 'js-yaml';
import { configSchema } from '../../src/config/schema.js';

// Mock fs/promises before importing the module under test
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  access: vi.fn(),
}));

// Mock os so init always sees darwin paths — tests use macOS fixture paths
vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>();
  return {
    ...orig,
    platform: () => 'darwin',
    homedir: () => process.env.HOME ?? '/tmp',
  };
});

// Import after mocks are set up
import { readFile, writeFile, access } from 'node:fs/promises';
import { runInit } from '../../src/cli/init.js';

const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockAccess = vi.mocked(access);

/** Sample Claude Desktop config */
const claudeDesktopConfig = {
  mcpServers: {
    filesystem: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    },
    github: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: 'ghp_test' },
    },
  },
};

/** Sample Cursor config */
const cursorConfig = {
  mcpServers: {
    memory: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
    },
  },
};

function setupMockFiles(files: Record<string, string>): void {
  mockAccess.mockImplementation(async (path) => {
    if (typeof path === 'string' && files[path] !== undefined) return;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });

  mockReadFile.mockImplementation(async (path, _encoding) => {
    const content = files[typeof path === 'string' ? path : ''];
    if (content !== undefined) return content;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });

  mockWriteFile.mockResolvedValue(undefined);
}

describe('mcp-guard init', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('discovers servers from Claude Desktop config', async () => {
    const home = process.env.HOME ?? '';
    setupMockFiles({
      [`${home}/Library/Application Support/Claude/claude_desktop_config.json`]:
        JSON.stringify(claudeDesktopConfig),
    });

    await runInit({ output: 'test.yaml', dryRun: true });

    const output = consoleLogSpy.mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(output).toContain('Found 2 server(s) in claude-desktop');
    expect(output).toContain('filesystem');
    expect(output).toContain('github');
  });

  it('discovers servers from Cursor config', async () => {
    const home = process.env.HOME ?? '';
    setupMockFiles({
      [`${home}/.cursor/mcp.json`]: JSON.stringify(cursorConfig),
    });

    await runInit({ output: 'test.yaml', dryRun: true });

    const output = consoleLogSpy.mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(output).toContain('Found 1 server(s) in cursor');
    expect(output).toContain('memory');
  });

  it('deduplicates servers with same command+args across clients', async () => {
    const home = process.env.HOME ?? '';
    const duplicateConfig = {
      mcpServers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        },
      },
    };

    setupMockFiles({
      [`${home}/Library/Application Support/Claude/claude_desktop_config.json`]:
        JSON.stringify(claudeDesktopConfig),
      [`${home}/.cursor/mcp.json`]: JSON.stringify(duplicateConfig),
    });

    await runInit({ output: 'test.yaml', dryRun: true });

    // stdout.write is used for YAML output in dry-run mode
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runInit({ output: 'test.yaml', dryRun: true });

    const yamlOutput = stdoutSpy.mock.calls.map((c) => c[0]).join('');
    const parsed = yaml.load(yamlOutput) as Record<string, unknown>;
    const servers = parsed.servers as Record<string, unknown>;

    // filesystem should appear only once despite being in both configs
    const serverNames = Object.keys(servers);
    const fsCount = serverNames.filter((n) => n === 'filesystem').length;
    expect(fsCount).toBe(1);

    stdoutSpy.mockRestore();
  });

  it('generates Zod-valid YAML with env var placeholders instead of raw secrets', async () => {
    const home = process.env.HOME ?? '';
    setupMockFiles({
      [`${home}/Library/Application Support/Claude/claude_desktop_config.json`]:
        JSON.stringify(claudeDesktopConfig),
    });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runInit({ output: 'test.yaml', dryRun: true });

    const yamlOutput = stdoutSpy.mock.calls.map((c) => c[0]).join('');
    const parsed = yaml.load(yamlOutput);
    const result = configSchema.safeParse(parsed);
    expect(result.success).toBe(true);

    // Env values should be ${VAR} placeholders, not raw secrets
    const servers = parsed as Record<string, Record<string, Record<string, Record<string, string>>>>;
    const githubEnv = servers.servers?.github?.env;
    expect(githubEnv?.GITHUB_TOKEN).toBe('${GITHUB_TOKEN}');
    expect(githubEnv?.GITHUB_TOKEN).not.toBe('ghp_test');

    stdoutSpy.mockRestore();
  });

  it('prints to stdout in dry-run mode and does not write file', async () => {
    const home = process.env.HOME ?? '';
    setupMockFiles({
      [`${home}/Library/Application Support/Claude/claude_desktop_config.json`]:
        JSON.stringify(claudeDesktopConfig),
    });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runInit({ output: 'test.yaml', dryRun: true });

    expect(stdoutSpy).toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();

    stdoutSpy.mockRestore();
  });

  it('prints helpful message when no configs found', async () => {
    setupMockFiles({}); // No files exist

    await runInit({ output: 'test.yaml' });

    const output = consoleLogSpy.mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(output).toContain('No MCP server configurations found');
    expect(output).toContain('mcp-guard.example.yaml');
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('filters by client when --client is specified', async () => {
    const home = process.env.HOME ?? '';
    setupMockFiles({
      [`${home}/Library/Application Support/Claude/claude_desktop_config.json`]:
        JSON.stringify(claudeDesktopConfig),
      [`${home}/.cursor/mcp.json`]: JSON.stringify(cursorConfig),
    });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runInit({ output: 'test.yaml', dryRun: true, client: 'cursor' });

    const output = consoleLogSpy.mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(output).toContain('cursor');
    expect(output).not.toContain('claude-desktop');

    const yamlOutput = stdoutSpy.mock.calls.map((c) => c[0]).join('');
    const parsed = yaml.load(yamlOutput) as Record<string, unknown>;
    const servers = parsed.servers as Record<string, unknown>;
    expect(Object.keys(servers)).toEqual(['memory']);

    stdoutSpy.mockRestore();
  });

  it('skips corrupted config files with a warning', async () => {
    const home = process.env.HOME ?? '';
    setupMockFiles({
      [`${home}/Library/Application Support/Claude/claude_desktop_config.json`]:
        '{invalid json!!!',
      [`${home}/.cursor/mcp.json`]: JSON.stringify(cursorConfig),
    });

    await runInit({ output: 'test.yaml', dryRun: true });

    const warnOutput = consoleWarnSpy.mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(warnOutput).toContain('invalid JSON');

    const logOutput = consoleLogSpy.mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(logOutput).toContain('Found 1 server(s) in cursor');
  });

  it('writes config file when not in dry-run mode', async () => {
    const home = process.env.HOME ?? '';
    setupMockFiles({
      [`${home}/.cursor/mcp.json`]: JSON.stringify(cursorConfig),
    });

    await runInit({ output: 'my-config.yaml' });

    expect(mockWriteFile).toHaveBeenCalledWith(
      'my-config.yaml',
      expect.any(String),
      'utf-8',
    );
  });

  it('never writes to client config paths', async () => {
    const home = process.env.HOME ?? '';
    const clientConfigPaths = [
      `${home}/Library/Application Support/Claude/claude_desktop_config.json`,
      `${home}/.claude.json`,
      `${home}/.config/claude/settings.json`,
      `${home}/.cursor/mcp.json`,
      `${home}/.config/cursor/mcp.json`,
      `${home}/.vscode/mcp.json`,
      `${home}/.codeium/windsurf/mcp_config.json`,
    ];

    setupMockFiles({
      [`${home}/Library/Application Support/Claude/claude_desktop_config.json`]:
        JSON.stringify(claudeDesktopConfig),
      [`${home}/.cursor/mcp.json`]: JSON.stringify(cursorConfig),
    });

    await runInit({ output: 'my-config.yaml' });

    // Verify writeFile was called only once, with the output path
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const writtenPath = mockWriteFile.mock.calls[0][0] as string;
    for (const clientPath of clientConfigPaths) {
      expect(writtenPath).not.toBe(clientPath);
    }
  });
});
