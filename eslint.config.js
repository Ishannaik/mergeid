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
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  eslintConfigPrettier,
);
