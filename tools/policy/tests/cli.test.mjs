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
import { join } from "node:path";

import { runCli } from "../lib/cli.mjs";
import { collectFiles } from "../lib/workspace.mjs";
import { validatePolicy } from "../lib/policy.mjs";
import {
  assertBlocked,
  manifest,
  materializeFixture,
  temporaryFilesystemFixture,
  toolVersions,
} from "./helpers.mjs";

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
      `import { runCli } from ${JSON.stringify(new URL("../lib/cli.mjs", import.meta.url).href)};`,
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
  const repositoryRoot = new URL("../../..", import.meta.url);
  const packageJson = JSON.parse(
    readFileSync(new URL("package.json", repositoryRoot), "utf8"),
  );
  const workflow = readFileSync(
    new URL(".github/workflows/ci.yml", repositoryRoot),
    "utf8",
  );
  assert.equal(
    packageJson.scripts["test:policy"],
    'node --test "tools/policy/tests/*.test.mjs"',
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

test("current workspace CLI succeeds", () => {
  const result = spawnSync(
    process.execPath,
    ["tools/policy/validate.mjs", "--root", "."],
    {
      cwd: new URL("../../..", import.meta.url),
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
