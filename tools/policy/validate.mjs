import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const BLOCKED = "WORKSPACE_POLICY_BLOCKED";
const SOURCE_EXTENSIONS = [
  ".d.ts",
  ".tsx",
  ".mts",
  ".cts",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".js",
];
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".nx",
  ".astro",
  "generated",
  "__generated__",
]);
const MANIFEST_EXCLUDED_DIRECTORIES = new Set([".git", "node_modules"]);
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

function block(message) {
  throw new Error(`${BLOCKED}: ${message}`);
}

function normalizeVersion(value, label) {
  const normalized = String(value).trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(normalized))
    block(`malformed ${label} tool version`);
  return normalized;
}

export function parseToolVersions(text) {
  const found = { nodejs: [], pnpm: [] };
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    if (fields[0] !== "nodejs" && fields[0] !== "pnpm") continue;
    if (fields.length !== 2) block(`malformed ${fields[0]} tool version entry`);
    found[fields[0]].push(normalizeVersion(fields[1], fields[0]));
  }
  for (const tool of ["nodejs", "pnpm"]) {
    if (found[tool].length !== 1)
      block(`expected exactly one ${tool} tool version entry`);
  }
  return { nodejs: found.nodejs[0], pnpm: found.pnpm[0] };
}

function commandVersion(value, label, toolName) {
  if (value instanceof Error)
    block(`toolchain ${label} failed: ${value.message}`);
  const text = String(value).trim();
  if (label.startsWith("asdf current")) {
    const lines = text
      .split(/\r?\n/)
      .map((candidate) => candidate.trim())
      .filter((candidate) => candidate.split(/\s+/)[0] === toolName);
    if (lines.length !== 1)
      block(`toolchain ${label} must report exactly one ${toolName} entry`);
    return normalizeVersion(lines[0].split(/\s+/)[1], label);
  }
  return normalizeVersion(text, label);
}

export function checkToolchain({
  expectedNode,
  expectedPnpm,
  processNode,
  asdfCurrentNode,
  asdfCurrentPnpm,
  asdfExecNode,
  asdfExecPnpm,
}) {
  const node = normalizeVersion(expectedNode, "expected nodejs");
  const pnpm = normalizeVersion(expectedPnpm, "expected pnpm");
  const evidence = [
    [
      "process.version",
      commandVersion(processNode, "process.version", "nodejs"),
      node,
    ],
    [
      "asdf current nodejs",
      commandVersion(asdfCurrentNode, "asdf current nodejs", "nodejs"),
      node,
    ],
    [
      "asdf current pnpm",
      commandVersion(asdfCurrentPnpm, "asdf current pnpm", "pnpm"),
      pnpm,
    ],
    [
      "asdf exec node --version",
      commandVersion(asdfExecNode, "asdf exec node --version", "nodejs"),
      node,
    ],
    [
      "asdf exec pnpm --version",
      commandVersion(asdfExecPnpm, "asdf exec pnpm --version", "pnpm"),
      pnpm,
    ],
  ];
  for (const [label, actual, expected] of evidence) {
    if (actual !== expected)
      block(`toolchain ${label} reported ${actual}; expected ${expected}`);
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function parseWorkspaceDiscovery({
  root,
  status,
  signal,
  stdout,
  stderr,
  error,
  resolvePath = path.resolve,
}) {
  if (error)
    block(`workspace discovery command failed: ${error.message ?? error}`);
  if (signal) block(`workspace discovery terminated by signal ${signal}`);
  if (status !== 0)
    block(`workspace discovery exited with status ${String(status)}`);
  if (!String(stdout ?? "").trim()) {
    const detail = String(stderr ?? "").trim();
    block(`workspace discovery produced no JSON${detail ? `: ${detail}` : ""}`);
  }
  let decoded;
  try {
    decoded = JSON.parse(String(stdout));
  } catch (error_) {
    block(`workspace discovery returned malformed JSON: ${error_.message}`);
  }
  if (!Array.isArray(decoded))
    block("workspace discovery JSON must be an array");
  let normalizedRoot;
  try {
    normalizedRoot = resolvePath(root);
  } catch (error_) {
    block(`workspace discovery root cannot be resolved: ${error_.message}`);
  }
  const names = new Set();
  const paths = new Set();
  return decoded.map((record, index) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      block(`workspace discovery record ${index} is malformed`);
    }
    const name = typeof record.name === "string" ? record.name.trim() : "";
    let recordPath = "";
    if (typeof record.path === "string") {
      try {
        recordPath = resolvePath(record.path);
      } catch (error_) {
        block(
          `workspace discovery path cannot be resolved: ${record.path}: ${error_.message}`,
        );
      }
    }
    if (!name || !recordPath)
      block(`workspace discovery record ${index} is missing name or path`);
    if (!isWithin(normalizedRoot, recordPath))
      block(`workspace discovery path is outside repository: ${recordPath}`);
    if (names.has(name))
      block(`workspace discovery contains duplicate name: ${name}`);
    if (paths.has(recordPath))
      block(`workspace discovery contains duplicate path: ${recordPath}`);
    names.add(name);
    paths.add(recordPath);
    return { name, path: recordPath };
  });
}

