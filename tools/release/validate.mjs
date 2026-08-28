import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

class PolicyError extends Error {}

function fail(message) {
  throw new PolicyError(`RELEASE_POLICY_BLOCKED: ${message}`);
}

function readJson(filePath, description) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    fail(`${description} is invalid JSON`);
  }
}

function packageDirectoryForName(packageName) {
  return packageName.startsWith("@") ? packageName.split("/") : [packageName];
}

function workspacePatterns(workspaceRoot) {
  const config = readFileSync(
    join(workspaceRoot, "pnpm-workspace.yaml"),
    "utf8",
  );
  const packageSection =
    config.match(/^packages:\n((?:\s+-\s+.+\n?)*)/m)?.[1] ?? "";
  return [...packageSection.matchAll(/^\s*-\s+(.+)$/gm)].map((match) =>
    match[1].trim(),
  );
}

function matchesWorkspacePattern(relativePath, pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`).test(relativePath);
}

function findManifests(workspaceRoot) {
  const patterns = workspacePatterns(workspaceRoot);
  const manifests = [];
  function visit(directory, relativeDirectory = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if ([".git", "dist", "node_modules", "tmp"].includes(entry.name))
        continue;
      const relative = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath, relative);
      if (entry.isFile() && entry.name === "package.json") {
        const packagePath = relative.slice(0, -"/package.json".length);
        if (
          patterns.some((pattern) =>
            matchesWorkspacePattern(packagePath, pattern),
          )
        ) {
          manifests.push({
            manifest: readJson(fullPath, `package manifest at ${fullPath}`),
            root: directory,
          });
        }
      }
    }
  }
  visit(workspaceRoot);
  return manifests;
}

function validateAllowList(allowList) {
  if (
    allowList.version !== 1 ||
    Object.keys(allowList).some((key) => !["packages", "version"].includes(key))
  ) {
    fail("publication allow-list schema is invalid");
  }
  if (!Array.isArray(allowList.packages))
    fail("publication allow-list has no packages array");
  if (allowList.packages.length === 0) fail("publication allow-list is empty");
  const names = new Set();
  for (const entry of allowList.packages) {
    if (
      !entry ||
      typeof entry.name !== "string" ||
      !Array.isArray(entry.expectedFiles) ||
      Object.keys(entry).some(
        (key) => !["expectedFiles", "license", "name"].includes(key),
      )
    ) {
      fail("publication allow-list has an invalid package entry");
    }
    if (names.has(entry.name)) fail("duplicate allow-list package");
    names.add(entry.name);
  }
  return names;
}

const approvedSpdx = new Set([
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
  "MPL-2.0",
]);

function validateManifest(
  candidate,
  candidatesByName,
  allowListNames,
  allowListEntry,
) {
  const { manifest } = candidate;
  if (manifest.private !== false)
    fail(`candidate ${manifest.name ?? "unknown"} must set private to false`);
  if (typeof manifest.name !== "string" || !manifest.name.startsWith("@"))
    fail("candidate name is invalid");
  if (
    typeof manifest.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)
  ) {
    fail(`candidate ${manifest.name} has an invalid version`);
  }
  if (
    !manifest.exports ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0
  ) {
    fail(`candidate ${manifest.name} requires exports and files`);
  }
  if (
    typeof manifest.license !== "string" ||
    !approvedSpdx.has(manifest.license) ||
    manifest.license !== allowListEntry.license
  ) {
    fail(`license metadata is invalid for ${manifest.name}`);
  }
  if (!existsSync(join(candidate.root, "LICENSE")))
    fail(`license file is missing for ${candidate.manifest.name}`);
  for (const scriptName of [
    "preinstall",
    "install",
    "postinstall",
    "prepare",
  ]) {
    if (manifest.scripts?.[scriptName])
      fail(`lifecycle script ${scriptName} is forbidden`);
  }
  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (
        typeof version !== "string" ||
        /^(workspace:|file:|git\+|git:|github:|ssh:|https?:.*\.git(?:#.*)?$)/.test(
          version,
        )
      ) {
        fail(`dependency ${name} in ${section} is inappropriate`);
      }
      if (name.startsWith("@savept/")) {
        const dependency = candidatesByName.get(name);
        if (
          !dependency ||
          dependency.manifest.private !== false ||
          !allowListNames.has(name)
        ) {
          fail(
            `dependency ${name} in ${section} is not an approved public package`,
          );
        }
      }
    }
  }
}

function runNpm(args, cwd) {
  return execFileSync(join(dirname(process.execPath), "npm"), args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_cache: join(tmpdir(), "savept-npm-cache"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parsePackResult(output) {
  try {
    const result = JSON.parse(output);
    if (
      !Array.isArray(result) ||
      result.length !== 1 ||
      !Array.isArray(result[0].files)
    )
      fail("npm pack produced invalid metadata");
    return result[0];
  } catch (error) {
    if (error instanceof PolicyError) throw error;
    fail("npm pack did not return JSON metadata");
  }
}

function exportTargets(value) {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(exportTargets);
}

function validateExports(candidate, packedFiles) {
  const targets = exportTargets(candidate.manifest.exports);
  if (targets.length === 0)
    fail(`candidate ${candidate.manifest.name} has no export targets`);
  for (const target of targets) {
    const packedPath = target.replace(/^\.\//, "");
    if (
      !target.startsWith("./") ||
      target.includes("..") ||
      !packedPath.startsWith("dist/") ||
      !packedFiles.includes(packedPath)
    ) {
      fail(
        `export target is unsafe or unpacked for ${candidate.manifest.name}`,
      );
    }
  }
}

function validatePackedFiles(candidate, expectedFiles) {
  const packed = parsePackResult(
    runNpm(["pack", "--dry-run", "--json"], candidate.root),
  );
  const actualFiles = packed.files.map((file) => file.path).sort();
  const expected = [...expectedFiles].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expected))
    fail(`unexpected packed file for ${candidate.manifest.name}`);
  validateExports(candidate, actualFiles);
  for (const filePath of actualFiles) {
    if (
      /(^|\/)(?:\.env(?:\.|$)|\.git(?:\/|$)|\.github(?:\/|$)|node_modules(?:\/|$)|src(?:\/|$)|source(?:\/|$)|[^/]+\.(?:tgz|tsx|mts|cts|map)$|[^/]+(?<!\.d)\.ts$|(?:npmrc|yarnrc|pnpmfile\.cjs)$)/i.test(
        filePath,
      )
    ) {
      fail(`forbidden packed path for ${candidate.manifest.name}`);
    }
    const content = readFileSync(join(candidate.root, filePath), "utf8");
    if (
      /(?:gh[pousr]_[A-Za-z0-9_-]{12,}|npm_[A-Za-z0-9_-]{12,}|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i.test(
        content,
      )
    ) {
      fail(
        `sensitive data detected in packed artifact for ${candidate.manifest.name}`,
      );
    }
    if (
      /(?:\/savept\/(?:product|private)|\\savept\\(?:product|private)|\/Users\/[^/]+\/projects\/savept)/i.test(
        content,
      )
    ) {
      fail(
        `private path detected in packed artifact for ${candidate.manifest.name}`,
      );
    }
    if (
      /@savept\/(?:product|private)|https?:\/\/[^\s"']*(?:internal|private)[^\s"']*savept/i.test(
        content,
      )
    ) {
      fail(
        `private Savept reference detected in packed artifact for ${candidate.manifest.name}`,
      );
    }
  }
}

function validateCleanConsumer(candidate) {
  const tempRoot = mkdtempSync(join(tmpdir(), "savept-clean-consumer-"));
  let tarball;
  try {
    const pack = parsePackResult(runNpm(["pack", "--json"], candidate.root));
    tarball = join(candidate.root, pack.filename);
    writeFileSync(
      join(tempRoot, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    runNpm(
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--offline",
        tarball,
      ],
      tempRoot,
    );
    const installed = join(
      tempRoot,
      "node_modules",
      ...packageDirectoryForName(candidate.manifest.name),
    );
    if (
      !existsSync(join(installed, "package.json")) ||
      realpathSync(installed).startsWith(resolve(candidate.root))
    ) {
      fail(
        `clean consumer install did not use a tarball for ${candidate.manifest.name}`,
      );
    }
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(candidate.manifest.name)})`,
      ],
      {
        cwd: tempRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } finally {
    if (tarball) rmSync(tarball, { force: true });
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

export function validateWorkflowPolicy(workspaceRoot) {
  const diagnostics = [];
  const ciPath = join(workspaceRoot, ".github", "workflows", "ci.yml");
  const policyPath = join(
    workspaceRoot,
    "release",
    "trusted-publishing-policy.json",
  );
  const ci = existsSync(ciPath) ? readFileSync(ciPath, "utf8") : "";
  const policySource = existsSync(policyPath)
    ? readFileSync(policyPath, "utf8")
    : "";
  let policy;
  try {
    policy = JSON.parse(policySource);
  } catch {
    return ["trusted publishing policy is invalid JSON"];
  }
  if (
    !/^permissions:\n  contents: read\s*$/m.test(ci) ||
    /id-token:|packages:|actions:|write/.test(ci)
  ) {
    diagnostics.push("ordinary CI must use contents: read only");
  }
  const workflowsRoot = join(workspaceRoot, ".github", "workflows");
  for (const entry of existsSync(workflowsRoot)
    ? readdirSync(workflowsRoot, { withFileTypes: true })
    : []) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
    const source = readFileSync(join(workflowsRoot, entry.name), "utf8");
    if (
      /npm\s+publish|id-token:|NPM_TOKEN|NODE_AUTH_TOKEN|secrets\.|workflow_dispatch|(?:^|\n)\s*release:|packages:\s*write|contents:\s*write/i.test(
        source,
      )
    ) {
      diagnostics.push(`workflow ${entry.name} has publication authority`);
    }
  }
  const job = policy.futurePublishJob;
  if (
    policy.version !== 1 ||
    Object.keys(policy).some(
      (key) => !["futurePublishJob", "validationOnly", "version"].includes(key),
    ) ||
    policy.validationOnly !== true ||
    !job ||
    job.allowListGate !== true ||
    job.protectedEnvironmentReview !== true ||
    typeof job.environment !== "string" ||
    JSON.stringify(job.scopedPermissions) !==
      JSON.stringify(["contents: read", "id-token: write"]) ||
    JSON.stringify(job.provenanceArgs) !==
      JSON.stringify(["publish", "--provenance"])
  ) {
    diagnostics.push(
      "future publish policy must require allow-list, reviewed environment, job-scoped OIDC, and provenance",
    );
  }
  if (/npm\s+publish|NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./i.test(policySource)) {
    diagnostics.push(
      "trusted publishing policy must not contain an executable publish command or token",
    );
  }
  return diagnostics;
}

