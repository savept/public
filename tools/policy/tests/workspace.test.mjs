import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validatePolicy } from "../lib/policy.mjs";
import { parseWorkspaceDiscovery } from "../lib/workspace.mjs";
import {
  ROOT,
  assertBlocked,
  baseFixture,
  goodToolchain,
  manifest,
  toolVersions,
} from "./helpers.mjs";

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
