import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

// Read migration files once so tests can apply them to the in-memory D1.
const migrations = await readD1Migrations('./migrations');

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          d1Databases: ['DB'],
          bindings: {
            // 32-byte base64 test KEK (test-only; never a real secret)
            PAWSCOUT_MASTER_KEY: 'dGVzdC1tYXN0ZXIta2V5LTMyLWJ5dGVzLWxvbmchIQ==',
            TEST_MIGRATIONS: migrations
          }
        }
      }
    }
  }
});
