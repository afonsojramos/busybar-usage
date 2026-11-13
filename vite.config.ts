import { defineConfig } from "vite-plus";

// busy-cli's own Vite also loads this file when it builds the app; it ignores these sections.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "companion/test/**/*.test.ts"],
  },
});