function isExcluded(relativePath) {
  return relativePath
    .split(path.sep)
    .some((segment) => EXCLUDED_DIRECTORIES.has(segment));
}

function isManifestExcluded(relativePath) {
  return relativePath
    .split(path.sep)
    .some((segment) => MANIFEST_EXCLUDED_DIRECTORIES.has(segment));
}

function isPackageManifest(relativePath) {
  return path.basename(relativePath) === "package.json";
}

function normalizeFiles(root, files) {
  const normalized = new Map();
  for (const file of files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      typeof file.content !== "string"
    ) {
      block("file inventory contains a malformed record");
    }
    const absolute = path.isAbsolute(file.path)
      ? path.resolve(file.path)
      : path.resolve(root, file.path);
    if (!isWithin(root, absolute))
      block(`file inventory path escapes repository: ${file.path}`);
    const relative = path.relative(root, absolute);
    if (
      isExcluded(relative) &&
      (!isPackageManifest(relative) || isManifestExcluded(relative))
    ) {
      continue;
    }
    if (normalized.has(relative))
      block(`file inventory contains duplicate path: ${relative}`);
    normalized.set(relative, file.content);
  }
  return normalized;
}

function parseJson(content, label) {
  try {
    return JSON.parse(content);
  } catch (error) {
    block(`${label} is invalid JSON: ${error.message}`);
  }
}

function packageSpecifier(specifier) {
  const pieces = specifier.split("/");
  if (specifier.startsWith("@")) {
    if (pieces.length < 2) return { name: specifier, subpath: "." };
    return {
      name: `${pieces[0]}/${pieces[1]}`,
      subpath: pieces.length === 2 ? "." : `./${pieces.slice(2).join("/")}`,
    };
  }
  return {
    name: pieces[0],
    subpath: pieces.length === 1 ? "." : `./${pieces.slice(1).join("/")}`,
  };
}

function validateExportTarget(target, packageRoot, repositoryRoot) {
  if (!target.startsWith("./"))
    block(`export target must be package-relative: ${target}`);
  const resolved = path.resolve(packageRoot, target);
  if (!isWithin(packageRoot, resolved) || !isWithin(repositoryRoot, resolved)) {
    block(`export target escapes package or repository: ${target}`);
  }
  let canonicalPackageRoot;
  let canonicalRepositoryRoot;
  try {
    canonicalPackageRoot = realpathSync(packageRoot);
    canonicalRepositoryRoot = realpathSync(repositoryRoot);
  } catch {
    return;
  }
  let component = packageRoot;
  const components = path
    .relative(packageRoot, resolved)
    .split(path.sep)
    .filter(Boolean);
  for (const part of components) {
    component = path.join(component, part);
    let stats;
    try {
      stats = lstatSync(component);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") break;
      block(`export target cannot be inspected: ${target}`);
    }
    if (!stats.isSymbolicLink()) continue;
    let canonical;
    try {
      canonical = realpathSync(component);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR")
        block(`export target contains a dangling symlink: ${target}`);
      block(`export target cannot be resolved: ${target}`);
    }
    if (
      !isWithin(canonicalPackageRoot, canonical) ||
      !isWithin(canonicalRepositoryRoot, canonical)
    ) {
      block(`export target escapes package or repository: ${target}`);
    }
  }
  let existing = resolved;
  while (true) {
    try {
      existing = realpathSync(existing);
      break;
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR")
        block(`export target cannot be resolved: ${target}`);
      const parent = path.dirname(existing);
      if (parent === existing) return;
      existing = parent;
    }
  }
  if (
    !isWithin(canonicalPackageRoot, existing) ||
    !isWithin(canonicalRepositoryRoot, existing)
  ) {
    block(`export target escapes package or repository: ${target}`);
  }
}

