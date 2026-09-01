import assert from "node:assert/strict";
import { test } from "node:test";

import { validatePolicy } from "../lib/policy.mjs";
import {
  ROOT,
  assertBlocked,
  baseFixture,
  manifest,
  packageManifest,
  referencePackageB,
} from "./helpers.mjs";

test("validatePolicy rejects .gitmodules", () => {
  assertBlocked(
    () =>
      validatePolicy(
        baseFixture({
          extraFiles: [{ path: ".gitmodules", content: "[submodule]" }],
        }),
      ),
    /gitmodules/i,
  );
});

test("validatePolicy ignores only excluded and explicit generated directories", () => {
  const excluded = [
    ".git",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".nx",
    ".astro",
    "generated",
    "__generated__",
  ];
  assert.doesNotThrow(() =>
    validatePolicy(
      baseFixture({
        extraFiles: excluded.map((directory) => ({
          path: `${directory}/bad.ts`,
          content: 'import "@savept/private";',
        })),
      }),
    ),
  );
});

test("validatePolicy inventories package manifests below excluded build trees", () => {
  assertBlocked(
    () =>
      validatePolicy(
        baseFixture({
          extraFiles: [
            {
              path: "dist/hidden/package.json",
              content: manifest("@savept/hidden"),
            },
          ],
        }),
      ),
    /package\.json is missing from workspace discovery: dist\/hidden\/package\.json/i,
  );
});

test("validatePolicy blocks escaped relative source paths and protocols", () => {
  for (const specifier of [
    "../../../../private/index.js",
    "file:../../private/index.js",
    "link:../../private",
  ]) {
    assertBlocked(
      () =>
        validatePolicy(
          baseFixture({
            extraFiles: [
              {
                path: "packages/a/src/index.ts",
                content: `import ${JSON.stringify(specifier)};`,
              },
            ],
          }),
        ),
      /import/i,
    );
  }
});

test("validatePolicy blocks relative imports into another workspace package", () => {
  assertBlocked(
    () =>
      validatePolicy(
        baseFixture({
          extraFiles: [
            {
              path: "packages/a/src/index.ts",
              content: 'import "../../b/src/internal.ts";',
            },
          ],
        }),
      ),
    /relative import.*package/i,
  );
  assert.doesNotThrow(() =>
    validatePolicy(
      baseFixture({
        extraFiles: [
          {
            path: "packages/a/src/index.ts",
            content: 'import "./internal.ts";',
          },
        ],
      }),
    ),
  );
});

test("validatePolicy rejects Windows source paths before platform traversal", () => {
  for (const specifier of [
    "..\\\\..\\\\..\\\\..\\\\private\\\\index.js",
    "C:\\private\\\\index.js",
    "\\\\\\\\server\\\\share\\\\index.js",
  ]) {
    assertBlocked(
      () =>
        validatePolicy(
          baseFixture({
            extraFiles: [
              {
                path: "packages/a/src/index.ts",
                content: `import ${JSON.stringify(specifier)};`,
              },
            ],
          }),
        ),
      /relative import escapes|absolute source import/i,
    );
  }
});

test("validatePolicy rejects unknown public-scope dependencies and imports", () => {
  assertBlocked(
    () =>
      validatePolicy(
        baseFixture({
          packageA: { dependencies: { "@savept/private": "1.0.0" } },
        }),
      ),
    /@savept\/private/,
  );
  assertBlocked(
    () =>
      validatePolicy(
        baseFixture({
          extraFiles: [
            {
              path: "packages/a/src/index.ts",
              content: 'import "@savept/unknown";',
            },
          ],
        }),
      ),
    /@savept\/unknown/,
  );
});

test("validatePolicy accepts declared workspace imports through exports", () => {
  assert.doesNotThrow(() =>
    validatePolicy(
      baseFixture({
        packageA: { dependencies: { "@savept/b": "workspace:^" } },
        packageB: { exports: { "./feature": "./dist/feature.js" } },
        extraFiles: [
          {
            path: "packages/a/src/index.ts",
            content:
              'import root from "@savept/b"; export { feature } from "@savept/b/feature";',
          },
          ...referencePackageB(),
        ],
      }),
    ),
  );
});

