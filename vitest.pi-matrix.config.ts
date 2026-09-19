import { defineConfig } from "vitest/config";

// Pi public-API compatibility matrix job. Runs only the black-box lifecycle
// suite. scripts/test-pi-matrix.mjs swaps the repo's @earendil-works
// installations for one target Pi version before invoking this config, so
// every module in the process (extension, SDK, fake providers) resolves to
// the version under certification.
export default defineConfig({
  test: {
    include: ["test/pi-black-box.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
