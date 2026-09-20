import { defineConfig } from "vitest/config";

// Explicit, credentialed real Jev compatibility gate: one OpenRouter leg and
// one TypeSafe leg against the shared classification corpus. Run only via
// `npm run test:real-jev-gate`; never part of default CI.
export default defineConfig({
  test: {
    include: ["gates/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
});