function validateExportsTree(value, packageRoot, repositoryRoot) {
  if (value === null) return;
  if (typeof value === "string") {
    validateExportTarget(value, packageRoot, repositoryRoot);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value)
      validateExportsTree(item, packageRoot, repositoryRoot);
    return;
  }
  if (!value || typeof value !== "object")
    block("export entry must be a string, array, object, or null");
  const keys = Object.keys(value);
  const dotKeys = keys.filter((key) => key.startsWith("."));
  if (dotKeys.length > 0 && dotKeys.length !== keys.length)
    block("export map mixes subpaths and conditions");
  for (const child of Object.values(value))
    validateExportsTree(child, packageRoot, repositoryRoot);
}

function selectExportEntry(exportsValue, subpath) {
  if (
    exportsValue === null ||
    typeof exportsValue === "string" ||
    Array.isArray(exportsValue)
  ) {
    return subpath === "." ? exportsValue : undefined;
  }
  if (!exportsValue || typeof exportsValue !== "object") return undefined;
  const keys = Object.keys(exportsValue);
  if (!keys.some((key) => key.startsWith(".")))
    return subpath === "." ? exportsValue : undefined;
  if (Object.hasOwn(exportsValue, subpath)) return exportsValue[subpath];
  const wildcard = keys
    .filter((key) => key.includes("*"))
    .map((key) => {
      const [prefix, suffix] = key.split("*");
      const matches = subpath.startsWith(prefix) && subpath.endsWith(suffix);
      return {
        key,
        keyLength: key.length,
        prefixLength: prefix.length,
        matches,
      };
    })
    .filter(({ matches }) => matches)
    .sort(
      (left, right) =>
        right.prefixLength - left.prefixLength ||
        right.keyLength - left.keyLength,
    )[0];
  return wildcard ? exportsValue[wildcard.key] : undefined;
}

function exportEntryAllows(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return true;
  if (Array.isArray(value)) return value.some(exportEntryAllows);
  if (typeof value === "object")
    return Object.values(value).some(exportEntryAllows);
  return false;
}

function dependencyEntries(manifest) {
  const entries = new Map();
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = manifest[field];
    if (dependencies === undefined) continue;
    if (
      !dependencies ||
      typeof dependencies !== "object" ||
      Array.isArray(dependencies)
    ) {
      block(`${manifest.name} ${field} must be an object`);
    }
    for (const [name, range] of Object.entries(dependencies)) {
      if (entries.has(name))
        block(`${manifest.name} has ${name} in multiple dependency fields`);
      entries.set(name, range);
    }
  }
  return entries;
}

