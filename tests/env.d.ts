/// <reference types="@cloudflare/vitest-pool-workers" />
import type { D1Migration } from '@cloudflare/vitest-pool-workers/config';

// Test-only bindings provided by the Workers pool (vitest.config.ts).
// The reference directive above pulls in the base `cloudflare:test` module types
// project-wide (tsconfig pins `types` to workers-types, which suppresses auto-discovery).
declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    PAWSCOUT_MASTER_KEY: string;
    TEST_MIGRATIONS: D1Migration[];
  }
}
