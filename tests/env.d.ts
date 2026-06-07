import type { D1Migration } from '@cloudflare/vitest-pool-workers/config';

// Test-only bindings provided by the Workers pool (vitest.config.ts).
declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    PAWSCOUT_MASTER_KEY: string;
    TEST_MIGRATIONS: D1Migration[];
  }
}
