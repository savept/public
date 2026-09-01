import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  checkToolchain,
  collectFiles,
  parseToolVersions,
  parseWorkspaceDiscovery,
  runCli,
  validatePolicy,
} from "./validate.mjs";

const ROOT = "/repo";
const toolVersions = "nodejs 24.18.0\npnpm 11.7.0\n";
const goodToolchain = {
  expectedNode: "24.18.0",
  expectedPnpm: "11.7.0",
  processNode: "v24.18.0",
  asdfCurrentNode: "nodejs          24.18.0         /repo/.tool-versions",
  asdfCurrentPnpm: "pnpm            11.7.0         /repo/.tool-versions",
  asdfExecNode: "v24.18.0\n",
  asdfExecPnpm: "11.7.0\n",
};

function manifest(name, extra = {}) {
  return JSON.stringify({
    name,
    version: "0.0.0",
    private: true,
    type: "module",
    ...extra,
  });
}

function packageManifest(name, extra = {}) {
  const { exports: additionalExports = {}, ...rest } = extra;
  return manifest(name, {
    exports: { ".": "./dist/index.js", ...additionalExports },
    ...rest,
  });
}

function referencePackageB() {
  return [
    {
      path: "packages/a/tsconfig.json",
      content: '{ "references": [{ "path": "../b" }] }',
    },
    { path: "packages/b/tsconfig.json", content: "{}" },
  ];
}

function baseFixture({
  extraFiles = [],
  records,
  rootPackage = {},
  packageA = {},
  packageB = {},
} = {}) {
  return {
    root: ROOT,
    toolVersionsText: toolVersions,
    toolchain: goodToolchain,
    workspaceRecords: records ?? [
      { name: "@savept/public-workspace", path: ROOT },
      { name: "@savept/a", path: `${ROOT}/packages/a` },
      { name: "@savept/b", path: `${ROOT}/packages/b` },
    ],
    files: [
      {
        path: "package.json",
        content: manifest("@savept/public-workspace", rootPackage),
      },
      { path: "pnpm-workspace.yaml", content: "packages:\n  - packages/*\n" },
      {
        path: "packages/a/package.json",
        content: packageManifest("@savept/a", packageA),
      },
      {
        path: "packages/b/package.json",
        content: packageManifest("@savept/b", packageB),
      },
      ...extraFiles,
    ],
  };
}

function temporaryFilesystemFixture(root, packageB = {}) {
  const records = [
    { name: "@savept/public-workspace", path: root },
    { name: "@savept/a", path: join(root, "packages", "a") },
    { name: "@savept/b", path: join(root, "packages", "b") },
  ];
  mkdirSync(join(root, "packages", "a"), { recursive: true });
  mkdirSync(join(root, "packages", "b"), { recursive: true });
  return {
    root,
    toolVersionsText: toolVersions,
    toolchain: goodToolchain,
    workspaceRecords: records,
    files: [
      {
        path: "package.json",
        content: manifest("@savept/public-workspace"),
      },
      { path: "pnpm-workspace.yaml", content: "packages:\n  - packages/*\n" },
      {
        path: "packages/a/package.json",
        content: packageManifest("@savept/a"),
      },
      {
        path: "packages/b/package.json",
        content: packageManifest("@savept/b", packageB),
      },
    ],
  };
}
function materializeFixture(fixture) {
  for (const file of fixture.files) {
    const absolute = join(fixture.root, file.path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, file.content);
  }
}

function assertBlocked(callback, fragment) {
  assert.throws(callback, (error) => {
    assert.match(String(error), /^Error: WORKSPACE_POLICY_BLOCKED:/);
    if (fragment) assert.match(String(error), fragment);
    return true;
  });
}

test("parseToolVersions accepts one normalized nodejs and pnpm entry", () => {
  assert.deepEqual(parseToolVersions(" nodejs   v24.18.0 \n\tpnpm\t11.7.0\n"), {
    nodejs: "24.18.0",
    pnpm: "11.7.0",
  });
});

for (const [name, text] of [
  ["missing nodejs", "pnpm 11.7.0\n"],
  ["missing pnpm", "nodejs 24.18.0\n"],
  ["multiple nodejs", "nodejs 24.18.0\nnodejs 24.17.0\npnpm 11.7.0\n"],
  ["multiple pnpm", "nodejs 24.18.0\npnpm 11.7.0\npnpm 11.6.0\n"],
  ["malformed nodejs", "nodejs 24\npnpm 11.7.0\n"],
  ["malformed pnpm", "nodejs 24.18.0\npnpm latest\n"],
  ["extra tokens", "nodejs 24.18.0 unexpected\npnpm 11.7.0\n"],
]) {
  test(`parseToolVersions fails closed for ${name}`, () => {
    assertBlocked(() => parseToolVersions(text), /tool version/i);
  });
}

