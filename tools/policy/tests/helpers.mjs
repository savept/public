import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
  return JSON.stringify({ name, version: "1.0.0", private: true, ...extra });
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

export {
  ROOT,
  assertBlocked,
  baseFixture,
  goodToolchain,
  manifest,
  materializeFixture,
  packageManifest,
  referencePackageB,
  temporaryFilesystemFixture,
  toolVersions,
};
