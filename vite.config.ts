import { defineConfig } from "vite-plus";

// busy-cli's own Vite also loads this file when it builds the app; it ignores these sections.
export default defineConfig({
  lint: {
    plugins: ["typescript", "unicorn", "oxc", "import", "vitest"],
    options: { typeAware: true, typeCheck: true },
    categories: { correctness: "error" },
    rules: {
      // Control-character patterns strip ANSI colour codes from CLI output and reject control characters in
      // cookies and other input.
      "no-control-regex": "off",
      // Providers stringify untyped JSON fields as CodexBar reads them; guarding each one would drift from its parsing.
      "typescript/no-base-to-string": "off",
      "typescript/restrict-template-expressions": "off",
      "vitest/expect-expect": ["error", { assertFunctionNames: ["assert", "assert.*", "assertFits"] }],
    },
    overrides: [
      {
        // Tests wrap a fake context's methods to observe calls.
        files: ["test/**", "companion/test/**"],
        rules: { "typescript/unbound-method": "off" },
      },
    ],
  },
  fmt: {
    printWidth: 120,
    ignorePatterns: ["dist/**", "companion/test/fixtures/**"],
  },
  test: {
    include: ["test/**/*.test.ts", "companion/test/**/*.test.ts"],
  },
});