test("checkToolchain accepts matching injected evidence", () => {
  assert.doesNotThrow(() => checkToolchain(goodToolchain));
});

test("checkToolchain rejects duplicate asdf current evidence lines", () => {
  assertBlocked(
    () =>
      checkToolchain({
        ...goodToolchain,
        asdfCurrentNode:
          "nodejs 24.18.0 /repo/.tool-versions\nnodejs 24.18.0 /repo/.tool-versions",
      }),
    /asdf current nodejs/i,
  );
});

for (const key of [
  "processNode",
  "asdfCurrentNode",
  "asdfCurrentPnpm",
  "asdfExecNode",
  "asdfExecPnpm",
]) {
  test(`checkToolchain rejects mismatched ${key}`, () => {
    assertBlocked(
      () => checkToolchain({ ...goodToolchain, [key]: "0.0.0" }),
      /toolchain/i,
    );
  });

  test(`checkToolchain rejects command error injected at ${key}`, () => {
    assertBlocked(
      () =>
        checkToolchain({
          ...goodToolchain,
          [key]: new Error("command unavailable"),
        }),
      /toolchain/i,
    );
  });
}

test("parseWorkspaceDiscovery normalizes pnpm JSON records", () => {
  assert.deepEqual(
    parseWorkspaceDiscovery({
      root: ROOT,
      status: 0,
      stdout: JSON.stringify([
        { name: "@savept/public-workspace", path: ROOT },
        { name: "@savept/a", path: `${ROOT}/packages/a` },
      ]),
      stderr: "",
    }),
    [
      { name: "@savept/public-workspace", path: ROOT },
      { name: "@savept/a", path: `${ROOT}/packages/a` },
    ],
  );
});

for (const [name, result] of [
  [
    "missing asdf or pnpm",
    { error: new Error("ENOENT"), status: null, stdout: "", stderr: "" },
  ],
  ["nonzero exit", { status: 1, stdout: "[]", stderr: "failed" }],
  [
    "signal termination",
    { status: null, signal: "SIGTERM", stdout: "", stderr: "" },
  ],
  ["stderr-only result", { status: 0, stdout: "", stderr: "warning" }],
  ["malformed JSON", { status: 0, stdout: "{", stderr: "" }],
  ["non-array JSON", { status: 0, stdout: "{}", stderr: "" }],
]) {
  test(`parseWorkspaceDiscovery blocks ${name}`, () => {
    assertBlocked(
      () => parseWorkspaceDiscovery({ root: ROOT, ...result }),
      /workspace discovery/i,
    );
  });
}

test("parseWorkspaceDiscovery blocks duplicate names and paths", () => {
  for (const records of [
    [
      { name: "@savept/a", path: `${ROOT}/packages/a` },
      { name: "@savept/a", path: `${ROOT}/packages/b` },
    ],
    [
      { name: "@savept/a", path: `${ROOT}/packages/a` },
      { name: "@savept/b", path: `${ROOT}/packages/a` },
    ],
  ]) {
    assertBlocked(
      () =>
        parseWorkspaceDiscovery({
          root: ROOT,
          status: 0,
          stdout: JSON.stringify(records),
          stderr: "",
        }),
      /duplicate/i,
    );
  }
});

test("parseWorkspaceDiscovery blocks records outside the root", () => {
  assertBlocked(
    () =>
      parseWorkspaceDiscovery({
        root: ROOT,
        status: 0,
        stdout: JSON.stringify([
          { name: "@savept/private", path: "/private/product" },
        ]),
        stderr: "",
      }),
    /outside/i,
  );
});