function isUnsafeDependencyRange(range) {
  return (
    path.isAbsolute(range) ||
    path.win32.isAbsolute(range) ||
    range.startsWith(".") ||
    range.startsWith("\\") ||
    /^[a-z][a-z\d+.-]*:/i.test(range) ||
    /^git@[^:]+:/i.test(range) ||
    /^[^/@\s]+\/[^/\s]+(?:#.*)?$/.test(range)
  );
}

function validateDependencyRange({
  dependency,
  range,
  entry,
  manifestsByName,
}) {
  if (typeof range !== "string" || !range.trim())
    block(
      `dependency range must be a non-empty string in ${entry.name}: ${dependency}`,
    );
  const normalized = range.trim();
  const local = manifestsByName.get(dependency);
  if (normalized.startsWith("workspace:")) {
    const selector = normalized.slice("workspace:".length);
    if (!local) {
      block(
        `workspace dependency must use a local workspace package in ${entry.name}: ${dependency}`,
      );
    }
    if (
      selector.includes("@") ||
      (selector && isUnsafeDependencyRange(selector))
    ) {
      block(
        `local dependency must use a genuine workspace selector in ${entry.name}: ${dependency}`,
      );
    }
    return;
  }
  if (local)
    block(
      `local dependency must use workspace: in ${entry.name}: ${dependency}`,
    );
  if (isUnsafeDependencyRange(normalized))
    block(
      `dependency must use a registry-resolved range in ${entry.name}: ${dependency}`,
    );
}

function validateSpecifier({
  specifier,
  sourcePath,
  owner,
  packages,
  importedWorkspaceDependencies,
  manifestsByName,
  repositoryRoot,
}) {
  if (path.isAbsolute(specifier) || path.win32.isAbsolute(specifier)) {
    block(
      `absolute source import is not allowed in ${sourcePath}: ${specifier}`,
    );
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(specifier)) {
    if (specifier.startsWith("node:")) return;
    block(`import protocol is not allowed in ${sourcePath}: ${specifier}`);
  }
  if (specifier.startsWith(".")) {
    const normalized = specifier.replaceAll("\\", "/");
    const resolved = path.resolve(
      path.dirname(path.join(repositoryRoot, sourcePath)),
      normalized,
    );
    if (!isWithin(repositoryRoot, resolved))
      block(
        `relative import escapes repository in ${sourcePath}: ${specifier}`,
      );
    const target = owningPackage(packages, resolved);
    if (target && target.path !== owner.path)
      block(
        `relative import bypasses package boundary in ${sourcePath}: ${specifier}`,
      );
    return;
  }
  const { name, subpath } = packageSpecifier(specifier);
  const target = manifestsByName.get(name);
  if (name.startsWith("@savept/") && !target)
    block(`unknown or private Savept package in ${sourcePath}: ${name}`);
  if (!target) return;
  if (owner.name !== target.name) {
    const declared = dependencyEntries(owner.manifest);
    if (!declared.has(target.name))
      block(
        `local bare import is not declared by ${owner.name}: ${target.name}`,
      );
  }
  const entry = selectExportEntry(target.manifest.exports, subpath);
  if (!exportEntryAllows(entry))
    block(`package subpath is not exported by ${target.name}: ${subpath}`);
  if (owner.path !== target.path)
    recordWorkspaceEdge(importedWorkspaceDependencies, owner, target);
}

const MAX_STATIC_STRING_ANALYSIS_NODES = 1_024;

function staticStringValue(expression) {
  let remainingNodes = MAX_STATIC_STRING_ANALYSIS_NODES;
  function evaluate(node) {
    if (!node) return undefined;
    remainingNodes -= 1;
    if (remainingNodes < 0)
      block("static module specifier analysis exceeded complexity budget");
    if (ts.isStringLiteralLike(node)) return node.text;
    if (
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isParenthesizedExpression(node)
    ) {
      return evaluate(node.expression);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = evaluate(node.left);
      const right = evaluate(node.right);
      if (left === undefined || right === undefined) return undefined;
      return left + right;
    }
    return undefined;
  }
  return evaluate(expression);
}

function isRequireResolveCallee(expression) {
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "require" &&
    expression.name.text === "resolve"
  );
}

function isRequireCallee(expression) {
  if (ts.isIdentifier(expression)) return expression.text === "require";
  if (ts.isPropertyAccessExpression(expression)) {
    return (
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === "module" &&
      expression.name.text === "require"
    );
  }
  if (ts.isElementAccessExpression(expression)) {
    return (
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === "module" &&
      staticStringValue(expression.argumentExpression) === "require"
    );
  }
  if (
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isParenthesizedExpression(expression)
  )
    return isRequireCallee(expression.expression);
  return (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.CommaToken &&
    isRequireCallee(expression.right)
  );
}

