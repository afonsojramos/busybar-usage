import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { test } from "vite-plus/test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("package.json and the lockfile meet the BUSY Apps Catalog's build rules", () => {
  const pkg = JSON.parse(read("package.json")) as {
    packageManager?: string;
    devEngines?: { packageManager?: unknown };
    devDependencies: Record<string, string>;
  };
  // The catalog installs with this exact pnpm version.
  assert.match(pkg.packageManager ?? "", /^pnpm@\d+\.\d+\.\d+$/);
  // It fetches pnpm with npx, and npm refuses to run where devEngines names another package manager.
  assert.equal(pkg.devEngines?.packageManager, undefined);
  // pnpm 11 and later write a second YAML document at the top of the lockfile, which the catalog cannot parse.
  assert.doesNotMatch(read("pnpm-lock.yaml"), /^---$/m);
  assert.match(pkg.devDependencies["@busy-app/cli"] ?? "", /^\d+\.\d+\.\d+$/);
});
