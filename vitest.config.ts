import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx', 'api-calculator/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    // Several suites drive real terminals/subprocesses and settle on wall-clock
    // delays; shared CI runners routinely stall past those delays (the failure
    // signature is always "spy never called"/unsettled frame, never a wrong value).
    // Retry there only — local runs stay strict so a genuine regression fails fast.
    retry: process.env.CI ? 2 : 0,
  },
})