function sourceSpecifiers(content, fileName) {
  const source = ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    true,
  );
  const found = [];
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text);
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      found.push(node.moduleReference.expression.text);
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      found.push(node.argument.literal.text);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const specifier = staticStringValue(node.arguments?.[0]);
      if (
        specifier !== undefined &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          isRequireCallee(node.expression) ||
          isRequireResolveCallee(node.expression))
      ) {
        found.push(specifier);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

function normalizeConfigPath(value, label, configPath) {
  if (typeof value !== "string" || !value.trim())
    block(`${label} in ${configPath} must be a path string`);
  const normalized = value.trim().replaceAll("\\", "/");
  if (
    path.isAbsolute(normalized) ||
    path.win32.isAbsolute(normalized) ||
    /^[a-z][a-z\d+.-]*:/i.test(normalized)
  ) {
    block(
      `tsconfig ${label} has an unsafe config path in ${configPath}: ${value}`,
    );
  }
  return normalized;
}

function resolveConfigPath(
  repositoryRoot,
  configPath,
  value,
  label,
  { baseDirectory } = {},
) {
  const normalized = normalizeConfigPath(value, label, configPath);
  const resolved = path.resolve(
    baseDirectory ?? path.dirname(path.join(repositoryRoot, configPath)),
    normalized,
  );
  if (!isWithin(repositoryRoot, resolved))
    block(`tsconfig ${label} escapes repository in ${configPath}: ${value}`);
  return resolved;
}

function validateExtends({
  repositoryRoot,
  configPath,
  value,
  owner,
  manifestsByName,
}) {
  const entries = typeof value === "string" ? [value] : value;
  if (!Array.isArray(entries) || entries.length === 0)
    block(
      `tsconfig extends in ${configPath} must be a non-empty string or array`,
    );
  for (const entry of entries) {
    const normalized = normalizeConfigPath(entry, "extends", configPath);
    if (normalized.startsWith("."))
      resolveConfigPath(repositoryRoot, configPath, normalized, "extends");
    else {
      validateSpecifier({
        specifier: normalized,
        sourcePath: configPath,
        owner,
        manifestsByName,
        repositoryRoot,
      });
    }
  }
}

function owningPackage(packages, candidate) {
  return packages.find((entry) => isWithin(entry.path, candidate));
}

function recordWorkspaceEdge(edges, owner, target) {
  if (!edges || !owner || !target || owner.path === target.path) return;
  let targets = edges.get(owner.path);
  if (!targets) {
    targets = new Set();
    edges.set(owner.path, targets);
  }
  targets.add(target.path);
}

function validateTsconfig({
  repositoryRoot,
  configPath,
  content,
  packages,
  manifestsByName,
}) {
  const parsed = ts.parseConfigFileTextToJson(configPath, content);
  if (parsed.error) {
    const detail = ts.flattenDiagnosticMessageText(
      parsed.error.messageText,
      " ",
    );
    block(`tsconfig ${configPath} is invalid JSONC: ${detail}`);
  }
  const config = parsed.config;
  const configOwner = owningPackage(
    packages,
    path.join(repositoryRoot, configPath),
  );
  if (config.extends !== undefined)
    validateExtends({
      repositoryRoot,
      configPath,
      value: config.extends,
      owner: configOwner,
      manifestsByName,
    });
  if (config.references !== undefined) {
    if (!Array.isArray(config.references))
      block(`tsconfig references in ${configPath} must be an array`);
  }
  const compilerOptions = config.compilerOptions ?? {};
  let pathsBase = path.dirname(path.join(repositoryRoot, configPath));
  if (compilerOptions.baseUrl !== undefined) {
    pathsBase = resolveConfigPath(
      repositoryRoot,
      configPath,
      compilerOptions.baseUrl,
      "baseUrl",
    );
    const baseUrlOwner = owningPackage(packages, pathsBase);
    if (
      !configOwner ||
      (baseUrlOwner && baseUrlOwner.path !== configOwner.path)
    ) {
      block(`tsconfig baseUrl bypasses package exports in ${configPath}`);
    }
  }
  if (compilerOptions.paths !== undefined) {
    if (
      !compilerOptions.paths ||
      typeof compilerOptions.paths !== "object" ||
      Array.isArray(compilerOptions.paths)
    ) {
      block(`tsconfig paths in ${configPath} must be an object`);
    }
    for (const [alias, targets] of Object.entries(compilerOptions.paths)) {
      if (!Array.isArray(targets) || targets.length === 0)
        block(`tsconfig paths target for ${alias} is malformed`);
      for (const target of targets) {
        const normalized = normalizeConfigPath(
          target,
          `paths target for ${alias}`,
          configPath,
        );
        const resolved = path.resolve(
          pathsBase,
          normalized.replace(/\*.*$/, ""),
        );
        if (!isWithin(repositoryRoot, resolved))
          block(
            `tsconfig paths target escapes repository in ${configPath}: ${target}`,
          );
        if (owningPackage(packages, resolved)) {
          block(
            `tsconfig path alias bypasses package exports in ${configPath}: ${alias}`,
          );
        }
      }
    }
  }
  return { config, owner: configOwner };
}

function validateProjectReferences({
  repositoryRoot,
  configPath,
  config,
  owner,
  packages,
  validatedTsconfigs,
  projectReferences,
}) {
  if (config.references === undefined) return;
  for (const reference of config.references) {
    const resolved = resolveConfigPath(
      repositoryRoot,
      configPath,
      reference?.path,
      "reference path",
    );
    const targetConfigPath =
      path.extname(resolved).toLowerCase() === ".json"
        ? resolved
        : path.join(resolved, "tsconfig.json");
    const relativeTargetPath = path.relative(repositoryRoot, targetConfigPath);
    const target = validatedTsconfigs.get(relativeTargetPath);
    if (!target) {
      block(
        `tsconfig project reference does not resolve to an inventoried tsconfig in ${configPath}: ${reference.path}`,
      );
    }
    if (!target.owner || !owningPackage(packages, targetConfigPath)) {
      block(
        `tsconfig project reference must resolve to a workspace package config in ${configPath}: ${reference.path}`,
      );
    }
    recordWorkspaceEdge(projectReferences, owner, target.owner);
  }
}

export function validatePolicy({
  root,
  toolVersionsText,
  toolchain,
  workspaceRecords,
  files,
}) {
  const repositoryRoot = path.resolve(root);
  const expected = parseToolVersions(toolVersionsText);
  checkToolchain({
    expectedNode: expected.nodejs,
    expectedPnpm: expected.pnpm,
    ...toolchain,
  });
  if (workspaceRecords instanceof Error)
    block(`workspace discovery failed: ${workspaceRecords.message}`);
  if (!Array.isArray(workspaceRecords))
    block("workspace discovery did not produce records");
  const records = parseWorkspaceDiscovery({
    root: repositoryRoot,
    status: 0,
    stdout: JSON.stringify(workspaceRecords),
    stderr: "",
  });
  const inventory = normalizeFiles(repositoryRoot, files);
  if (
    [...inventory.keys()].some(
      (filePath) => path.basename(filePath) === ".gitmodules",
    )
  ) {
    block(".gitmodules is prohibited in the public repository");
  }

  const manifestsByName = new Map();
  const manifestsByPath = [];
  const importedWorkspaceDependencies = new Map();
  const projectReferences = new Map();
  const discoveredManifestPaths = new Set(
    records.map((record) => {
      const relativeDirectory = path.relative(repositoryRoot, record.path);
      return relativeDirectory
        ? path.join(relativeDirectory, "package.json")
        : "package.json";
    }),
  );
  for (const filePath of inventory.keys()) {
    if (
      path.basename(filePath) === "package.json" &&
      !discoveredManifestPaths.has(filePath)
    ) {
      block(`package.json is missing from workspace discovery: ${filePath}`);
    }
  }
  for (const record of records) {
    const relativeDirectory = path.relative(repositoryRoot, record.path);
    const manifestPath = relativeDirectory
      ? path.join(relativeDirectory, "package.json")
      : "package.json";
    const content = inventory.get(manifestPath);
    if (content === undefined)
      block(`workspace package manifest is missing: ${manifestPath}`);
    const manifest = parseJson(content, manifestPath);
    if (manifest.name !== record.name)
      block(`workspace discovery name does not match ${manifestPath}`);
    const entry = { name: record.name, path: record.path, manifest };
    manifestsByName.set(record.name, entry);
    manifestsByPath.push(entry);
    if (manifest.exports !== undefined)
      validateExportsTree(manifest.exports, record.path, repositoryRoot);
  }
  manifestsByPath.sort((left, right) => right.path.length - left.path.length);

  for (const entry of manifestsByPath) {
    for (const [dependency, range] of dependencyEntries(entry.manifest)) {
      const local = manifestsByName.get(dependency);
      if (dependency.startsWith("@savept/") && !local) {
        block(
          `unknown or private Savept dependency in ${entry.name}: ${dependency}`,
        );
      }
      validateDependencyRange({ dependency, range, entry, manifestsByName });
    }
  }

  const validatedTsconfigs = new Map();
  for (const [filePath, content] of inventory) {
    if (!/^tsconfig.*\.json$/.test(path.basename(filePath))) continue;
    const validated = validateTsconfig({
      repositoryRoot,
      configPath: filePath,
      content,
      packages: manifestsByPath,
      manifestsByName,
    });
    validatedTsconfigs.set(filePath, validated);
  }
  for (const [filePath, validated] of validatedTsconfigs) {
    validateProjectReferences({
      repositoryRoot,
      configPath: filePath,
      ...validated,
      packages: manifestsByPath,
      validatedTsconfigs,
      projectReferences,
    });
  }

  for (const [filePath, content] of inventory) {
    const absolute = path.join(repositoryRoot, filePath);
    if (!SOURCE_EXTENSIONS.some((extension) => filePath.endsWith(extension)))
      continue;
    const owner = manifestsByPath.find((entry) =>
      isWithin(entry.path, absolute),
    );
    if (!owner)
      block(`source file is not owned by a workspace package: ${filePath}`);
    let canonicalAbsolute;
    try {
      canonicalAbsolute = realpathSync(absolute);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR")
        block(`source file cannot be resolved: ${filePath}`);
    }
    const canonicalOwner = canonicalAbsolute
      ? manifestsByPath.find((entry) => isWithin(entry.path, canonicalAbsolute))
      : owner;
    if (canonicalOwner && canonicalOwner.path !== owner.path)
      block(
        `source file symlink crosses a workspace package boundary in ${filePath}`,
      );
    for (const specifier of sourceSpecifiers(content, filePath)) {
      validateSpecifier({
        specifier,
        sourcePath: filePath,
        owner,
        packages: manifestsByPath,
        importedWorkspaceDependencies,
        manifestsByName,
        repositoryRoot,
      });
    }
  }
  for (const [ownerPath, targets] of importedWorkspaceDependencies) {
    const references = projectReferences.get(ownerPath);
    for (const targetPath of targets) {
      if (!references?.has(targetPath)) {
        const owner = manifestsByPath.find((entry) => entry.path === ownerPath);
        const target = manifestsByPath.find(
          (entry) => entry.path === targetPath,
        );
        block(
          `statically imported local dependency requires a matching TypeScript project reference: ${owner.name} -> ${target.name}`,
        );
      }
    }
  }
}

function commandEvidence(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error) return result.error;
  if (result.signal) return new Error(`terminated by signal ${result.signal}`);
  if (result.status !== 0) {
    return new Error(
      `exited with status ${String(result.status)}: ${String(result.stderr).trim()}`,
    );
  }
  if (!String(result.stdout).trim() && String(result.stderr).trim()) {
    return new Error(String(result.stderr).trim());
  }
  return result.stdout;
}

