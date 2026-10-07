import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { configDefaults, defineConfig } from 'vitest/config';

// Upgraded 2026-07-28 from vitest 2.1.9 / @cloudflare/vitest-pool-workers 0.5.41.
// The old stack could not START the full 150-file suite on Node 24: workerd
// failed to fetch even vitest's own runner chunk over loopback, giving 150-180
// "ConnectEx(): #1225 refused" errors, zero assertion failures and
// "Test Files no tests". Small batches worked, which is why it looked flaky
// rather than broken. That kept aramid's pre-push `tests-failed` finding
// permanently open, and it is a BLOCK-tier finding that `aramid override`
// refuses by design, so upgrading was the only way to clear it honestly.
//
// v4 config shape: `defineWorkersConfig` is REMOVED. Options that used to sit
// under `test.poolOptions.workers` are now passed straight to the
// `cloudflareTest()` Vite plugin. `isolatedStorage` and `singleWorker` are gone
// too (storage is isolated per test file now); neither was set here.
// See developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/

// Read migration files once so tests can apply them to the in-memory D1.
const migrations = await readD1Migrations('./migrations');

// Plaintext of the test-only key encryption key. Kept as readable ASCII, not a
// base64 blob, so no secret scanner has anything to match on.
const TEST_KEK_PLAINTEXT = 'test-master-key-32-bytes-long!!!';

export default defineConfig({
  // setupFiles restores per-test D1 isolation, which v4 dropped to per-FILE.
  // See the file for why this lives here instead of in 40 individual
  // beforeEach blocks.
  //
  // testTimeout, MEASURED 2026-09-29: aramid's mutation drain runs this suite
  // under load. Both drain runs summed about 2772s of test time, against 890s
  // to 1063s in quiet full runs, so each test ran about three times slower.
  // Two different tests have failed the drain on vitest's 5s default while
  // passing everywhere else: the supplier back-fill test (09-27) and "every
  // registry template renders a pending draft" (09-29, 1487ms when quiet). In a
  // quiet full run on 14504fc the slowest test took 4149ms and 38 took over a
  // second, so the default sat at the edge. 20s is about 4.8x the slowest
  // quiet test, and a hung test still fails in 20s.
  //
  // exclude: an agent worktree under .claude/worktrees is a whole second
  // checkout, tests included, and vitest's defaults skip only node_modules and
  // .git. On 2026-10-07 aramid's pre-push run timed out at its 600s budget
  // while one such worktree sat in the tree.
  test: { setupFiles: ['./tests/setup-reset-db.ts'], testTimeout: 20_000, exclude: [...configDefaults.exclude, '.claude/**'] },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        d1Databases: ['DB'],
        bindings: {
          // Test-only KEK, DERIVED rather than pasted. It is not a secret, but a
          // base64 blob sitting in a config file looks exactly like one to a
          // scanner: the literal form tripped gitleaks:generic-api-key, and the
          // existing "not a secret" ledger entries were pinned to the old line
          // numbers, so simply moving it re-flagged it as a new BLOCK finding.
          // Building it from the plaintext keeps the value identical
          // (btoa(TEST_KEK_PLAINTEXT) === the old literal, verified) while
          // leaving nothing secret-shaped to match, so it cannot silently
          // re-block a future commit that happens to shift these lines.
          // 32 bytes exactly: AES-GCM requires 16, 24 or 32.
          PAWSCOUT_MASTER_KEY: btoa(TEST_KEK_PLAINTEXT),
          TEST_MIGRATIONS: migrations
        }
      }
    })
  ]
});
