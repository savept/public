import { realpathSync } from "node:fs";
import path from "node:path";

import { block } from "./errors.mjs";
import { isWithin } from "./paths.mjs";
import { validateExportsTree } from "./exports.mjs";
import {
  dependencyEntries,
  owningPackage,
  parseJson,
  validateDependencyRange,
} from "./manifests.mjs";
import { sourceSpecifiers, validateSpecifier } from "./specifier.mjs";
import { checkToolchain, parseToolVersions } from "./toolchain.mjs";
import { validateProjectReferences, validateTsconfig } from "./tsconfig.mjs";
import { normalizeFiles, parseWorkspaceDiscovery } from "./workspace.mjs";

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
