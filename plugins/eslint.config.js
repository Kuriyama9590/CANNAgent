// plugins/ 共享 eslint 配置（SPEC §9：eslint + tsc strict）
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['**/lib/**', '**/node_modules/**'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
)
