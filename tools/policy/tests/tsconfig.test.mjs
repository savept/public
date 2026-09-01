import assert from "node:assert/strict";
import { test } from "node:test";

import { validatePolicy } from "../lib/policy.mjs";
import { ROOT, assertBlocked, baseFixture } from "./helpers.mjs";

test("validatePolicy parses JSONC tsconfig relative fields and blocks escapes", () => {
  for (const content of [
    '{ // comment\n "extends": "../../../private/tsconfig.json"\n}',
    '{ "references": [{ "path": "../../../private" }] }',
    '{ "compilerOptions": { "baseUrl": "../../../private" } }',
    '{ "compilerOptions": { "paths": { "alias": ["../../../private/*"] } } }',
  ]) {
    assertBlocked(
      () =>
        validatePolicy(
          baseFixture({
            extraFiles: [{ path: "packages/a/tsconfig.test.json", content }],
          }),
        ),
      /tsconfig/i,
    );
  }
});

test("validatePolicy rejects unsafe and malformed tsconfig extends entries", () => {
  for (const content of [
    '{ "extends": "/private/tsconfig.json" }',
    '{ "extends": ["./base.json", "../../../private/tsconfig.json"] }',
    '{ "extends": "..\\\\..\\\\..\\\\private\\\\tsconfig.json" }',
    '{ "extends": [] }',
    '{ "extends": ["./base.json", 42] }',
  ]) {
    assertBlocked(
      () =>
        validatePolicy(
          baseFixture({
            extraFiles: [{ path: "packages/a/tsconfig.test.json", content }],
          }),
        ),
      /extends/i,
    );
  }
});

test("validatePolicy normalizes backslash config paths before containment", () => {
  for (const content of [
    '{ "references": [{ "path": "..\\\\..\\\\..\\\\private" }] }',
    '{ "compilerOptions": { "paths": { "alias": ["..\\\\..\\\\..\\\\private\\\\*"] } } }',
  ]) {
    assertBlocked(
      () =>
        validatePolicy(
          baseFixture({
            extraFiles: [{ path: "packages/a/tsconfig.test.json", content }],
          }),
        ),
      /tsconfig/i,
    );
  }
});

test("validatePolicy rejects unsafe config path forms across tsconfig fields", () => {
  for (const [content, label] of [
    [JSON.stringify({ extends: "\\\\server\\share\\base.json" }), "extends"],
    [
      JSON.stringify({ references: [{ path: "C:\\private\\tsconfig.json" }] }),
      "reference path",
    ],
    [
      JSON.stringify({ compilerOptions: { baseUrl: "file:../private" } }),
      "baseUrl",
    ],
    [
      JSON.stringify({
        compilerOptions: { paths: { alias: ["https://example.test/private"] } },
      }),
      "paths target",
    ],
  ]) {
    assertBlocked(
      () =>
        validatePolicy(
          baseFixture({
            extraFiles: [{ path: "packages/a/tsconfig.test.json", content }],
          }),
        ),
      new RegExp(label, "i"),
    );
  }
});

test("validatePolicy rejects empty config path values", () => {
  for (const content of [
    JSON.stringify({ extends: "" }),
    JSON.stringify({ references: [{ path: "" }] }),
    JSON.stringify({ compilerOptions: { baseUrl: "" } }),
    JSON.stringify({ compilerOptions: { paths: { alias: [""] } } }),
  ]) {
    assertBlocked(
      () =>
        validatePolicy(
          baseFixture({
            extraFiles: [{ path: "packages/a/tsconfig.test.json", content }],
          }),
        ),
      /path string/i,
    );
  }
});

test("validatePolicy allows a bare package-name tsconfig extends", () => {
  assert.doesNotThrow(() =>
    validatePolicy(
      baseFixture({
        extraFiles: [
          {
            path: "packages/a/tsconfig.test.json",
            content: JSON.stringify({
              extends: "@tsconfig/node20/tsconfig.json",
            }),
          },
        ],
      }),
    ),
  );
});

