import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validatePolicy } from "../lib/policy.mjs";
import {
  assertBlocked,
  baseFixture,
  referencePackageB,
  temporaryFilesystemFixture,
} from "./helpers.mjs";

test("validatePolicy supports exact, wildcard, conditional, array, and nested exports", () => {
  assert.doesNotThrow(() =>
    validatePolicy(
      baseFixture({
        packageA: { dependencies: { "@savept/b": "workspace:*" } },
        packageB: {
          exports: {
            "./exact": "./dist/exact.js",
            "./features/*": {
              node: {
                types: "./dist/features/*.d.ts",
                unknownFutureCondition: [
                  "./dist/features/*.js",
                  "./fallback/features/*.js",
                ],
              },
              default: "./dist/features/*.js",
            },
          },
        },
        extraFiles: [
          {
            path: "packages/a/src/index.ts",
            content:
              'import "@savept/b/exact"; import "@savept/b/features/one";',
          },
          ...referencePackageB(),
        ],
      }),
    ),
  );
});

test("validatePolicy denies null and unexported deep imports", () => {
  for (const specifier of ["@savept/b/private", "@savept/b/src/internal.js"]) {
    assertBlocked(
      () =>
        validatePolicy(
          baseFixture({
            packageA: { dependencies: { "@savept/b": "workspace:*" } },
            packageB: { exports: { "./private": null } },
            extraFiles: [
              {
                path: "packages/a/src/index.ts",
                content: `import ${JSON.stringify(specifier)};`,
              },
            ],
          }),
        ),
      /export/i,
    );
  }
});

test("validatePolicy gives a null wildcard export its Node specificity", () => {
  assertBlocked(
    () =>
      validatePolicy(
        baseFixture({
          packageA: { dependencies: { "@savept/b": "workspace:*" } },
          packageB: {
            exports: {
              "./feature/*": "./dist/*.js",
              "./feature/*.private": null,
            },
          },
          extraFiles: [
            {
              path: "packages/a/src/index.ts",
              content: 'import "@savept/b/feature/secret.private";',
            },
          ],
        }),
      ),
    /export/i,
  );
});

test("validatePolicy accepts a broad wildcard export when not excluded", () => {
  assert.doesNotThrow(() =>
    validatePolicy(
      baseFixture({
        packageA: { dependencies: { "@savept/b": "workspace:*" } },
        packageB: {
          exports: {
            "./feature/*": "./dist/*.js",
            "./feature/*.private": null,
          },
        },
        extraFiles: [
          {
            path: "packages/a/src/index.ts",
            content: 'import "@savept/b/feature/public";',
          },
          ...referencePackageB(),
        ],
      }),
    ),
  );
});

test("validatePolicy blocks mixed exports maps and unsafe targets in every condition", () => {
  for (const exportsValue of [
    { ".": "./dist/index.js", default: "./dist/index.js" },
    { ".": { import: "./dist/index.js", unknown: "../private/index.js" } },
    { ".": ["./dist/index.js", "../../private/index.js"] },
  ]) {
    assertBlocked(
      () =>
        validatePolicy(baseFixture({ packageB: { exports: exportsValue } })),
      /export/i,
    );
  }
});

test("validatePolicy blocks export targets escaping package or repository", () => {
  for (const target of [
    "../outside.js",
    "../../../private/index.js",
    "/absolute/index.js",
  ]) {
    assertBlocked(
      () =>
        validatePolicy(baseFixture({ packageB: { exports: { ".": target } } })),
      /export/i,
    );
  }
});

test("validatePolicy blocks an export target symlinked to another package", () => {
  const root = mkdtempSync(join(tmpdir(), "savept-policy-export-link-"));
  try {
    const fixture = temporaryFilesystemFixture(root);
    symlinkSync(
      join(root, "packages", "a"),
      join(root, "packages", "b", "dist"),
      "dir",
    );
    assertBlocked(() => validatePolicy(fixture), /export/i);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("validatePolicy blocks an export target symlinked outside the repository", () => {
  const root = mkdtempSync(join(tmpdir(), "savept-policy-export-link-"));
  const outside = mkdtempSync(join(tmpdir(), "savept-policy-export-outside-"));
  try {
    const fixture = temporaryFilesystemFixture(root);
    symlinkSync(outside, join(root, "packages", "b", "dist"), "dir");
    assertBlocked(() => validatePolicy(fixture), /export/i);
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(outside, { force: true, recursive: true });
  }
});

test("validatePolicy blocks a dangling export target symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "savept-policy-export-dangling-"));
  try {
    const fixture = temporaryFilesystemFixture(root);
    symlinkSync(
      join(root, "missing-build-output"),
      join(root, "packages", "b", "dist"),
      "dir",
    );
    assertBlocked(() => validatePolicy(fixture), /export/i);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("validatePolicy allows export targets whose build output is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "savept-policy-export-absent-"));
  try {
    assert.doesNotThrow(() => validatePolicy(temporaryFilesystemFixture(root)));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
