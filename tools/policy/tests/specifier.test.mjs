import assert from "node:assert/strict";
import { test } from "node:test";

import { validatePolicy } from "../lib/policy.mjs";
import { assertBlocked, baseFixture, referencePackageB } from "./helpers.mjs";

for (const source of [
  'require.resolve("@savept/b/private");',
  'require(require.resolve("@savept/b/private"));',
]) {
  test(`validatePolicy applies package boundaries to static require.resolve: ${source}`, () => {
    assertBlocked(
      () =>
        validatePolicy(
          baseFixture({
            packageA: { dependencies: { "@savept/b": "workspace:*" } },
            packageB: { exports: { "./private": null } },
            extraFiles: [{ path: "packages/a/src/index.ts", content: source }],
          }),
        ),
      /export/i,
    );
  });
}

test("validatePolicy accepts declared static require.resolve exports", () => {
  assert.doesNotThrow(() =>
    validatePolicy(
      baseFixture({
        packageA: { dependencies: { "@savept/b": "workspace:*" } },
        packageB: { exports: { "./feature": "./dist/feature.js" } },
        extraFiles: [
          {
            path: "packages/a/src/index.ts",
            content:
              'require.resolve("@savept/b/feature"); require(require.resolve("@savept/b/feature"));',
          },
          ...referencePackageB(),
        ],
      }),
    ),
  );
});