test("validatePolicy blocks unknown or private Savept tsconfig extends", () => {
  for (const extendsValue of [
    "@savept/private/tsconfig.json",
    "@savept/unknown/tsconfig.json",
    ["@tsconfig/node20/tsconfig.json", "@savept/private/tsconfig.json"],
  ]) {
    assertBlocked(
      () =>
        validatePolicy(
          baseFixture({
            extraFiles: [
              {
                path: "packages/a/tsconfig.test.json",
                content: JSON.stringify({ extends: extendsValue }),
              },
            ],
          }),
        ),
      /unknown or private Savept package/i,
    );
  }
});

test("validatePolicy requires workspace declaration for local tsconfig extends", () => {
  assertBlocked(
    () =>
      validatePolicy(
        baseFixture({
          packageB: { exports: { "./tsconfig.json": "./tsconfig.json" } },
          extraFiles: [
            {
              path: "packages/a/tsconfig.test.json",
              content: JSON.stringify({ extends: "@savept/b/tsconfig.json" }),
            },
          ],
        }),
      ),
    /not declared/i,
  );
  assertBlocked(
    () =>
      validatePolicy(
        baseFixture({
          packageA: { dependencies: { "@savept/b": "^1.0.0" } },
          packageB: { exports: { "./tsconfig.json": "./tsconfig.json" } },
          extraFiles: [
            {
              path: "packages/a/tsconfig.test.json",
              content: JSON.stringify({ extends: "@savept/b/tsconfig.json" }),
            },
          ],
        }),
      ),
    /workspace:/i,
  );
});

test("validatePolicy resolves local tsconfig extends through workspace exports", () => {
  assert.doesNotThrow(() =>
    validatePolicy(
      baseFixture({
        packageA: { dependencies: { "@savept/b": "workspace:*" } },
        packageB: { exports: { "./tsconfig.json": "./tsconfig.json" } },
        extraFiles: [
          {
            path: "packages/a/tsconfig.test.json",
            content: JSON.stringify({ extends: "@savept/b/tsconfig.json" }),
          },
        ],
      }),
    ),
  );
  assert.doesNotThrow(() =>
    validatePolicy(
      baseFixture({
        rootPackage: { dependencies: { "@savept/b": "workspace:*" } },
        packageB: { exports: { "./tsconfig.json": "./tsconfig.json" } },
        extraFiles: [
          {
            path: "tsconfig.json",
            content: JSON.stringify({ extends: "@savept/b/tsconfig.json" }),
          },
        ],
      }),
    ),
  );
  assertBlocked(
    () =>
      validatePolicy(
        baseFixture({
          packageA: { dependencies: { "@savept/b": "workspace:*" } },
          extraFiles: [
            {
              path: "packages/a/tsconfig.test.json",
              content: JSON.stringify({ extends: "@savept/b/private.json" }),
            },
          ],
        }),
      ),
    /not exported/i,
  );
});

test("validatePolicy blocks tsconfig aliases into package source", () => {
  assertBlocked(
    () =>
      validatePolicy(
        baseFixture({
          extraFiles: [
            {
              path: "tsconfig.alias.json",
              content:
                '{ "compilerOptions": { "paths": { "@alias/a/*": ["packages/a/src/*"] } } }',
            },
          ],
        }),
      ),
    /bypass/i,
  );
});

test("validatePolicy blocks tsconfig aliases targeting a package root wildcard", () => {
  assertBlocked(
    () =>
      validatePolicy(
        baseFixture({
          records: [
            { name: "@savept/public-workspace", path: ROOT },
            { name: "@savept/a", path: `${ROOT}/packages/a` },
            { name: "@savept/b", path: `${ROOT}/packages/b` },
          ],
          extraFiles: [
            {
              path: "tsconfig.alias.json",
              content:
                '{ "compilerOptions": { "paths": { "@alias/a/*": ["packages/a/*"] } } }',
            },
          ],
        }),
      ),
    /bypass/i,
  );
});