export function validateWorkspace(workspaceRoot) {
  const allowListPath = join(workspaceRoot, "release", "allow-list.json");
  if (!existsSync(allowListPath)) fail("publication allow-list is missing");
  const allowList = readJson(allowListPath, "publication allow-list");
  const allowedNames = validateAllowList(allowList);
  const workflowDiagnostics = validateWorkflowPolicy(workspaceRoot);
  if (workflowDiagnostics.length > 0) fail(workflowDiagnostics[0]);
  const manifests = findManifests(workspaceRoot);
  const byName = new Map();
  for (const candidate of manifests) {
    if (typeof candidate.manifest.name !== "string")
      fail("workspace package has no name");
    if (byName.has(candidate.manifest.name))
      fail("duplicate workspace package name");
    byName.set(candidate.manifest.name, candidate);
  }
  for (const candidate of manifests) {
    if (
      candidate.manifest.private !== true &&
      !allowedNames.has(candidate.manifest.name)
    ) {
      fail(
        `non-private package ${candidate.manifest.name ?? "unknown"} is not allow-listed`,
      );
    }
  }
  for (const entry of allowList.packages) {
    const candidate = byName.get(entry.name);
    if (!candidate) fail(`allow-listed package ${entry.name} is unknown`);
    validateManifest(candidate, byName, allowedNames, entry);
    validatePackedFiles(candidate, entry.expectedFiles);
    validateCleanConsumer(candidate);
    console.log(
      `RELEASE_VALIDATED: ${candidate.manifest.name}@${candidate.manifest.version} packed and installed cleanly`,
    );
  }
}

