import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import prettierRecommended from 'eslint-plugin-prettier/recommended';

/**
 * Bedrock SDK packages that stay inside the provider layer.
 *
 * SDK types spread easily into shared request interfaces and frontend type
 * modules. Keeping them inside `src/providers/` gives the rest of the backend a
 * small, stable domain contract, and keeps every call to the Bedrock SDK in one
 * place. That place is also where the user's identity is attached to outbound
 * calls, so a narrow boundary keeps the security-relevant surface easy to
 * review. It is enforced here rather than left to convention. See SECURITY.md.
 */
const NO_VENDOR_SDK = {
  group: [
    '@aws-sdk/client-bedrock-agent',
    '@aws-sdk/client-bedrock-agent-runtime',
    '@aws-sdk/client-bedrock-agent/*',
    '@aws-sdk/client-bedrock-agent-runtime/*',
  ],
  message:
    'Bedrock SDK clients may only be imported under src/providers/. ' +
    'Depend on the RetrievalProvider port and domain DTOs instead. See SECURITY.md.',
};

/**
 * Test doubles must not reach production code.
 *
 * Test doubles stay out of production code so fixture data never ships in the
 * production build. Enforcing it here means the rule does not depend on how
 * clearly a fake is named.
 */
const NO_TEST_DOUBLES = {
  group: ['**/domain/testing', '**/domain/testing/**', '**/testing/*'],
  message:
    'Test doubles from domain/testing/ may only be imported by *.spec.ts files. ' +
    'Production code depends on the RetrievalProvider port; the concrete ' +
    'implementation is bound in the application module.',
};

/**
 * Builds a complete `no-restricted-imports` option set.
 *
 * Flat config *replaces* rule options rather than merging them, so two blocks
 * matching the same file cannot each contribute one pattern — the later block
 * wins outright. Every block below therefore declares the full list that applies
 * to the files it owns, and the blocks are scoped so their file sets do not
 * overlap. Getting this wrong silently disables a restriction, which is why the
 * combinations are covered by scripts/check-import-boundaries.sh.
 */
const restrictImports = (...patterns) => ({
  'no-restricted-imports': ['error', { patterns }],
});

const PRODUCTION = ['src/**/*.ts'];
const SPECS = ['src/**/*.spec.ts'];
const PROVIDERS = ['src/providers/**/*.ts'];
const TEST_DOUBLES = ['src/domain/testing/**/*.ts'];

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettierRecommended,
  {
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'module',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Decorator metadata and Nest's DI make a few of the type-checked rules
      // noisy without indicating a defect. Everything else stays on.
      '@typescript-eslint/interface-name-prefix': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',

      // `any` erases the type safety the domain model exists to provide.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',

      // An un-awaited promise inside a try/catch makes the catch unreachable,
      // which silently disables error handling on any path that does it.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // Suppression comments hide the problem instead of fixing it.
      '@typescript-eslint/ban-ts-comment': 'error',

      // Logs are not an output channel for a service. Use the Nest logger.
      'no-console': 'error',
    },
  },

  // Ordinary production code: no Bedrock SDK imports, no test doubles.
  {
    files: PRODUCTION,
    ignores: [...PROVIDERS, ...SPECS, ...TEST_DOUBLES],
    rules: restrictImports(NO_VENDOR_SDK, NO_TEST_DOUBLES),
  },

  // The provider layer is where the Bedrock SDK is called, so only the
  // test-double restriction applies.
  {
    files: PROVIDERS,
    ignores: SPECS,
    rules: restrictImports(NO_TEST_DOUBLES),
  },

  // The fakes themselves must stay SDK-free — a test double that imports the
  // real SDK is not a double.
  {
    files: TEST_DOUBLES,
    rules: restrictImports(NO_VENDOR_SDK),
  },

  // Specs may import test doubles. Outside the provider layer they still must not
  // import the Bedrock SDK; provider specs legitimately assert on SDK shapes, so
  // they are exempt.
  {
    files: SPECS,
    ignores: PROVIDERS,
    rules: restrictImports(NO_VENDOR_SDK),
  },
  {
    files: PROVIDERS.map((pattern) => pattern.replace('**/*.ts', '**/*.spec.ts')),
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: SPECS,
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