test("validatePolicy blocks a tsconfig baseUrl into another local package", () => {
  assertBlocked(
    () =>
      validatePolicy(
        baseFixture({
          extraFiles: [
            {
              path: "packages/b/tsconfig.json",
              content: '{ "compilerOptions": { "baseUrl": "../a" } }',
            },
            {
              path: "packages/b/src/index.ts",
              content: 'import "src/internal";',
            },
          ],
        }),
      ),
    /baseUrl.*bypass/i,
  );
});

test("validatePolicy blocks a root tsconfig backslash baseUrl into a package", () => {
  assertBlocked(
    () =>
      validatePolicy(
        baseFixture({
          extraFiles: [
            {
              path: "tsconfig.json",
              content: '{ "compilerOptions": { "baseUrl": "packages\\\\a" } }',
            },
            { path: "src/index.ts", content: 'import "src/internal";' },
          ],
        }),
      ),
    /baseUrl.*bypass/i,
  );
});

test("validatePolicy allows a package tsconfig baseUrl in its own source", () => {
  assert.doesNotThrow(() =>
    validatePolicy(
      baseFixture({
        extraFiles: [
          {
            path: "packages/b/tsconfig.json",
            content: '{ "compilerOptions": { "baseUrl": "." } }',
          },
          {
            path: "packages/b/src/index.ts",
            content: 'import "src/internal";',
          },
        ],
      }),
    ),
  );
});

test("validatePolicy allows a package tsconfig backslash baseUrl in its own source", () => {
  assert.doesNotThrow(() =>
    validatePolicy(
      baseFixture({
        extraFiles: [
          {
            path: "packages/b/tsconfig.json",
            content: '{ "compilerOptions": { "baseUrl": "src\\\\.." } }',
          },
          {
            path: "packages/b/src/index.ts",
            content: 'import "src/internal";',
          },
        ],
      }),
    ),
  );
});

test("validatePolicy requires project references for imported workspace dependencies", () => {
  const packageA = { dependencies: { "@savept/b": "workspace:*" } };
  const importedSource = {
    path: "packages/a/src/index.ts",
    content: 'import "@savept/b";',
  };
  assertBlocked(
    () =>
      validatePolicy(baseFixture({ packageA, extraFiles: [importedSource] })),
    /project reference/i,
  );
  assert.doesNotThrow(() => validatePolicy(baseFixture({ packageA })));
  assertBlocked(
    () =>
      validatePolicy(
        baseFixture({
          packageA,
          extraFiles: [
            importedSource,
            {
              path: "packages/a/tsconfig.json",
              content: '{ "references": [{ "path": "../b/src" }] }',
            },
            { path: "packages/b/tsconfig.json", content: "{}" },
          ],
        }),
      ),
    /project reference.*tsconfig/i,
  );
  assert.doesNotThrow(() =>
    validatePolicy(
      baseFixture({
        packageA,
        extraFiles: [
          importedSource,
          {
            path: "packages/a/tsconfig.json",
            content: '{ "references": [{ "path": "../b" }] }',
          },
          { path: "packages/b/tsconfig.json", content: "{}" },
        ],
      }),
    ),
  );
  assert.doesNotThrow(() =>
    validatePolicy(
      baseFixture({
        packageA,
        extraFiles: [
          importedSource,
          {
            path: "packages/a/tsconfig.json",
            content: '{ "references": [{ "path": "../b/config.v1" }] }',
          },
          { path: "packages/b/config.v1/tsconfig.json", content: "{}" },
        ],
      }),
    ),
  );
  assert.doesNotThrow(() =>
    validatePolicy(
      baseFixture({
        packageA,
        extraFiles: [
          importedSource,
          {
            path: "packages/a/tsconfig.json",
            content:
              '{ "references": [{ "path": "../b/tsconfig.build.json" }] }',
          },
          { path: "packages/b/tsconfig.build.json", content: "{}" },
        ],
      }),
    ),
  );
});
