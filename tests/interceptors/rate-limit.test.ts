import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRateLimitInterceptor } from '../../src/interceptors/rate-limit.js';
import { createRateLimitStore, type RateLimitStore } from '../../src/storage/rate-limit-store.js';
import { openDatabase } from '../../src/storage/sqlite.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { configSchema, type McpGuardConfig } from '../../src/config/schema.js';
import type { InterceptorContext } from '../../src/interceptors/types.js';
import type Database from 'better-sqlite3-multiple-ciphers';

let db: Database.Database;
let store: RateLimitStore;

function makeConfig(overrides?: Record<string, unknown>): McpGuardConfig {
  return configSchema.parse({
    servers: {
      test: {
        command: 'echo',
        transport: 'stdio',
        policy: {
          rate_limit: {
            requests_per_minute: 5,
            tool_limits: {
              dangerous_tool: { requests_per_minute: 2 },
            },
          },
        },
        ...((overrides?.['serverOverrides'] as Record<string, unknown>) ?? {}),
      },
      other: {
        command: 'echo',
        transport: 'stdio',
        policy: {
          rate_limit: {
            requests_per_minute: 10,
          },
        },
      },
    },
    ...overrides,
  });
}

function makeContext(overrides?: Partial<InterceptorContext>): InterceptorContext {
  return {
    message: { method: 'tools/call', params: { name: 'echo' } },
    server: 'test',
    identity: { uid: 1000, username: 'testuser', roles: ['default'] },
    direction: 'request',
    metadata: { bridgeId: 'bridge-1', timestamp: Date.now() },
    ...overrides,
  };
}

describe('Rate limit interceptor', () => {
  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    runMigrations(db);
    store = createRateLimitStore(db);
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it('allows requests within rate limit', async () => {
    const config = makeConfig();
    const interceptor = createRateLimitInterceptor(store, config);

    // 5 requests should all pass (limit is 5/min)
    for (let i = 0; i < 5; i++) {
      const result = await interceptor.execute(makeContext());
      expect(result.action).toBe('PASS');
    }
  });

  it('blocks requests exceeding per-server limit', async () => {
    const config = makeConfig();
    const interceptor = createRateLimitInterceptor(store, config);

    // Exhaust the limit (5 requests)
    for (let i = 0; i < 5; i++) {
      await interceptor.execute(makeContext());
    }

    // 6th request should be blocked
    const result = await interceptor.execute(makeContext());
    expect(result.action).toBe('BLOCK');
    if (result.action === 'BLOCK') {
      expect(result.code).toBe('RATE_LIMITED');
    }
  });

  it('blocks requests exceeding per-tool limit', async () => {
    const config = makeConfig();
    const interceptor = createRateLimitInterceptor(store, config);

    const dangerousCtx = makeContext({
      message: { method: 'tools/call', params: { name: 'dangerous_tool' } },
    });

    // Tool limit is 2/min
    await interceptor.execute(dangerousCtx);
    await interceptor.execute(dangerousCtx);

    // 3rd request for this tool should be blocked
    const result = await interceptor.execute(dangerousCtx);
    expect(result.action).toBe('BLOCK');
    if (result.action === 'BLOCK') {
      expect(result.reason).toContain('dangerous_tool');
    }
  });

  it('tokens refill over time', async () => {
    const config = makeConfig();
    const interceptor = createRateLimitInterceptor(store, config);

    // Exhaust limit
    for (let i = 0; i < 5; i++) {
      await interceptor.execute(makeContext());
    }

    // Should be blocked
    let result = await interceptor.execute(makeContext());
    expect(result.action).toBe('BLOCK');

    // Manually advance time by manipulating the DB record
    // refill rate is 5/60 ≈ 0.083 tokens/sec, so 12 seconds = 1 token
    db.prepare("UPDATE rate_limits SET last_refill = datetime('now', '-15 seconds') WHERE key LIKE '%rpm'").run();

    // Should pass now (refilled ~1.25 tokens)
    result = await interceptor.execute(makeContext());
    expect(result.action).toBe('PASS');
  });

  it('uses millisecond refill timestamps so rapid bursts do not over-refill', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.900Z'));

    const key = 'server:test:testuser:rapid-burst';
    const limit = { maxTokens: 2, refillRate: 1 };

    expect(store.tryConsume(key, limit)).toBe(true);
    const row = db.prepare('SELECT last_refill FROM rate_limits WHERE key = ?').get(key) as
      | { last_refill: string }
      | undefined;
    expect(row?.last_refill).toBe('2026-01-01T00:00:00.900Z');

    vi.setSystemTime(new Date('2026-01-01T00:00:00.910Z'));
    expect(store.tryConsume(key, limit)).toBe(true);

    vi.setSystemTime(new Date('2026-01-01T00:00:00.920Z'));
    expect(store.tryConsume(key, limit)).toBe(false);
    expect(store.getRemaining(key)).toBeLessThan(1);
  });

  it('different servers have independent limits', async () => {
    const config = makeConfig();
    const interceptor = createRateLimitInterceptor(store, config);

    // Exhaust test server limit (5/min)
    for (let i = 0; i < 5; i++) {
      await interceptor.execute(makeContext());
    }

    // Test server should be blocked
    const blockedResult = await interceptor.execute(makeContext());
    expect(blockedResult.action).toBe('BLOCK');

    // Other server should still work (10/min limit)
    const otherResult = await interceptor.execute(makeContext({ server: 'other' }));
    expect(otherResult.action).toBe('PASS');
  });

  it('different users have independent limits', async () => {
    const config = makeConfig();
    const interceptor = createRateLimitInterceptor(store, config);

    // Exhaust user1 limit
    for (let i = 0; i < 5; i++) {
      await interceptor.execute(makeContext());
    }

    // user1 blocked
    const blockedResult = await interceptor.execute(makeContext());
    expect(blockedResult.action).toBe('BLOCK');

    // user2 should still pass
    const user2Result = await interceptor.execute(
      makeContext({ identity: { uid: 1001, username: 'user2', roles: ['default'] } }),
    );
    expect(user2Result.action).toBe('PASS');
  });

  it('no configured rate limit → PASS', async () => {
    const config = configSchema.parse({
      servers: {
        noLimit: { command: 'echo', transport: 'stdio' },
      },
    });
    const interceptor = createRateLimitInterceptor(store, config);

    const result = await interceptor.execute(makeContext({ server: 'noLimit' }));
    expect(result.action).toBe('PASS');
  });

  it('rate limit state persists across interceptor calls', async () => {
    const config = makeConfig();
    const interceptor1 = createRateLimitInterceptor(store, config);

    // Use 3 tokens with first interceptor instance
    for (let i = 0; i < 3; i++) {
      await interceptor1.execute(makeContext());
    }

    // Create a new interceptor instance (simulating daemon restart with same DB)
    const interceptor2 = createRateLimitInterceptor(store, config);

    // Use 2 more tokens
    await interceptor2.execute(makeContext());
    await interceptor2.execute(makeContext());

    // 6th total request should be blocked
    const result = await interceptor2.execute(makeContext());
    expect(result.action).toBe('BLOCK');
  });
});
