// The package was renamed from @cloudflare/vitest-pool-workers at its 1.0.0
// (upgraded here 2026-11-12). It has no `/config` subpath; D1Migration is
// exported from the main entry instead. That import also brings in the
// package's types, so the old `/// <reference types>` line went: with the
// import and the reference naming the same package, lint rejects the reference
// (@typescript-eslint/triple-slash-reference).
import type { D1Migration } from '@cloudflare/vitest-plugin';

// Test-only bindings provided by the Workers pool (vitest.config.ts).
//
// TWO declarations on purpose, because v0.18 changed how `env` is typed. v0.5
// typed it as `ProvidedEnv`, so augmenting that interface alone was enough. v4
// resolves it to the GLOBAL `Env` interface (normally generated into
// worker-configuration.d.ts, which this repo does not have), so without the
// global merge below every test file fails tsc with
// "Property 'DB' does not exist on type 'Env'". Keeping both means the file is
// correct under either resolution and does not silently rot if it changes back.
// v4 declares `export const env: Cloudflare.Env` (see
// node_modules/@cloudflare/vitest-plugin/types/cloudflare-test.d.ts), so
// the namespaced interface is what has to carry the bindings. `ProvidedEnv`,
// which v0.5 used and which every migration note still mentions, is no longer
// referenced by the `env` export at all: augmenting it compiles fine and does
// nothing, which is why the first two attempts at this looked correct and left
// all 862 errors in place.
declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      PAWSCOUT_MASTER_KEY: string;
      TEST_MIGRATIONS: D1Migration[];
      // Inbound email files (design 2026-11-14), bound from wrangler.toml.
      INBOX_FILES: R2Bucket;
    }
  }
}
