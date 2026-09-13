import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'packages/release/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, '@typescript-eslint': tseslint.plugin },
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.es2022,
      },
    },
    rules: {
      // Crash-causers — block CI
      'no-undef': 'error',
      // Quality issues — report but don't block
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'no-empty': 'warn',
      'no-useless-assignment': 'warn',
      'react-hooks/rules-of-hooks': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // TypeScript already reports undefined identifiers (including types), so
    // `no-undef` only produces false positives on type-only names.
    files: ['**/*.{ts,tsx}'],
    rules: { 'no-undef': 'off' },
  },
  {
    // Ambient declaration files merge interfaces; the base rule reports the
    // merged names as unused.
    files: ['**/*.d.ts'],
    rules: { 'no-unused-vars': 'off' },
  },
)