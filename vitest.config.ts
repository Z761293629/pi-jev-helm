import { defineConfig } from "vitest/config";

// Default deterministic suite. The credentialed real Jev compatibility gate
// is excluded here by construction; invoke it explicitly with
// `npm run test:real-jev-gate` using vitest.real-jev-gate.config.ts.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