test("validatePolicy requires workspace protocol for local dependencies", () => {
  assertBlocked(
    () =>
      validatePolicy(
        baseFixture({ packageA: { dependencies: { "@savept/b": "^1.0.0" } } }),
      ),
    /workspace:/i,
  );
});

test("validatePolicy rejects a local dependency declared in multiple fields", () => {
  assertBlocked(
    () =>
      validatePolicy(
        baseFixture({
          packageA: {
            dependencies: { "@savept/b": "file:../b" },
            devDependencies: { "@savept/b": "workspace:*" },
          },
        }),
      ),
    /multiple dependency fields/i,
  );
});

test("validatePolicy rejects dependency aliases and unsafe dependency sources", () => {
  for (const dependencies of [
    { helper: "npm:@savept/private@1.0.0" },
    { alias: "workspace:@savept/b@*" },
    ...[
      "file:../private",
      "link:../private",
      "../private",
      "/private",
      "C:\\private",
      "git+ssh://git@example.test/private/repo.git",
      "git+https://example.test/private/repo.git",
      "git:example.test/private/repo.git",
      "ssh://git@example.test/private/repo.git",
      "git://example.test/private/repo.git",
      "https://example.test/private/repo.git",
      "http://example.test/private/repo.git",
      "github:private/repo",
      "gitlab:private/repo",
      "bitbucket:private/repo",
      "patch:external@1.0.0#./patches/external.patch",
      "portal:../private",
      "git@example.test:private/repo.git",
    ].map((range) => ({ external: range })),
  ]) {
    assertBlocked(
      () => validatePolicy(baseFixture({ packageA: { dependencies } })),
      /dependency/i,
    );
  }
});

test("validatePolicy blocks renamed workspace aliases before alias imports", () => {
  assertBlocked(
    () =>
      validatePolicy(
        baseFixture({
          packageA: { dependencies: { alias: "workspace:@savept/b@*" } },
          extraFiles: [
            {
              path: "packages/a/src/index.ts",
              content: 'import "alias/private";',
            },
          ],
        }),
      ),
    /workspace dependency.*alias/i,
  );
});

test("validatePolicy accepts only genuine workspace selectors for local dependencies", () => {
  assert.doesNotThrow(() =>
    validatePolicy(
      baseFixture({
        packageA: {
          dependencies: { "@savept/b": "workspace:^", external: "^1.0.0" },
        },
      }),
    ),
  );
  assertBlocked(
    () =>
      validatePolicy(
        baseFixture({
          packageA: { dependencies: { external: "workspace:*" } },
        }),
      ),
    /workspace.*local/i,
  );
});

test("validatePolicy rejects renamed unscoped workspace selectors", () => {
  assertBlocked(
    () =>
      validatePolicy(
        baseFixture({
          records: [
            { name: "@savept/public-workspace", path: ROOT },
            { name: "@savept/a", path: `${ROOT}/packages/a` },
            { name: "@savept/b", path: `${ROOT}/packages/b` },
            { name: "foo", path: `${ROOT}/packages/foo` },
          ],
          packageA: { dependencies: { "@savept/b": "workspace:foo@*" } },
          extraFiles: [
            {
              path: "packages/foo/package.json",
              content: packageManifest("foo"),
            },
          ],
        }),
      ),
    /genuine workspace selector/i,
  );
});

test("validatePolicy accepts a bare workspace selector for local dependencies", () => {
  assert.doesNotThrow(() =>
    validatePolicy(
      baseFixture({
        packageA: { dependencies: { "@savept/b": "workspace:" } },
      }),
    ),
  );
});

test("validatePolicy requires imported local packages to be declared", () => {
  assertBlocked(
    () =>
      validatePolicy(
        baseFixture({
          extraFiles: [
            { path: "packages/a/src/index.ts", content: 'import "@savept/b";' },
          ],
        }),
      ),
    /declared/i,
  );
});
