import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  globSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { minimatch } from "minimatch";
import { isAlias, isMap, isSeq, parseDocument } from "yaml";

class PolicyError extends Error {}
const npmExecutable = join(dirname(process.execPath), "npm");
const npmRegistry = "https://registry.npmjs.org/";
const ignoredWorkspaceDirectories = [".git", "node_modules"];
const forbiddenLifecycleScripts = new Set([
  "preinstall",
  "install",
  "postinstall",
  "preprepare",
  "prepare",
  "postprepare",
  "prepack",
  "postpack",
  "prepublish",
  "prepublishOnly",
  "preversion",
  "version",
  "postversion",
]);

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

function hasUnsafeYamlNode(node) {
  if (!node) return false;
  if (node.anchor || node.tag || isAlias(node)) return true;
  if (isMap(node))
    return node.items.some(
      (pair) => hasUnsafeYamlNode(pair.key) || hasUnsafeYamlNode(pair.value),
    );
  return isSeq(node) && node.items.some(hasUnsafeYamlNode);
}
function parseYamlObject(source, description) {
  let document;
  try {
    document = parseDocument(source, { prettyErrors: false, uniqueKeys: true });
  } catch {
    fail(`${description} is invalid YAML`);
  }
  if (
    document.errors.length > 0 ||
    document.warnings.length > 0 ||
    !isMap(document.contents) ||
    hasUnsafeYamlNode(document.contents)
  )
    fail(`${description} is invalid or unsafe YAML`);
  const value = document.toJS();
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${description} has an unsafe YAML shape`);
  return value;
}
function workspacePatterns(workspaceRoot) {
  const configPath = join(workspaceRoot, "pnpm-workspace.yaml");
  if (!existsSync(configPath)) fail("pnpm workspace configuration is missing");
  const config = parseYamlObject(
    readFileSync(configPath, "utf8"),
    "pnpm workspace configuration",
  );
  if (!Array.isArray(config.packages) || config.packages.length === 0)
    fail("pnpm workspace packages must be a non-empty pattern list");
  if (
    config.packages.some(
      (pattern) => typeof pattern !== "string" || !pattern.trim(),
    )
  )
    fail("pnpm workspace packages must contain only non-empty strings");
  return config.packages;
}
function allManifestPaths(workspaceRoot) {
  return globSync("**/package.json", { cwd: workspaceRoot }).filter(
    (path) =>
      !path
        .split("/")
        .some((part) => ignoredWorkspaceDirectories.includes(part)),
  );
}
function matchesWorkspacePatterns(packageDirectory, patterns) {
  let included = false;
  for (const pattern of patterns) {
    const negative = pattern.startsWith("!");
    const body = negative ? pattern.slice(1) : pattern;
    if (!body || body.startsWith("/") || body.split("/").includes(".."))
      fail("pnpm workspace contains an unsafe package pattern");
    if (minimatch(packageDirectory, body.replace(/\/$/, ""), { dot: true }))
      included = !negative;
  }
  return included;
}
function findManifests(workspaceRoot) {
  const patterns = workspacePatterns(workspaceRoot);
  const manifestPaths = allManifestPaths(workspaceRoot).filter((path) =>
    matchesWorkspacePatterns(dirname(path), patterns),
  );
  if (manifestPaths.length === 0) {
    const hiddenNonPrivate = allManifestPaths(workspaceRoot).find(
      (path) =>
        readJson(join(workspaceRoot, path), "workspace package manifest")
          .private === false,
    );
    if (hiddenNonPrivate)
      fail(
        "pnpm workspace resolves to zero package manifests while a non-private package exists",
      );
  }
  return manifestPaths.sort().map((manifestPath) => ({
    manifest: readJson(
      join(workspaceRoot, manifestPath),
      `package manifest at ${join(workspaceRoot, manifestPath)}`,
    ),
    root: dirname(join(workspaceRoot, manifestPath)),
  }));
}
function findAllManifests(workspaceRoot) {
  return allManifestPaths(workspaceRoot)
    .sort()
    .map((manifestPath) => ({
      manifest: readJson(
        join(workspaceRoot, manifestPath),
        `package manifest at ${join(workspaceRoot, manifestPath)}`,
      ),
      root: dirname(join(workspaceRoot, manifestPath)),
    }));
}
function validateRepositoryManifestPolicy(
  workspaceManifests,
  allManifests,
  allowListNames,
) {
  const workspaceRoots = new Set(
    workspaceManifests.map((candidate) => resolve(candidate.root)),
  );
  const byName = new Map();
  for (const candidate of allManifests) {
    const { manifest } = candidate;
    if (typeof manifest.name !== "string")
      fail("repository package has no name");
    if (byName.has(manifest.name)) fail("duplicate repository package name");
    byName.set(manifest.name, candidate);
    if (
      !workspaceRoots.has(resolve(candidate.root)) &&
      manifest.private !== true
    )
      fail(`non-workspace package ${manifest.name} must be private`);
  }
  for (const candidate of workspaceManifests)
    if (
      candidate.manifest.private !== true &&
      !allowListNames.has(candidate.manifest.name)
    )
      fail(
        `non-private package ${candidate.manifest.name ?? "unknown"} is not allow-listed`,
      );
  return byName;
}

function validateAllowList(allowList) {
  if (
    allowList.version !== 1 ||
    Object.keys(allowList).some((key) => !["packages", "version"].includes(key))
  )
    fail("publication allow-list schema is invalid");
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
    )
      fail("publication allow-list has an invalid package entry");
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
function validatePublishConfig(manifest) {
  const config = manifest.publishConfig;
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    Object.keys(config).some((key) => !["access", "registry"].includes(key)) ||
    config.access !== "public" ||
    config.registry !== npmRegistry ||
    /@|\?.*|#/.test(config.registry)
  )
    fail(`publishConfig is invalid for ${manifest.name ?? "unknown"}`);
}
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
  validatePublishConfig(manifest);
  if (
    typeof manifest.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)
  )
    fail(`candidate ${manifest.name} has an invalid version`);
  if (
    !manifest.exports ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0
  )
    fail(`candidate ${manifest.name} requires exports and files`);
  if (
    typeof manifest.license !== "string" ||
    !approvedSpdx.has(manifest.license) ||
    manifest.license !== allowListEntry.license
  )
    fail(`license metadata is invalid for ${manifest.name}`);
  if (!existsSync(join(candidate.root, "LICENSE")))
    fail(`license file is missing for ${manifest.name}`);
  for (const scriptName of forbiddenLifecycleScripts)
    if (manifest.scripts?.[scriptName])
      fail(`lifecycle script ${scriptName} is forbidden`);
  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ])
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (
        typeof version !== "string" ||
        /^(workspace:|file:|git\+|git:|github:|ssh:|https?:.*\.git(?:#.*)?$)/.test(
          version,
        )
      )
        fail(`dependency ${name} in ${section} is inappropriate`);
      if (name.startsWith("@savept/")) {
        const dependency = candidatesByName.get(name);
        if (
          !dependency ||
          dependency.manifest.private !== false ||
          !allowListNames.has(name)
        )
          fail(
            `dependency ${name} in ${section} is not an approved public package`,
          );
      }
    }
}

function npmEnvironment() {
  const safeEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(?:npm_|NPM_|NODE_AUTH_TOKEN$)/.test(name),
    ),
  );
  return {
    ...safeEnvironment,
    HOME: join(tmpdir(), "savept-npm-home"),
    npm_config_cache: join(tmpdir(), "savept-npm-cache"),
    npm_config_globalconfig: join(tmpdir(), "savept-empty-global.npmrc"),
    npm_config_registry: npmRegistry,
    npm_config_userconfig: join(tmpdir(), "savept-empty-user.npmrc"),
  };
}
function runNpm(args, cwd) {
  return execFileSync(npmExecutable, args, {
    cwd,
    encoding: "utf8",
    env: npmEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function parsePackResult(output) {
  try {
    const result = JSON.parse(output);
    if (
      !Array.isArray(result) ||
      result.length !== 1 ||
      typeof result[0].filename !== "string"
    )
      fail("npm pack produced invalid metadata");
    return result[0];
  } catch (error) {
    if (error instanceof PolicyError) throw error;
    fail("npm pack did not return JSON metadata");
  }
}
function hash(contents) {
  return createHash("sha256").update(contents).digest("hex");
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
    )
      fail(
        `export target is unsafe or unpacked for ${candidate.manifest.name}`,
      );
  }
}
function privateSaveptHostname(text) {
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>`]+/gi)) {
    let hostname;
    try {
      hostname = new URL(match[0]).hostname.toLowerCase();
    } catch {
      continue;
    }
    const labels = hostname.split(".");
    if (
      labels.includes("savept") &&
      (labels.includes("internal") || labels.includes("private"))
    )
      return true;
  }
  return false;
}
function inspectTarball(candidate, tarball, expectedFiles) {
  const extractionRoot = mkdtempSync(join(tmpdir(), "savept-packed-artifact-"));
  try {
    const files = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .filter((entry) => !entry.endsWith("/"))
      .map((entry) => {
        if (
          !entry.startsWith("package/") ||
          entry.includes("../") ||
          entry.startsWith("/")
        )
          fail(
            `packed artifact has an unsafe path for ${candidate.manifest.name}`,
          );
        return entry.slice("package/".length);
      })
      .sort();
    if (JSON.stringify(files) !== JSON.stringify([...expectedFiles].sort()))
      fail(`unexpected packed file for ${candidate.manifest.name}`);
    execFileSync("tar", ["-xzf", tarball, "-C", extractionRoot], {
      encoding: "utf8",
    });
    const packageRoot = join(extractionRoot, "package");
    validateExports(candidate, files);
    const inspectedFiles = new Map();
    for (const filePath of files) {
      const fullPath = resolve(packageRoot, filePath);
      if (
        !fullPath.startsWith(`${packageRoot}${sep}`) ||
        !statSync(fullPath).isFile()
      )
        fail(
          `packed artifact has an unsafe file for ${candidate.manifest.name}`,
        );
      if (
        /(^|\/)(?:\.env(?:\.|$)|\.git(?:\/|$)|\.github(?:\/|$)|node_modules(?:\/|$)|src(?:\/|$)|source(?:\/|$)|[^/]+\.(?:tgz|tsx|mts|cts|map)$|[^/]+(?<!\.d)\.ts$|(?:npmrc|yarnrc|pnpmfile\.cjs)$)/i.test(
          filePath,
        )
      )
        fail(`forbidden packed path for ${candidate.manifest.name}`);
      const content = readFileSync(fullPath);
      const text = content.toString("utf8");
      if (
        /(?:gh[pousr]_[A-Za-z0-9_-]{12,}|npm_[A-Za-z0-9_-]{12,}|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i.test(
          text,
        )
      )
        fail(
          `sensitive data detected in packed artifact for ${candidate.manifest.name}`,
        );
      if (
        /(?:\/savept\/(?:product|private)|\\savept\\(?:product|private)|\/Users\/[^/]+\/projects\/savept)/i.test(
          text,
        )
      )
        fail(
          `private path detected in packed artifact for ${candidate.manifest.name}`,
        );
      if (/@savept\/(?:product|private)/i.test(text))
        fail(
          `private Savept reference detected in packed artifact for ${candidate.manifest.name}`,
        );
      if (privateSaveptHostname(text))
        fail(
          `private Savept hostname detected in packed artifact for ${candidate.manifest.name}`,
        );
      inspectedFiles.set(filePath, hash(content));
    }
    return {
      cleanup: () => rmSync(extractionRoot, { force: true, recursive: true }),
      files: inspectedFiles,
    };
  } catch (error) {
    rmSync(extractionRoot, { force: true, recursive: true });
    throw error;
  }
}
function nodeRuntimeEntries(exports) {
  const entries = [];
  const resolveCondition = (value, mode) => {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object" || Array.isArray(value))
      fail("exports has an unsupported Node runtime shape");
    const keys = Object.keys(value);
    if (keys.length === 0) fail("exports has no Node runtime target");
    for (const key of keys) {
      if (key === "node-addons")
        fail("node-addons exports are unsupported for Node runtime validation");
      if (!["default", "import", "node", "require", "types"].includes(key))
        fail(
          `exports condition ${key} is unsupported for Node runtime validation`,
        );
      if (typeof value[key] !== "string" && typeof value[key] !== "object")
        fail("exports has an unsupported Node runtime target");
      if (
        value[key] &&
        typeof value[key] === "object" &&
        Array.isArray(value[key])
      )
        fail("exports has an unsupported Node runtime target");
    }
    for (const [key, target] of Object.entries(value)) {
      if (key === "node" || key === mode || key === "default")
        return resolveCondition(target, mode);
    }
    return undefined;
  };
  const addConditions = (specifier, value) => {
    if (typeof value === "string") {
      entries.push({ mode: "import", specifier });
      return;
    }
    const importTarget = resolveCondition(value, "import");
    const requireTarget = resolveCondition(value, "require");
    if (importTarget) entries.push({ mode: "import", specifier });
    if (requireTarget) entries.push({ mode: "require", specifier });
  };
  if (typeof exports === "string") {
    addConditions(".", exports);
  } else if (
    exports &&
    typeof exports === "object" &&
    !Array.isArray(exports)
  ) {
    const keys = Object.keys(exports);
    const subpaths = keys.every((key) => key === "." || key.startsWith("./"));
    const conditions = keys.every(
      (key) =>
        key === "default" ||
        key === "import" ||
        key === "node" ||
        key === "require" ||
        key === "types" ||
        key === "node-addons",
    );
    if (!subpaths && !conditions)
      fail("exports mixes unsupported subpath and condition shapes");
    if (subpaths) {
      for (const specifier of keys) {
        if (specifier.includes("..") || specifier.includes("*"))
          fail("exports has an unsupported Node runtime subpath");
        addConditions(specifier, exports[specifier]);
      }
    } else {
      addConditions(".", exports);
    }
  } else {
    fail("exports has an unsupported Node runtime shape");
  }
  if (entries.length === 0) fail("exports has no Node runtime target");
  return entries;
}
function installedSpecifier(packageName, exportSpecifier) {
  return exportSpecifier === "."
    ? packageName
    : `${packageName}/${exportSpecifier.slice(2)}`;
}
function validateCleanConsumer(candidate, tarball, inspectedFiles) {
  const tempRoot = mkdtempSync(join(tmpdir(), "savept-clean-consumer-"));
  try {
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
        "--registry",
        npmRegistry,
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
    )
      fail(
        `clean consumer install did not use a tarball for ${candidate.manifest.name}`,
      );
    for (const [filePath, expectedHash] of inspectedFiles) {
      const installedPath = resolve(installed, filePath);
      if (
        !installedPath.startsWith(`${installed}${sep}`) ||
        !existsSync(installedPath) ||
        hash(readFileSync(installedPath)) !== expectedHash
      )
        fail(
          `clean consumer artifact identity mismatch for ${candidate.manifest.name}`,
        );
    }
    // Node validation executes explicit import/default and require targets only;
    // types-only and browser-only exports are never treated as Node runtime code.
    for (const entry of nodeRuntimeEntries(candidate.manifest.exports)) {
      const specifier = installedSpecifier(
        candidate.manifest.name,
        entry.specifier,
      );
      const program =
        entry.mode === "require"
          ? `import { createRequire } from "node:module"; createRequire(import.meta.url)(${JSON.stringify(specifier)});`
          : `await import(${JSON.stringify(specifier)});`;
      execFileSync(
        process.execPath,
        ["--input-type=module", "--eval", program],
        {
          cwd: tempRoot,
          encoding: "utf8",
          env: {
            HOME: join(tempRoot, "home"),
            PATH: process.env.PATH ?? "",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    }
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

function validateWorkflowDocument(name, source) {
  let workflow;
  try {
    workflow = parseYamlObject(source, `workflow ${name}`);
  } catch (error) {
    return [
      error instanceof PolicyError
        ? error.message.replace("RELEASE_POLICY_BLOCKED: ", "")
        : `workflow ${name} is invalid`,
    ];
  }
  if (
    Object.keys(workflow).some(
      (key) =>
        !["concurrency", "jobs", "name", "on", "permissions"].includes(key),
    )
  )
    return [`workflow ${name} has unsupported configuration`];
  const triggers = workflow.on;
  const triggerNames = Array.isArray(triggers)
    ? triggers
    : triggers && typeof triggers === "object"
      ? Object.keys(triggers)
      : typeof triggers === "string"
        ? [triggers]
        : [];
  if (
    triggerNames.some((trigger) => !["push", "pull_request"].includes(trigger))
  )
    return [`workflow ${name} has publication authority`];
  if (
    workflow.permissions !== undefined &&
    (Object.keys(workflow.permissions ?? {}).length !== 1 ||
      workflow.permissions?.contents !== "read")
  )
    return ["ordinary CI must use contents: read only"];
  if (containsPublishRun(workflow))
    return [`workflow ${name} has publication authority`];
  if (
    workflow.concurrency !== undefined &&
    (!workflow.concurrency ||
      typeof workflow.concurrency !== "object" ||
      Array.isArray(workflow.concurrency) ||
      Object.keys(workflow.concurrency).some(
        (key) => !["group", "cancel-in-progress"].includes(key),
      ) ||
      typeof workflow.concurrency.group !== "string" ||
      typeof workflow.concurrency["cancel-in-progress"] !== "boolean")
  )
    return [`workflow ${name} has unsupported configuration`];
  if (workflow.jobs === undefined) return [];
  if (
    !workflow.jobs ||
    typeof workflow.jobs !== "object" ||
    Array.isArray(workflow.jobs) ||
    Object.keys(workflow.jobs).some((jobName) => jobName !== "validate")
  )
    return [`workflow ${name} has unsupported configuration`];
  const job = workflow.jobs.validate;
  if (
    !job ||
    typeof job !== "object" ||
    Array.isArray(job) ||
    Object.keys(job).some(
      (key) => !["runs-on", "steps", "timeout-minutes"].includes(key),
    ) ||
    job["runs-on"] !== "ubuntu-latest" ||
    !Number.isInteger(job["timeout-minutes"]) ||
    job["timeout-minutes"] > 15 ||
    job["timeout-minutes"] < 1 ||
    !Array.isArray(job.steps)
  )
    return [`workflow ${name} has unsupported configuration`];
  const allowedUses = new Set([
    "actions/checkout@v7",
    "asdf-vm/actions/install@v4.0.1",
  ]);
  const allowedRuns = new Set([
    "pnpm install --frozen-lockfile",
    "pnpm policy:check",
    "pnpm test:policy",
    "pnpm format:check",
    "pnpm check",
    "pnpm release:validate",
    "pnpm release:current",
  ]);
  for (const step of job.steps) {
    if (
      !step ||
      typeof step !== "object" ||
      Array.isArray(step) ||
      Object.keys(step).some((key) => !["name", "run", "uses"].includes(key)) ||
      (typeof step.name !== "undefined" && typeof step.name !== "string") ||
      (typeof step.uses === "string" && typeof step.run === "string") ||
      (typeof step.uses !== "string" && typeof step.run !== "string")
    )
      return [`workflow ${name} has unsupported configuration`];
    if (typeof step.uses === "string" && !allowedUses.has(step.uses))
      return [`workflow ${name} has unsupported configuration`];
    if (typeof step.run === "string" && !allowedRuns.has(step.run))
      return [
        /\bnpm(?:\s+--[^\s]+)*\s+publish\b/i.test(step.run)
          ? `workflow ${name} has publication authority`
          : `workflow ${name} has unsupported configuration`,
      ];
  }
  return [];
}
function containsPublishRun(value) {
  if (typeof value === "string")
    return /\bnpm(?:\s+--[^\s]+)*\s+publish\b/i.test(value);
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some(containsPublishRun);
}
export function validateWorkflowPolicy(workspaceRoot) {
  const policyPath = join(
    workspaceRoot,
    "release",
    "trusted-publishing-policy.json",
  );
  let policy;
  try {
    policy = JSON.parse(
      existsSync(policyPath) ? readFileSync(policyPath, "utf8") : "",
    );
  } catch {
    return ["trusted publishing policy is invalid JSON"];
  }
  const workflowsRoot = join(workspaceRoot, ".github", "workflows");
  const diagnostics = [];
  for (const workflow of existsSync(workflowsRoot)
    ? globSync("*.y*ml", { cwd: workflowsRoot })
    : [])
    diagnostics.push(
      ...validateWorkflowDocument(
        workflow,
        readFileSync(join(workflowsRoot, workflow), "utf8"),
      ),
    );
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
  )
    diagnostics.push(
      "future publish policy must require allow-list, reviewed environment, job-scoped OIDC, and provenance",
    );
  if (
    /npm\s+publish|NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./i.test(
      JSON.stringify(policy),
    )
  )
    diagnostics.push(
      "trusted publishing policy must not contain an executable publish command or token",
    );
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
  const byName = validateRepositoryManifestPolicy(
    manifests,
    findAllManifests(workspaceRoot),
    allowedNames,
  );
  for (const entry of allowList.packages) {
    const candidate = byName.get(entry.name);
    if (!candidate) fail(`allow-listed package ${entry.name} is unknown`);
    validateManifest(candidate, byName, allowedNames, entry);
    let tarball;
    let inspection;
    try {
      const pack = parsePackResult(
        runNpm(["pack", "--ignore-scripts", "--json"], candidate.root),
      );
      tarball = join(candidate.root, pack.filename);
      if (!existsSync(tarball))
        fail(
          `npm pack did not create a tarball for ${candidate.manifest.name}`,
        );
      inspection = inspectTarball(candidate, tarball, entry.expectedFiles);
      validateCleanConsumer(candidate, tarball, inspection.files);
      console.log(
        `RELEASE_VALIDATED: ${candidate.manifest.name}@${candidate.manifest.version} packed and installed cleanly`,
      );
    } finally {
      inspection?.cleanup();
      if (tarball) rmSync(tarball, { force: true });
    }
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
  )
    fail("publication allow-list schema is invalid");
  const workflowDiagnostics = validateWorkflowPolicy(workspaceRoot);
  if (workflowDiagnostics.length > 0) fail(workflowDiagnostics[0]);
  const manifests = findManifests(workspaceRoot);
  validateRepositoryManifestPolicy(
    manifests,
    findAllManifests(workspaceRoot),
    new Set(allowList.packages.map((entry) => entry?.name)),
  );
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