export function validateCurrentWorkspace(workspaceRoot) {
  const allowListPath = join(workspaceRoot, "release", "allow-list.json");
  if (!existsSync(allowListPath)) fail("publication allow-list is missing");
  const allowList = readJson(allowListPath, "publication allow-list");
  if (
    !Array.isArray(allowList.packages) ||
    allowList.version !== 1 ||
    Object.keys(allowList).some((key) => !["packages", "version"].includes(key))
  ) {
    fail("publication allow-list schema is invalid");
  }
  const workflowDiagnostics = validateWorkflowPolicy(workspaceRoot);
  if (workflowDiagnostics.length > 0) fail(workflowDiagnostics[0]);
  const manifests = findManifests(workspaceRoot);
  const names = new Set();
  for (const candidate of manifests) {
    if (
      typeof candidate.manifest.name !== "string" ||
      names.has(candidate.manifest.name)
    )
      fail("duplicate workspace package name");
    names.add(candidate.manifest.name);
    if (candidate.manifest.private !== true && allowList.packages.length === 0)
      fail(
        `non-private package ${candidate.manifest.name} is not allow-listed`,
      );
  }
  if (allowList.packages.length === 0)
    return "RELEASE_CONFIGURATION_SAFELY_BLOCKED: publication allow-list is empty";
  validateWorkspace(workspaceRoot);
  return "RELEASE_CONFIGURATION_VALIDATED";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rootArgumentIndex = process.argv.indexOf("--root");
  const workspaceRoot =
    rootArgumentIndex === -1
      ? process.cwd()
      : resolve(process.argv[rootArgumentIndex + 1]);
  try {
    console.log(
      process.argv.includes("--current")
        ? validateCurrentWorkspace(workspaceRoot)
        : validateWorkspace(workspaceRoot),
    );
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "RELEASE_POLICY_BLOCKED: validation failed",
    );
    process.exitCode = 1;
  }
}
