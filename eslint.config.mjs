// @ts-check
// ESLint flat config for pawscout-worker.
//
// WHY THIS EXISTS. aramid's pre-push gate runs `node_modules/.bin/eslint -f json`
// over the changed JS/TS files and reports MISSING (skip + doctor note) when
// the binary is absent. Without eslint installed the gate skipped lint on
// every push and the repo stayed red in aramid's fleet readiness
// (`no_skip_streak`). This config exists so that gate has something to run.
//
// SCOPE. eslint's recommended set plus typescript-eslint's recommended set,
// untyped (no type-aware rules: the gate has a 60s budget per run and tsc
// already covers types via `npm run typecheck`). Overrides below are the
// minimum needed for this codebase's existing conventions; each says why.
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      'node_modules/**',
      '.wrangler/**',
      'dist/**',
      'graph-out/**',
      '.cache/**',
      '.playwright-mcp/**',
      // Agent worktrees are whole second checkouts of this repo.
      '.claude/**',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs,ts}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: {
      // Measured 2026-09-06 on the first run (482 findings, 0 parse errors):
      // 379 were `any` (342 in tests, where `{ ...env } as any` is how every
      // test hands the Worker env to a route). tsc `strict` already governs
      // typing; an eslint copy of that opinion is clutter, not a defect.
      '@typescript-eslint/no-explicit-any': 'off',
      // All 32 empty blocks were `catch {}` on a best-effort call (JSON body
      // parse with a default, optional enrichment). Swallowing on purpose is
      // the idiom here; an empty non-catch block still reports.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // All 25 hits were `let x = default; try { x = await ... } catch { ... }`:
      // the default is the fallback the catch relies on, or the catch returns.
      // Not a dead store in intent, and the rule cannot tell the difference.
      'no-useless-assignment': 'off',
      // Leading underscore marks a deliberately unused parameter or binding
      // (the codebase already does this: `_cfg`, `_ctx`, `_g`). Unused caught
      // errors are fine (`catch (e)` with no read). Everything else that is
      // unused is dead code and stays reported.
      '@typescript-eslint/no-unused-vars': ['error', {
        args: 'all',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
    },
  },
  {
    // The two Node scripts (relay/server.mjs, scripts/test-ci.mjs) use
    // process/console/Buffer; the Worker sources get their globals from
    // @cloudflare/workers-types via tsc, not from eslint.
    files: ['**/*.{mjs,cjs,js}'],
    languageOptions: { globals: globals.node },
  },
);