test("parseWorkspaceDiscovery blocks a symlinked workspace record outside the root", () => {
  const root = mkdtempSync(join(tmpdir(), "savept-policy-root-"));
  const outside = mkdtempSync(join(tmpdir(), "savept-policy-outside-"));
  const link = join(root, "packages", "outside");
  try {
    mkdirSync(join(root, "packages"), { recursive: true });
    symlinkSync(outside, link, "dir");
    assertBlocked(
      () =>
        parseWorkspaceDiscovery({
          root,
          status: 0,
          stdout: JSON.stringify([{ name: "@savept/outside", path: link }]),
          stderr: "",
          resolvePath: realpathSync,
        }),
      /outside repository/i,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(outside, { force: true, recursive: true });
  }
});

test("parseWorkspaceDiscovery rejects duplicate resolved workspace paths", () => {
  const root = mkdtempSync(join(tmpdir(), "savept-policy-root-"));
  const packageRoot = join(root, "packages", "shared");
  const firstLink = join(root, "packages", "first");
  const secondLink = join(root, "packages", "second");
  try {
    mkdirSync(packageRoot, { recursive: true });
    symlinkSync(packageRoot, firstLink, "dir");
    symlinkSync(packageRoot, secondLink, "dir");
    assertBlocked(
      () =>
        parseWorkspaceDiscovery({
          root,
          status: 0,
          stdout: JSON.stringify([
            { name: "@savept/first", path: firstLink },
            { name: "@savept/second", path: secondLink },
          ]),
          stderr: "",
          resolvePath: realpathSync,
        }),
      /duplicate path/i,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

for (const [name, yaml, records] of [
  [
    "quoted workspace patterns",
    'packages:\n  - "packages/*"\n',
    [
      { name: "@savept/public-workspace", path: ROOT },
      { name: "@savept/a", path: `${ROOT}/packages/a` },
    ],
  ],
  [
    "negative workspace patterns",
    "packages:\n  - packages/**\n  - '!packages/excluded/**'\n",
    [
      { name: "@savept/public-workspace", path: ROOT },
      { name: "@savept/a", path: `${ROOT}/packages/a` },
    ],
  ],
  [
    "nested workspace packages",
    "packages:\n  - packages/**\n",
    [
      { name: "@savept/public-workspace", path: ROOT },
      { name: "@savept/a", path: `${ROOT}/packages/a` },
      { name: "@savept/nested", path: `${ROOT}/packages/group/nested` },
    ],
  ],
]) {
  test(`validatePolicy relies on injected pnpm discovery for ${name}`, () => {
    const files = records.map((record) => ({
      path:
        record.path === ROOT
          ? "package.json"
          : `${record.path.slice(ROOT.length + 1)}/package.json`,
      content: manifest(record.name, {
        exports: record.path === ROOT ? undefined : "./dist/index.js",
      }),
    }));
    files.push({ path: "pnpm-workspace.yaml", content: yaml });
    assert.doesNotThrow(() =>
      validatePolicy({
        root: ROOT,
        toolVersionsText: toolVersions,
        toolchain: goodToolchain,
        workspaceRecords: records,
        files,
      }),
    );
  });
}

test("validatePolicy blocks malformed workspace configuration discovery", () => {
  assertBlocked(
    () =>
      validatePolicy({
        ...baseFixture(),
        workspaceRecords: new Error("pnpm could not parse pnpm-workspace.yaml"),
      }),
    /workspace discovery/i,
  );
});

test("validatePolicy requires the root package manifest in workspace discovery", () => {
  assertBlocked(
    () =>
      validatePolicy(
        baseFixture({
          records: [
            { name: "@savept/a", path: `${ROOT}/packages/a` },
            { name: "@savept/b", path: `${ROOT}/packages/b` },
          ],
        }),
      ),
    /package\.json.*workspace discovery/i,
  );
});

for (const extension of [
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "d.ts",
]) {
  test(`validatePolicy scans .${extension} sources`, () => {
    assertBlocked(
      () =>
        validatePolicy(
          baseFixture({
            extraFiles: [
              {
                path: `packages/a/src/example.${extension}`,
                content: 'import "@savept/private";',
              },
            ],
          }),
        ),
      /@savept\/private/,
    );
  });
}

for (const [name, source] of [
  ["static imports", 'import value from "@savept/private";'],
  [
    "import-equals require declarations",
    'import value = require("@savept/private");',
  ],
  [
    "import type expressions",
    'type Private = import("@savept/private").Value;',
  ],
  ["export-from declarations", 'export { value } from "@savept/private";'],
  ["dynamic imports", 'const value = import("@savept/private");'],
  [
    "dynamic imports with options",
    'const value = import("@savept/private", { with: { type: "json" } });',
  ],
  ["require calls", 'const value = require("@savept/private");'],
]) {
  test(`validatePolicy scans ${name}`, () => {
    assertBlocked(
      () =>
        validatePolicy(
          baseFixture({
            extraFiles: [{ path: "packages/a/src/index.ts", content: source }],
          }),
        ),
      /@savept\/private/,
    );
  });
}

for (const [name, source] of [
  ["module.require calls", 'module.require("@savept/b/private");'],
  ["computed module.require calls", 'module["require"]("@savept/b/private");'],
  ["comma-expression require calls", '(0, require)("@savept/b/private");'],
]) {
  test(`validatePolicy applies package boundaries to ${name}`, () => {
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

for (const [name, source] of [
  [
    "as-expression require calls",
    '(require as typeof require)("@savept/b/private");',
  ],
  [
    "type-asserted require calls",
    '(<typeof require>require)("@savept/b/private");',
  ],
  ["non-null require calls", 'require!("@savept/b/private");'],
  [
    "satisfies-expression require calls",
    '(require satisfies typeof require)("@savept/b/private");',
  ],
  [
    "wrapped module.require calls",
    '((module.require) as typeof require)("@savept/b/private");',
  ],
  [
    "concatenated computed module.require calls",
    'module["req" + "uire"]("@savept/b/private");',
  ],
  ["new require calls", 'new require("@savept/b/private");'],
]) {
  test(`validatePolicy applies package boundaries to ${name}`, () => {
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

test("validatePolicy blocks long direct and concatenated static specifiers", () => {
  const longSubpath = "private".padEnd(300, "x");
  for (const source of [
    `require(${JSON.stringify(`@savept/b/${longSubpath}`)});`,
    `require("@savept/b/" + ${JSON.stringify(longSubpath)});`,
  ]) {
    assertBlocked(
      () =>
        validatePolicy(
          baseFixture({
            packageA: { dependencies: { "@savept/b": "workspace:*" } },
            packageB: { exports: { "./private*": null } },
            extraFiles: [{ path: "packages/a/src/index.ts", content: source }],
          }),
        ),
      /export/i,
    );
  }
});

test("validatePolicy blocks static analysis complexity exhaustion", () => {
  const source = `require(${[
    JSON.stringify("@savept/b/"),
    ...Array.from({ length: 1_100 }, () => JSON.stringify("")),
    JSON.stringify("feature"),
  ].join(" + ")});`;
  assertBlocked(
    () =>
      validatePolicy(
        baseFixture({
          packageA: { dependencies: { "@savept/b": "workspace:*" } },
          packageB: { exports: { "./feature": "./dist/feature.js" } },
          extraFiles: [{ path: "packages/a/src/index.ts", content: source }],
        }),
      ),
    /complex|static analysis|resource/i,
  );
});

test("validatePolicy leaves genuine dynamic specifier expressions unclassified", () => {
  for (const content of [
    'const suffix = "private"; require(suffix);',
    'const suffix = "private"; module["require"]("@savept/b/" + suffix);',
    'const suffix = "private"; import("@savept/b/" + suffix);',
  ]) {
    assert.doesNotThrow(() =>
      validatePolicy(
        baseFixture({
          extraFiles: [{ path: "packages/a/src/index.ts", content }],
        }),
      ),
    );
  }
});

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

test("runCli blocks contained symlink directory cycles promptly", () => {
  const root = mkdtempSync(join(tmpdir(), "savept-policy-cycle-"));
  try {
    writeFileSync(join(root, ".tool-versions"), toolVersions);
    writeFileSync(
      join(root, "package.json"),
      manifest("@savept/public-workspace"),
    );
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    symlinkSync(".", join(root, "loop"), "dir");
    const script = [
      `import { runCli } from ${JSON.stringify(new URL("./validate.mjs", import.meta.url).href)};`,
      `try { runCli(["--root", ${JSON.stringify(root)}]); }`,
      "catch (error) { console.error(error.message); process.exitCode = 1; }",
    ].join("\n");
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        encoding: "utf8",
        timeout: 5_000,
        env: { ...process.env, CI: "true" },
      },
    );
    assert.equal(result.error, undefined, "cycle traversal timed out");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /WORKSPACE_POLICY_BLOCKED:.*symbolic link/i);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("collectFiles blocks dangling symlinks beneath excluded build trees with a stable policy error", () => {
  const root = mkdtempSync(join(tmpdir(), "savept-policy-dangling-excluded-"));
  try {
    writeFileSync(join(root, ".tool-versions"), toolVersions);
    writeFileSync(
      join(root, "package.json"),
      manifest("@savept/public-workspace"),
    );
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    mkdirSync(join(root, "build", "nested"), { recursive: true });
    symlinkSync("missing", join(root, "build", "nested", "link"));
    assertBlocked(
      () => collectFiles(realpathSync(root)),
      /symbolic link is dangling: build[\\/]nested[\\/]link/i,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("collectFiles skips aliases to fully ignored directory targets", () => {
  const root = mkdtempSync(join(tmpdir(), "savept-policy-ignored-alias-"));
  const outside = mkdtempSync(join(tmpdir(), "savept-policy-ignored-outside-"));
  try {
    writeFileSync(join(root, ".tool-versions"), toolVersions);
    writeFileSync(
      join(root, "package.json"),
      manifest("@savept/public-workspace"),
    );
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    for (const directory of [".git", "node_modules"]) {
      mkdirSync(join(root, directory), { recursive: true });
      symlinkSync(outside, join(root, directory, "escaping"), "dir");
      symlinkSync(
        directory,
        join(root, `alias-${directory.replace(".", "")}`),
        "dir",
      );
    }
    assert.doesNotThrow(() => collectFiles(realpathSync(root)));
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(outside, { force: true, recursive: true });
  }
});

test("collectFiles inventories only manifests through aliases to excluded build targets", () => {
  const root = mkdtempSync(join(tmpdir(), "savept-policy-build-alias-"));
  try {
    writeFileSync(join(root, ".tool-versions"), toolVersions);
    writeFileSync(
      join(root, "package.json"),
      manifest("@savept/public-workspace"),
    );
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "bad.ts"), 'import "@savept/private";');
    symlinkSync("dist", join(root, "alias"), "dir");
    assert.doesNotThrow(() => collectFiles(realpathSync(root)));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("collectFiles inventories manifests through aliases to excluded generated targets", () => {
  const root = mkdtempSync(join(tmpdir(), "savept-policy-generated-alias-"));
  try {
    writeFileSync(join(root, ".tool-versions"), toolVersions);
    writeFileSync(
      join(root, "package.json"),
      manifest("@savept/public-workspace"),
    );
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    mkdirSync(join(root, "generated", "hidden"), { recursive: true });
    writeFileSync(
      join(root, "generated", "hidden", "package.json"),
      manifest("@savept/hidden"),
    );
    symlinkSync("generated", join(root, "alias"), "dir");
    assert.ok(
      collectFiles(realpathSync(root)).some(
        (file) => file.path === "generated/hidden/package.json",
      ),
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("collectFiles safely skips a valid direct excluded symlink cycle", () => {
  const root = mkdtempSync(join(tmpdir(), "savept-policy-excluded-cycle-"));
  try {
    writeFileSync(join(root, ".tool-versions"), toolVersions);
    writeFileSync(
      join(root, "package.json"),
      manifest("@savept/public-workspace"),
    );
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    symlinkSync(".", join(root, "generated"), "dir");
    assert.doesNotThrow(() => collectFiles(realpathSync(root)));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("collectFiles blocks aliases that resolve outside the repository", () => {
  const root = mkdtempSync(join(tmpdir(), "savept-policy-external-alias-"));
  const outside = mkdtempSync(join(tmpdir(), "savept-policy-outside-"));
  try {
    writeFileSync(join(root, ".tool-versions"), toolVersions);
    writeFileSync(
      join(root, "package.json"),
      manifest("@savept/public-workspace"),
    );
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    symlinkSync(outside, join(root, "alias"), "dir");
    assertBlocked(
      () => collectFiles(realpathSync(root)),
      /symbolic link escapes repository: alias/i,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(outside, { force: true, recursive: true });
  }
});

test("validatePolicy blocks source file symlinks crossing package boundaries", () => {
  const root = mkdtempSync(join(tmpdir(), "savept-policy-file-link-boundary-"));
  try {
    const fixtureRoot = realpathSync(root);
    const fixture = temporaryFilesystemFixture(fixtureRoot);
    materializeFixture(fixture);
    mkdirSync(join(root, "packages", "a", "src"), { recursive: true });
    mkdirSync(join(root, "packages", "b", "src"), { recursive: true });
    writeFileSync(
      join(root, "packages", "b", "src", "private.ts"),
      "export const secret = 1;\n",
    );
    symlinkSync(
      "../../b/src/private.ts",
      join(root, "packages", "a", "src", "private.ts"),
      "file",
    );
    writeFileSync(
      join(root, "packages", "a", "src", "index.ts"),
      'import "./private.ts";\n',
    );
    assertBlocked(
      () =>
        validatePolicy({
          ...fixture,
          files: collectFiles(fixtureRoot),
        }),
      /source file symlink.*package boundary|canonical.*package/i,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("validatePolicy permits source file symlinks within one package", () => {
  const root = mkdtempSync(join(tmpdir(), "savept-policy-file-link-safe-"));
  try {
    const fixtureRoot = realpathSync(root);
    const fixture = temporaryFilesystemFixture(fixtureRoot);
    materializeFixture(fixture);
    mkdirSync(join(root, "packages", "a", "src"), { recursive: true });
    writeFileSync(
      join(root, "packages", "a", "src", "shared.ts"),
      "export const shared = 1;\n",
    );
    symlinkSync(
      "shared.ts",
      join(root, "packages", "a", "src", "shared-link.ts"),
      "file",
    );
    writeFileSync(
      join(root, "packages", "a", "src", "index.ts"),
      'import "./shared-link.ts";\n',
    );
    assert.doesNotThrow(() =>
      validatePolicy({
        ...fixture,
        files: collectFiles(fixtureRoot),
      }),
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("collectFiles blocks external and dangling source file symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "savept-policy-file-link-errors-"));
  const outside = mkdtempSync(
    join(tmpdir(), "savept-policy-file-link-outside-"),
  );
  try {
    mkdirSync(join(root, "packages", "a", "src"), { recursive: true });
    writeFileSync(join(root, ".tool-versions"), toolVersions);
    writeFileSync(
      join(root, "package.json"),
      manifest("@savept/public-workspace"),
    );
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    writeFileSync(join(outside, "private.ts"), "export {};\n");
    symlinkSync(
      join(outside, "private.ts"),
      join(root, "packages", "a", "src", "external.ts"),
      "file",
    );
    assertBlocked(
      () => collectFiles(realpathSync(root)),
      /symbolic link escapes repository: packages[\\/]a[\\/]src[\\/]external\.ts/i,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(outside, { force: true, recursive: true });
  }

  const danglingRoot = mkdtempSync(
    join(tmpdir(), "savept-policy-file-link-dangling-"),
  );
  try {
    mkdirSync(join(danglingRoot, "packages", "a", "src"), {
      recursive: true,
    });
    writeFileSync(join(danglingRoot, ".tool-versions"), toolVersions);
    writeFileSync(
      join(danglingRoot, "package.json"),
      manifest("@savept/public-workspace"),
    );
    writeFileSync(join(danglingRoot, "pnpm-workspace.yaml"), "packages: []\n");
    symlinkSync(
      "missing.ts",
      join(danglingRoot, "packages", "a", "src", "dangling.ts"),
      "file",
    );
    assertBlocked(
      () => collectFiles(realpathSync(danglingRoot)),
      /symbolic link is dangling: packages[\\/]a[\\/]src[\\/]dangling\.ts/i,
    );
  } finally {
    rmSync(danglingRoot, { force: true, recursive: true });
  }
});

test("policy test script and CI policy-test step are kept in order", () => {
  const repositoryRoot = new URL("../..", import.meta.url);
  const packageJson = JSON.parse(
    readFileSync(new URL("package.json", repositoryRoot), "utf8"),
  );
  const workflow = readFileSync(
    new URL(".github/workflows/ci.yml", repositoryRoot),
    "utf8",
  );
  assert.equal(
    packageJson.scripts["test:policy"],
    "node --test tools/policy/validate.test.mjs",
  );
  assert.match(
    workflow,
    /- name: Test workspace and dependency policy\n\s+run: pnpm test:policy/,
  );
  const policyCheck = workflow.indexOf("run: pnpm policy:check");
  const policyTest = workflow.indexOf("run: pnpm test:policy");
  const formatting = workflow.indexOf("run: pnpm format:check");
  assert.ok(policyCheck < policyTest && policyTest < formatting);
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

test("current workspace CLI succeeds", () => {
  const result = spawnSync(
    process.execPath,
    ["tools/policy/validate.mjs", "--root", "."],
    {
      cwd: new URL("../..", import.meta.url),
      encoding: "utf8",
      env: process.env,
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /workspace policy passed/i);
});

test("runCli reports a stable policy failure when tool versions are missing", () => {
  const root = mkdtempSync(join(tmpdir(), "savept-policy-test-"));
  try {
    assertBlocked(() => runCli(["--root", root]), /tool versions/i);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
