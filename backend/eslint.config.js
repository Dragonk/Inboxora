import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,ts}'],
    plugins: { '@typescript-eslint': tseslint.plugin },
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
    rules: {
      // Crash-causers — block CI
      'no-undef': 'error',
      // Quality issues — report but don't block
      // The TS-aware rule understands type positions; the base rule reports
      // function-type parameters as unused.
      // TypeScript overload signatures look like redeclarations to the base rule;
      // tsc already rejects genuine duplicates.
      'no-redeclare': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'no-empty': 'warn',
      'no-useless-assignment': 'warn',
      'no-control-regex': 'warn',
      'preserve-caught-error': 'warn',
    },
  },
  {
    // TypeScript reports undefined identifiers itself; the base rule only
    // produces false positives for type-only names such as NodeJS.*.
    files: ['**/*.ts'],
    rules: { 'no-undef': 'off' },
  },
)