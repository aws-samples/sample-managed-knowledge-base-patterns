import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

const sharedRules = {
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/no-unused-vars': [
    'error',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
  ],
  '@typescript-eslint/ban-ts-comment': 'error',
};

export default tseslint.config(
  {
    ignores: ['dist/**', 'eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...sharedRules,
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': 'warn',
      // Console statements leak into production and are an easy way to log an embed
      // URL, which is a bearer credential, to the browser console by accident.
      'no-console': 'error',
      // The browser must never hold AWS credentials or call AWS directly. Everything
      // AWS-facing goes through the harness, which is the boundary the README describes.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['aws-sdk', 'aws-sdk/*', '@aws-sdk/*'],
              message:
                'The browser must not depend on an AWS SDK. Mint embed URLs in the harness (server/).',
            },
          ],
        },
      ],
    },
  },
  {
    // Node-side: the harness and the sharing check are CLIs whose output is the point.
    files: ['server/**/*.ts', 'scripts/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: sharedRules,
  },
);
