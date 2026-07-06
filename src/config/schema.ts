import { z } from 'zod';
import {
  DEFAULT_SOCKET_PATH,
  DEFAULT_HOME,
  DEFAULT_DASHBOARD_PORT,
} from '../constants.js';

export const permissionsSchema = z.object({
  allowed_tools: z.array(z.string()).optional(),
  denied_tools: z.array(z.string()).default([]),
  allowed_resources: z.array(z.string()).optional(),
  denied_resources: z.array(z.string()).default([]),
}).prefault({});

export const rateLimitSchema = z.object({
  requests_per_minute: z.number().min(1).optional(),
  requests_per_hour: z.number().min(1).optional(),
  tool_limits: z.record(z.string(), z.object({
    requests_per_minute: z.number().min(1).optional(),
  })).default({}),
}).prefault({});

export const policySchema = z.object({
  permissions: permissionsSchema,
  rate_limit: rateLimitSchema,
  sampling: z.object({
    enabled: z.boolean().default(false),
    max_tokens: z.number().min(1).optional(),
    rate_limit: z.number().min(1).optional(),
    audit: z.enum(['basic', 'verbose']).default('basic'),
  }).prefault({}),
  locked: z.boolean().default(false),
}).prefault({});

export const serverSchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  url: z.string().url().optional(),
  transport: z.enum(['stdio', 'sse', 'streamable-http']).default('stdio'),
  /** Bearer token for authenticating MCP-Guard to the upstream HTTP server.
   *  Use env var interpolation for security: upstream_auth_token: "${MCP_AUTH_TOKEN}" */
  upstream_auth_token: z.string().optional(),
  policy: policySchema,
});

export const daemonSchema = z.object({
  socket_path: z.string().default(DEFAULT_SOCKET_PATH),
  home: z.string().default(DEFAULT_HOME),
  shutdown_timeout: z.number().min(1).default(30),
  log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  dashboard_port: z.number().min(0).max(65535).default(DEFAULT_DASHBOARD_PORT),
  encryption: z.object({
    enabled: z.boolean().default(false),
  }).prefault({}),
}).prefault({});

export const claimsToRolesSchema = z.object({
  claim_name: z.string().default('roles'),
  mapping: z.record(z.string(), z.array(z.string())).default({}),
}).prefault({});

export const oauthSchema = z.object({
  issuer: z.string().url(),
  jwks_uri: z.string().url().optional(),
  audience: z.string().optional(),
  client_id: z.string(),
  client_secret: z.string().optional(),
  scopes: z.array(z.string()).default(['openid', 'profile']),
  claims_to_roles: claimsToRolesSchema,
  clock_tolerance_seconds: z.number().min(0).max(300).default(30),
});

export const authSchema = z.object({
  mode: z.enum(['os', 'api_key', 'oauth']).default('os'),
  api_keys: z.record(z.string(), z.object({
    roles: z.array(z.string()).default(['default']),
  })).default({}),
  oauth: oauthSchema.optional(),
  roles: z.record(z.string(), z.object({
    permissions: permissionsSchema,
    rate_limit: rateLimitSchema,
  })).default({}),
}).prefault({}).refine((auth) => {
  if (auth.mode === 'oauth' && !auth.oauth) {
    return false;
  }
  return true;
}, { message: 'auth.oauth config required when mode is "oauth"' });

export const interceptorConfigSchema = z.object({
  timeout: z.number().min(1).default(10),
  timeout_action: z.enum(['block']).default('block'),
}).prefault({});

const piiActionSchema = z.enum(['block', 'redact', 'warn']);

const piiTypeActionsSchema = z.object({
  request: piiActionSchema.default('redact'),
  response: piiActionSchema.default('warn'),
});

const customPiiTypeSchema = z.object({
  label: z.string(),
  patterns: z.array(z.object({ regex: z.string() })).min(1),
  actions: piiTypeActionsSchema,
});

export const piiSchema = z.object({
  enabled: z.boolean().default(true),
  confidence_threshold: z.number().min(0).max(1).default(0.8),
  actions: z.record(z.string(), piiTypeActionsSchema).default({
    email: { request: 'redact', response: 'warn' },
    phone: { request: 'redact', response: 'warn' },
    ssn: { request: 'block', response: 'redact' },
    credit_card: { request: 'block', response: 'redact' },
    aws_key: { request: 'redact', response: 'redact' },
    github_token: { request: 'redact', response: 'redact' },
  }),
  custom_types: z.record(z.string(), customPiiTypeSchema).default({}),
}).prefault({});

export const auditSchema = z.object({
  enabled: z.boolean().default(true),
  stdout: z.boolean().default(true),
  retention_days: z.number().min(1).default(90),
}).prefault({});

export const extendsSchema = z.object({
  url: z.string().url().refine((url) => {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return true;
    // Allow HTTP only for loopback addresses (development/testing)
    if (parsed.protocol === 'http:') {
      const host = parsed.hostname;
      return host === '127.0.0.1' || host === 'localhost' || host === '::1';
    }
    return false;
  }, 'extends URL must use HTTPS (HTTP allowed only for loopback addresses)'),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i, 'SHA-256 hash must be 64 hex characters'),
});

export const configSchema = z.object({
  extends: extendsSchema.optional(),
  servers: z.record(z.string(), serverSchema),
  daemon: daemonSchema,
  auth: authSchema,
  interceptors: interceptorConfigSchema,
  pii: piiSchema,
  audit: auditSchema,
});

export type McpGuardConfig = z.infer<typeof configSchema>;
export type ServerConfig = z.infer<typeof serverSchema>;
export type DaemonConfig = z.infer<typeof daemonSchema>;
export type PolicyConfig = z.infer<typeof policySchema>;
export type PermissionsConfig = z.infer<typeof permissionsSchema>;
export type RateLimitConfig = z.infer<typeof rateLimitSchema>;
export type AuthConfig = z.infer<typeof authSchema>;
export type PIIConfig = z.infer<typeof piiSchema>;
export type SamplingConfig = z.infer<typeof policySchema>['sampling'];
export type AuditConfig = z.infer<typeof auditSchema>;
export type ExtendsConfig = z.infer<typeof extendsSchema>;
export type OAuthConfig = z.infer<typeof oauthSchema>;
export type ClaimsToRolesConfig = z.infer<typeof claimsToRolesSchema>;
