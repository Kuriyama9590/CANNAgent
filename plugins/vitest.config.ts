import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['dsh-cann-*/src/**/*.test.ts'],
    environment: 'node',
  },
})
