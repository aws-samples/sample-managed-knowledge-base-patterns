import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['cdk.out/**', 'dist/**', 'eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['{bin,lib,test,scripts}/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/ban-ts-comment': 'error',
      'no-console': 'error',

      // CDK constructs are routinely instantiated for their side effect on the
      // construct tree, so `new Foo(this, 'Id', {...})` without assignment is
      // idiomatic rather than a mistake.
      'no-new': 'off',
    },
  },
);
