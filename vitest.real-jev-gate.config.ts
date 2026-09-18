import { defineConfig } from "vitest/config";

// Explicit, credentialed real OpenRouter/Jev compatibility gate.
// Run only via `npm run test:real-jev-gate`; never part of default CI.
export default defineConfig({
  test: {
    include: ["gates/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
});