function discoverWorkspace(realRoot) {
  const result = spawnSync(
    "asdf",
    [
      "exec",
      "pnpm",
      "--dir",
      realRoot,
      "list",
      "--recursive",
      "--depth",
      "-1",
      "--json",
      "--include-workspace-root",
    ],
    { cwd: realRoot, encoding: "utf8" },
  );
  return parseWorkspaceDiscovery({
    root: realRoot,
    ...result,
    resolvePath: realpathSync,
  });
}

export function collectFiles(realRoot) {
  const files = [];
  const visitedDirectories = new Set([realRoot]);
  function resolveSymbolicLink(absolute, relative) {
    try {
      return realpathSync(absolute);
    } catch (error) {
      if (error?.code === "ENOENT")
        block(`symbolic link is dangling: ${relative}`);
      block(`symbolic link cannot be resolved: ${relative}`);
    }
  }
  function targetExclusion(target) {
    const relativeTarget = path.relative(realRoot, target);
    const segments = relativeTarget.split(path.sep);
    if (segments.some((segment) => MANIFEST_EXCLUDED_DIRECTORIES.has(segment)))
      return { manifestsOnly: false, relativeTarget, skip: true };
    return {
      manifestsOnly: segments.some((segment) =>
        EXCLUDED_DIRECTORIES.has(segment),
      ),
      relativeTarget,
      skip: false,
    };
  }
  function walk(
    directory,
    relativeDirectory,
    isRoot = false,
    manifestsOnly = false,
  ) {
    const canonical = realpathSync(directory);
    if (!isRoot && visitedDirectories.has(canonical)) {
      if (manifestsOnly) return;
      block(
        `symbolic link creates a directory cycle or duplicate traversal: ${relativeDirectory}`,
      );
    }
    visitedDirectories.add(canonical);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = relativeDirectory
        ? path.join(relativeDirectory, entry.name)
        : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = resolveSymbolicLink(absolute, relative);
        if (!isWithin(realRoot, target))
          block(`symbolic link escapes repository: ${relative}`);
        const exclusion = targetExclusion(target);
        if (MANIFEST_EXCLUDED_DIRECTORIES.has(entry.name) || exclusion.skip)
          continue;
        const stats = lstatSync(target);
        const targetManifestsOnly =
          manifestsOnly ||
          EXCLUDED_DIRECTORIES.has(entry.name) ||
          exclusion.manifestsOnly;
        if (stats.isDirectory())
          walk(
            target,
            exclusion.manifestsOnly ? exclusion.relativeTarget : relative,
            false,
            targetManifestsOnly,
          );
        else if (
          stats.isFile() &&
          (!targetManifestsOnly || isPackageManifest(relative))
        )
          files.push({ path: relative, content: readFileSync(target, "utf8") });
      } else if (entry.isDirectory()) {
        if (MANIFEST_EXCLUDED_DIRECTORIES.has(entry.name)) continue;
        walk(
          absolute,
          relative,
          false,
          manifestsOnly || EXCLUDED_DIRECTORIES.has(entry.name),
        );
      } else if (
        entry.isFile() &&
        (!manifestsOnly || isPackageManifest(relative))
      ) {
        files.push({ path: relative, content: readFileSync(absolute, "utf8") });
      }
    }
  }
  walk(realRoot, "", true);
  return files;
}

