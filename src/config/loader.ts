import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { configSchema, type McpGuardConfig } from './schema.js';
import { ConfigError } from '../errors.js';
import { fetchBaseConfig } from './fetcher.js';
import { mergeConfigs } from './merger.js';
import { DEFAULT_EXTENDS_CACHE_DIR } from '../constants.js';

function interpolateEnvVars(content: string): string {
  return content.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    const value = process.env[varName];
    if (value === undefined) {
      throw new ConfigError(`Unresolved environment variable: \${${varName}}`);
    }
    return value;
  });
}

function parseAndValidate(content: string, source: string): McpGuardConfig {
  const interpolated = interpolateEnvVars(content);
  const raw = yaml.load(interpolated);

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new ConfigError(`Invalid config (${source}):\n${issues}`);
  }

  return result.data;
}

export async function loadConfig(configPath?: string): Promise<McpGuardConfig> {
  const path = configPath ?? process.env['MCP_GUARD_CONFIG'] ?? 'mcp-guard.yaml';

  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new ConfigError(`Config file not found: ${path}`);
    }
    throw new ConfigError(`Failed to read config file: ${path} — ${String(err)}`);
  }

  const personalConfig = parseAndValidate(content, path);

  // If config has extends, fetch base and merge
  if (personalConfig.extends) {
    const cacheDir = join(personalConfig.daemon.home, DEFAULT_EXTENDS_CACHE_DIR);
    const { yaml: baseYaml } = await fetchBaseConfig(
      personalConfig.extends.url,
      personalConfig.extends.sha256,
      cacheDir,
    );

    const baseConfig = parseAndValidate(baseYaml, personalConfig.extends.url);
    const merged = mergeConfigs(baseConfig, personalConfig);
    return Object.freeze(merged) as McpGuardConfig;
  }

  return Object.freeze(personalConfig) as McpGuardConfig;
}

// Cache the last resolved base config to avoid re-fetching on every hot reload.
// The cache is keyed by sha256 — if the personal config changes its extends.sha256,
// the base is re-fetched. If only policy fields change, the cached base is reused.
let cachedBase: { sha256: string; config: McpGuardConfig } | undefined;

/**
 * Reload config from disk. Reuses the cached base config if the extends
 * sha256 hasn't changed, avoiding a network round-trip on every file save.
 */
export async function reloadConfig(configPath: string): Promise<McpGuardConfig> {
  const path = configPath;

  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new ConfigError(`Config file not found: ${path}`);
    }
    throw new ConfigError(`Failed to read config file: ${path} — ${String(err)}`);
  }

  const personalConfig = parseAndValidate(content, path);

  if (personalConfig.extends) {
    const sha256 = personalConfig.extends.sha256;

    // Reuse cached base if sha256 matches (avoids network fetch)
    if (cachedBase && cachedBase.sha256 === sha256) {
      const merged = mergeConfigs(cachedBase.config, personalConfig);
      return Object.freeze(merged) as McpGuardConfig;
    }

    // sha256 changed or no cache — full fetch
    const cacheDir = join(personalConfig.daemon.home, DEFAULT_EXTENDS_CACHE_DIR);
    const { yaml: baseYaml } = await fetchBaseConfig(
      personalConfig.extends.url,
      sha256,
      cacheDir,
    );

    const baseConfig = parseAndValidate(baseYaml, personalConfig.extends.url);
    cachedBase = { sha256, config: baseConfig };
    const merged = mergeConfigs(baseConfig, personalConfig);
    return Object.freeze(merged) as McpGuardConfig;
  }

  cachedBase = undefined;
  return Object.freeze(personalConfig) as McpGuardConfig;
}
