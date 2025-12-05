import hono from '@hono/eslint-config'
import tsParser from '@typescript-eslint/parser'
import simpleImportSort from 'eslint-plugin-simple-import-sort'
import vitest from 'eslint-plugin-vitest'
import globalsImport from 'globals'
import neostandard from 'neostandard'

export default [
  // 1. Global sort rule for all files
  {
    plugins: { 'simple-import-sort': simpleImportSort },
    rules: {
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error'
    }
  },

  // 2. Base configuration for JavaScript files using neostandard
  ...neostandard({
    globals: { ...globalsImport.browser, ...globalsImport.es2025 }
  }).map(config => ({
    ...config,
    files: ['**/*.js', '**/*.mjs', '**/*.cjs']
  })),

  // 3. Vitest configuration for test files
  {
    files: ['**/*.spec.mjs', '**/*.test.mjs', '**/*.spec.js', '**/*.test.js'],
    plugins: { vitest },
    rules: vitest.configs.recommended.rules,
    languageOptions: {
      globals: {
        ...vitest.environments.env.globals
      }
    },
  },

  // 4. Hono's configuration for TypeScript files
  ...hono.map(config => ({
    ...config,
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      ...config.languageOptions,
      parser: tsParser
    }
  }))
]
