import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'src/generated/'] },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Promise-shaped test doubles often resolve synchronously; requiring a fake
    // await would not make them more faithful to the API they implement.
    files: ['test/**/*.ts'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },
  {
    // Test fixtures and doubles: mock() assignments are untyped by design,
    // object-literal methods stand in for framework interfaces, and sentinel
    // values (strings) stand in for thrown errors. None of these risks exist
    // inside a test process, so the type-checked rules that target production
    // code patterns are relaxed here rather than distorting every fixture.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/only-throw-error': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
    },
  },
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  eslintConfigPrettier,
);
