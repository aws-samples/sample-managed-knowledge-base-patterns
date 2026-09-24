import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': 'warn',

      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/ban-ts-comment': 'error',

      // Console statements leak into production and are an easy way to log a
      // token to the browser console by accident.
      'no-console': 'error',

      // The frontend must not import an AWS SDK. Pulling one in to borrow
      // response types couples the UI to a specific retrieval backend. UI types come
      // from the backend's domain DTOs.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['aws-sdk', 'aws-sdk/*', '@aws-sdk/*'],
              message:
                'The frontend must not depend on an AWS SDK. Use the domain DTOs exposed by the backend API.',
            },
          ],
        },
      ],
    },
  },
);
