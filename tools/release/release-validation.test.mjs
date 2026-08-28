import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateWorkflowPolicy } from "./validate.mjs";

const temporaryRoots = [];

function createWorkspace() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "savept-release-test-"));
  temporaryRoots.push(workspaceRoot);
  return workspaceRoot;
}

function runValidation(workspaceRoot) {
  try {
    const output = execFileSync(
      process.execPath,
      ["tools/release/validate.mjs", "--root", workspaceRoot],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return { output, status: 0 };
  } catch (error) {
    return {
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
      status: error.status,
    };
  }
}

function writeReleaseFixture(workspaceRoot, options = {}) {
  const packageName = "@savept/release-fixture";
  const packageRoot = join(workspaceRoot, "packages", "release-fixture");
  const manifest = {
    exports: { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } },
    files: ["dist", "LICENSE"],
    license: "MIT",
    name: packageName,
    private: false,
    type: "module",
    version: "1.2.3",
    ...options.manifest,
  };
  const expectedFiles = options.expectedFiles ?? [
    "LICENSE",
    "dist/index.d.ts",
    "dist/index.js",
    "package.json",
  ];

  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  mkdirSync(join(workspaceRoot, "release"), { recursive: true });
  writeFileSync(
    join(workspaceRoot, "pnpm-workspace.yaml"),
    "packages:\n  - packages/*\n  - apps/*\n",
  );
  writeFileSync(
    join(packageRoot, "dist", "index.d.ts"),
    "export declare const packageValue: string;\n",
  );
  writeFileSync(
    join(packageRoot, "dist", "index.js"),
    'export const packageValue = "clean";\n',
  );
  writeFileSync(join(packageRoot, "LICENSE"), "MIT License\n");
  writeFileSync(
    join(packageRoot, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  for (const [filePath, content] of Object.entries(options.files ?? {})) {
    const target = join(packageRoot, filePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  writeFileSync(
    join(workspaceRoot, "release", "allow-list.json"),
    `${JSON.stringify({ packages: options.packages ?? [{ expectedFiles, license: "MIT", name: packageName }], version: 1 }, null, 2)}\n`,
  );
  mkdirSync(join(workspaceRoot, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(workspaceRoot, ".github", "workflows", "ci.yml"),
    "permissions:\n  contents: read\n",
  );
  writeFileSync(
    join(workspaceRoot, "release", "trusted-publishing-policy.json"),
    JSON.stringify({
      futurePublishJob: {
        allowListGate: true,
        environment: "npm-production",
        protectedEnvironmentReview: true,
        provenanceArgs: ["publish", "--provenance"],
        scopedPermissions: ["contents: read", "id-token: write"],
      },
      validationOnly: true,
      version: 1,
    }),
  );
}

function writeWorkspacePackage(workspaceRoot, directory, manifest) {
  const packageRoot = join(workspaceRoot, directory);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    `${JSON.stringify(manifest)}\n`,
  );
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop(), { force: true, recursive: true });
  }
});

describe("release validation", () => {
  it("fails closed when the publication allow-list is missing", () => {
    const workspaceRoot = createWorkspace();
    let output = "";

    try {
      execFileSync(
        process.execPath,
        ["tools/release/validate.mjs", "--root", workspaceRoot],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (error) {
      output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }

    expect(output).toContain(
      "RELEASE_POLICY_BLOCKED: publication allow-list is missing",
    );
  });

  it("fails closed when the publication allow-list is empty", () => {
    const workspaceRoot = createWorkspace();
    mkdirSync(join(workspaceRoot, "release"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, "release", "allow-list.json"),
      JSON.stringify({ packages: [], version: 1 }),
    );

    let output = "";

    try {
      execFileSync(
        process.execPath,
        ["tools/release/validate.mjs", "--root", workspaceRoot],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (error) {
      output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }

    expect(output).toContain(
      "RELEASE_POLICY_BLOCKED: publication allow-list is empty",
    );
  });

  it("packs an explicitly approved package and installs its local tarball into a clean consumer", () => {
    const workspaceRoot = createWorkspace();
    writeReleaseFixture(workspaceRoot);

    const result = runValidation(workspaceRoot);

    expect(result.status).toBe(0);
    expect(result.output).toContain(
      "RELEASE_VALIDATED: @savept/release-fixture@1.2.3 packed and installed cleanly",
    );
  });

  it("fails closed when the allow-list contains duplicate package names", () => {
    const workspaceRoot = createWorkspace();
    writeReleaseFixture(workspaceRoot, {
      packages: [
        {
          expectedFiles: [
            "LICENSE",
            "dist/index.d.ts",
            "dist/index.js",
            "package.json",
          ],
          name: "@savept/release-fixture",
        },
        {
          expectedFiles: [
            "LICENSE",
            "dist/index.d.ts",
            "dist/index.js",
            "package.json",
          ],
          name: "@savept/release-fixture",
        },
      ],
    });

    const result = runValidation(workspaceRoot);

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "RELEASE_POLICY_BLOCKED: duplicate allow-list package",
    );
  });

  it("fails closed when an allow-listed package is unknown", () => {
    const workspaceRoot = createWorkspace();
    writeReleaseFixture(workspaceRoot, {
      manifest: { private: true },
      packages: [
        {
          expectedFiles: [
            "LICENSE",
            "dist/index.d.ts",
            "dist/index.js",
            "package.json",
          ],
          name: "@savept/not-present",
        },
      ],
    });

    const result = runValidation(workspaceRoot);

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "RELEASE_POLICY_BLOCKED: allow-listed package @savept/not-present is unknown",
    );
  });

  it("fails closed when a non-private package is absent from the allow-list", () => {
    const workspaceRoot = createWorkspace();
    writeReleaseFixture(workspaceRoot, {
      packages: [
        {
          expectedFiles: [
            "LICENSE",
            "dist/index.d.ts",
            "dist/index.js",
            "package.json",
          ],
          name: "@savept/different-package",
        },
      ],
    });

    const result = runValidation(workspaceRoot);

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "RELEASE_POLICY_BLOCKED: non-private package @savept/release-fixture is not allow-listed",
    );
  });

  it("rejects duplicate manifest names before considering private state", () => {
    const workspaceRoot = createWorkspace();
    writeReleaseFixture(workspaceRoot);
    writeWorkspacePackage(workspaceRoot, "apps/shadow", {
      name: "@savept/release-fixture",
      private: true,
      version: "1.2.3",
    });

    const result = runValidation(workspaceRoot);

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "RELEASE_POLICY_BLOCKED: duplicate workspace package name",
    );
  });

  it("rejects an unknown private Savept dependency with a normal semver range", () => {
    const workspaceRoot = createWorkspace();
    writeReleaseFixture(workspaceRoot, {
      manifest: { dependencies: { "@savept/product": "1.0.0" } },
    });

    const result = runValidation(workspaceRoot);

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "RELEASE_POLICY_BLOCKED: dependency @savept/product",
    );
  });

  it("rejects an unapproved SPDX-shaped license", () => {
    const workspaceRoot = createWorkspace();
    writeReleaseFixture(workspaceRoot, { manifest: { license: "MITT" } });

    const result = runValidation(workspaceRoot);

    expect(result.status).toBe(1);
    expect(result.output).toContain("RELEASE_POLICY_BLOCKED: license");
  });

  it("rejects expected artifact paths that are intrinsically forbidden", () => {
    const workspaceRoot = createWorkspace();
    writeReleaseFixture(workspaceRoot, {
      expectedFiles: [
        ".env",
        "LICENSE",
        "dist/index.d.ts",
        "dist/index.js",
        "package.json",
      ],
      files: { ".env": "PUBLIC_VALUE=not-secret\n" },
      manifest: { files: ["dist", "LICENSE", ".env"] },
    });

    const result = runValidation(workspaceRoot);

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "RELEASE_POLICY_BLOCKED: forbidden packed path",
    );
  });

  it.each([
    [
      "a lifecycle install script",
      { manifest: { scripts: { preinstall: "node steal.mjs" } } },
      "lifecycle script",
    ],
    [
      "a workspace dependency",
      { manifest: { dependencies: { shared: "workspace:*" } } },
      "dependency",
    ],
    [
      "a source token",
      {
        files: {
          "dist/index.js":
            "export const token = 'ghp_exampleToken1234567890';\n",
        },
      },
      "sensitive data",
    ],
    [
      "a customer email address",
      {
        files: {
          "dist/index.js": 'export const contact = "customer@acme.test";\n',
        },
      },
      "sensitive data",
    ],
    [
      "a private path",
      {
        files: {
          "dist/index.js": "export const path = '/opt/savept/product';\n",
        },
      },
      "private path",
    ],
    [
      "an unexpected packed file",
      {
        expectedFiles: [
          "LICENSE",
          "dist/index.d.ts",
          "dist/index.js",
          "package.json",
        ],
        files: { "dist/debug.log": "debug\n" },
        manifest: { files: ["dist", "LICENSE"] },
      },
      "unexpected packed file",
    ],
    [
      "missing license metadata",
      { manifest: { license: undefined } },
      "license",
    ],
  ])("rejects a candidate with %s", (_description, options, diagnostic) => {
    const workspaceRoot = createWorkspace();
    writeReleaseFixture(workspaceRoot, options);

    const result = runValidation(workspaceRoot);

    expect(result.status).toBe(1);
    expect(result.output).toContain(`RELEASE_POLICY_BLOCKED: ${diagnostic}`);
    expect(result.output).not.toContain("exampleToken1234567890");
  });

  it("requires validation CI least privilege and a non-executable provenance publishing contract", () => {
    const workspaceRoot = createWorkspace();
    mkdirSync(join(workspaceRoot, ".github", "workflows"), { recursive: true });
    mkdirSync(join(workspaceRoot, "release"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, ".github", "workflows", "ci.yml"),
      "permissions:\n  contents: read\n",
    );
    writeFileSync(
      join(workspaceRoot, "release", "trusted-publishing-policy.json"),
      JSON.stringify({
        futurePublishJob: {
          allowListGate: true,
          environment: "npm-production",
          protectedEnvironmentReview: true,
          provenanceArgs: ["publish", "--provenance"],
          scopedPermissions: ["contents: read", "id-token: write"],
        },
        validationOnly: true,
        version: 1,
      }),
    );

    expect(validateWorkflowPolicy(workspaceRoot)).toEqual([]);
    writeFileSync(
      join(workspaceRoot, ".github", "workflows", "ci.yml"),
      "permissions:\n  id-token: write\n",
    );
    expect(validateWorkflowPolicy(workspaceRoot)).toContain(
      "ordinary CI must use contents: read only",
    );
  });

  it("rejects a second workflow with publication authority", () => {
    const workspaceRoot = createWorkspace();
    mkdirSync(join(workspaceRoot, ".github", "workflows"), { recursive: true });
    mkdirSync(join(workspaceRoot, "release"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, ".github", "workflows", "ci.yml"),
      "permissions:\n  contents: read\n",
    );
    writeFileSync(
      join(workspaceRoot, ".github", "workflows", "publish.yml"),
      "on: workflow_dispatch\npermissions:\n  id-token: write\n",
    );
    writeFileSync(
      join(workspaceRoot, "release", "trusted-publishing-policy.json"),
      JSON.stringify({
        futurePublishJob: {
          allowListGate: true,
          environment: "npm-production",
          protectedEnvironmentReview: true,
          provenanceArgs: ["publish", "--provenance"],
          scopedPermissions: ["contents: read", "id-token: write"],
        },
        validationOnly: true,
        version: 1,
      }),
    );

    expect(validateWorkflowPolicy(workspaceRoot)).toContain(
      "workflow publish.yml has publication authority",
    );
  });

  it("rejects publication authority hidden in the ordinary CI workflow", () => {
    const workspaceRoot = createWorkspace();
    mkdirSync(join(workspaceRoot, ".github", "workflows"), { recursive: true });
    mkdirSync(join(workspaceRoot, "release"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, ".github", "workflows", "ci.yml"),
      "permissions:\n  contents: read\njobs:\n  validate:\n    steps:\n      - run: npm publish\n",
    );
    writeFileSync(
      join(workspaceRoot, "release", "trusted-publishing-policy.json"),
      JSON.stringify({
        futurePublishJob: {
          allowListGate: true,
          environment: "npm-production",
          protectedEnvironmentReview: true,
          provenanceArgs: ["publish", "--provenance"],
          scopedPermissions: ["contents: read", "id-token: write"],
        },
        validationOnly: true,
        version: 1,
      }),
    );

    expect(validateWorkflowPolicy(workspaceRoot)).toContain(
      "workflow ci.yml has publication authority",
    );
  });

  it("rejects private Savept references embedded in a packed artifact", () => {
    const workspaceRoot = createWorkspace();
    writeReleaseFixture(workspaceRoot, {
      files: {
        "dist/index.js":
          'export const internal = "@savept/product https://internal.savept.example";\n',
      },
    });

    const result = runValidation(workspaceRoot);

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "RELEASE_POLICY_BLOCKED: private Savept reference",
    );
  });

  it.each(["mts", "cts"])(
    "rejects allow-listed packed .%s source leakage",
    (extension) => {
      const workspaceRoot = createWorkspace();
      writeReleaseFixture(workspaceRoot, {
        expectedFiles: [
          "LICENSE",
          `dist/leak.${extension}`,
          "dist/index.d.ts",
          "dist/index.js",
          "package.json",
        ],
        files: { [`dist/leak.${extension}`]: "export const leaked = true;\n" },
      });
      const result = runValidation(workspaceRoot);
      expect(result.status).toBe(1);
      expect(result.output).toContain(
        "RELEASE_POLICY_BLOCKED: forbidden packed path",
      );
    },
  );

  it("allows a compiled dist .mjs export", () => {
    const workspaceRoot = createWorkspace();
    writeReleaseFixture(workspaceRoot, {
      expectedFiles: [
        "LICENSE",
        "dist/index.d.ts",
        "dist/index.js",
        "dist/index.mjs",
        "package.json",
      ],
      files: { "dist/index.mjs": 'export const packageValue = "clean";\n' },
      manifest: { exports: { ".": "./dist/index.mjs" } },
    });

    expect(runValidation(workspaceRoot).status).toBe(0);
  });

  it("discovers packages matched by packages/** without parsing unrelated YAML lists", () => {
    const workspaceRoot = createWorkspace();
    writeReleaseFixture(workspaceRoot);
    writeFileSync(
      join(workspaceRoot, "pnpm-workspace.yaml"),
      "packages:\n  - packages/**\nallowBuilds:\n  - unrelated/*\n",
    );
    writeWorkspacePackage(workspaceRoot, "packages/deep/nested/unlisted", {
      name: "@savept/unlisted",
      private: false,
      version: "1.0.0",
    });
    const result = runValidation(workspaceRoot);
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "RELEASE_POLICY_BLOCKED: non-private package @savept/unlisted is not allow-listed",
    );
  });

  it("removes a tarball when installed-package import fails", () => {
    const workspaceRoot = createWorkspace();
    writeReleaseFixture(workspaceRoot, {
      files: { "dist/index.js": "export const = ;\n" },
    });
    expect(runValidation(workspaceRoot).status).toBe(1);
    expect(
      readdirSync(join(workspaceRoot, "packages", "release-fixture")),
    ).not.toContain("savept-release-fixture-1.2.3.tgz");
  });
});