function parseRootArgument(argv) {
  if (argv.length === 0) return process.cwd();
  if (argv.length === 2 && argv[0] === "--root" && argv[1])
    return path.resolve(argv[1]);
  block("usage: node tools/policy/validate.mjs [--root <repository-root>]");
}

export function runCli(argv = process.argv.slice(2)) {
  let realRoot;
  try {
    realRoot = realpathSync(parseRootArgument(argv));
  } catch (error) {
    block(`repository root cannot be resolved: ${error.message}`);
  }
  let toolVersionsText;
  try {
    toolVersionsText = readFileSync(
      path.join(realRoot, ".tool-versions"),
      "utf8",
    );
  } catch (error) {
    block(`tool versions cannot be read: ${error.message}`);
  }
  const versions = parseToolVersions(toolVersionsText);
  const workspaceRecords = discoverWorkspace(realRoot);
  validatePolicy({
    root: realRoot,
    toolVersionsText,
    toolchain: {
      processNode: process.version,
      asdfCurrentNode: commandEvidence("asdf", ["current", "nodejs"], realRoot),
      asdfCurrentPnpm: commandEvidence("asdf", ["current", "pnpm"], realRoot),
      asdfExecNode: commandEvidence(
        "asdf",
        ["exec", "node", "--version"],
        realRoot,
      ),
      asdfExecPnpm: commandEvidence(
        "asdf",
        ["exec", "pnpm", "--version"],
        realRoot,
      ),
      expectedNode: versions.nodejs,
      expectedPnpm: versions.pnpm,
    },
    workspaceRecords,
    files: collectFiles(realRoot),
  });
  process.stdout.write(
    `WORKSPACE_POLICY_PASSED: workspace policy passed for ${workspaceRecords.length} workspace packages\n`,
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
