import globalsImport from 'globals'
import neostandard from 'neostandard'
import hono from '@hono/eslint-config'

import tsParser from '@typescript-eslint/parser'

// Call neostandard() to get its config array.
const neostandardConfigs = neostandard()

// neostandard and @hono/eslint-config both define the 'import-x' plugin,
// which causes a conflict. We filter out the plugin definition from neostandard
const neostandardWithoutImportPlugin = neostandardConfigs.filter(config => !config.plugins?.['import-x'])

// Merge all neostandard configs into a single object to ensure plugins and rules are together.
// This is the key fix for the "could not find plugin 'n'" error.
const neostandardBaseConfig = Object.assign({}, ...neostandardWithoutImportPlugin)
const { browser, es2025 } = globalsImport
const globals = {
  ...browser,
  ...es2025,
}

// Prepare Hono's configs to be TypeScript-specific
const honoTypeScriptConfigs = hono.map(config => ({
  ...config,
  files: ['**/*.ts', '**/*.tsx'], // Ensure these configs only apply to TS files
  languageOptions: {
    ...config.languageOptions,
    parser: tsParser,
    parserOptions: {
      ...config.languageOptions?.parserOptions
    },
  },
}))

export default [
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ...neostandardBaseConfig,
    languageOptions: {
      ...neostandardBaseConfig.languageOptions,
      globals
    }
  },

  // 3. Apply the modified hono configs (scoped to TS files)
  ...honoTypeScriptConfigs,
]