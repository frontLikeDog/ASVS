import js from '@eslint/js';
import nx from '@nx/eslint-plugin';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.nx/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/coverage/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { '@nx': nx },
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: false,
          allow: [],
          depConstraints: [
            {
              sourceTag: 'type:app',
              onlyDependOnLibsWithTags: [
                'type:feature',
                'type:ui',
                'type:state',
                'type:domain',
                'type:render',
                'type:port',
                'type:adapter',
              ],
            },
            {
              // The API may compose domain contracts and infrastructure
              // adapters, but never the React app, Zustand stores or features.
              sourceTag: 'type:api',
              onlyDependOnLibsWithTags: ['type:domain', 'type:port', 'type:adapter'],
            },
            {
              sourceTag: 'type:feature',
              onlyDependOnLibsWithTags: ['type:ui', 'type:state', 'type:domain', 'type:port'],
            },
            {
              sourceTag: 'type:state',
              onlyDependOnLibsWithTags: [
                'type:domain',
                'type:mock-services',
                'type:mock-data',
                'type:port',
                'type:adapter',
              ],
            },
            {
              sourceTag: 'type:mock-services',
              onlyDependOnLibsWithTags: ['type:domain', 'type:mock-data', 'type:port'],
            },
            {
              sourceTag: 'type:port',
              onlyDependOnLibsWithTags: ['type:domain'],
            },
            {
              sourceTag: 'type:adapter',
              onlyDependOnLibsWithTags: ['type:domain', 'type:port'],
            },
            {
              sourceTag: 'type:mock-data',
              onlyDependOnLibsWithTags: ['type:domain'],
            },
            {
              sourceTag: 'type:ui',
              onlyDependOnLibsWithTags: ['type:domain'],
            },
            {
              sourceTag: 'type:domain',
              onlyDependOnLibsWithTags: [],
            },
            {
              sourceTag: 'type:render',
              onlyDependOnLibsWithTags: ['type:domain'],
            },
            {
              sourceTag: 'type:worker',
              onlyDependOnLibsWithTags: [
                'type:domain',
                'type:render',
                'type:mock-data',
                'type:port',
              ],
            },
          ],
        },
      ],
    },
  },
  {
    // `u()` returns a unitless number. React adds px for numeric style props,
    // but inside a template string ("57.6 84.48") the declaration is invalid
    // CSS and the browser drops it silently. Use px(u, n) in string templates.
    files: ['libs/render/src/**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "TemplateLiteral CallExpression[callee.name='u']",
          message: '字符串模板中的 u() 缺少单位，请改用 px(u, n)。',
        },
      ],
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        module: 'readonly',
        require: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
  },
];
