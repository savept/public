import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

import { block } from "./errors.mjs";
import { isWithin } from "./paths.mjs";

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

function excluded(relativePath) {
  return relativePath
    .split(path.sep)
    .some((segment) => EXCLUDED_DIRECTORIES.has(segment));
}

function manifestExcluded(relativePath) {
  return relativePath
    .split(path.sep)
    .some((segment) => MANIFEST_EXCLUDED_DIRECTORIES.has(segment));
}

function isPackageManifest(relativePath) {
  return path.basename(relativePath) === "package.json";
}

export function normalizeFiles(root, files) {
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
      excluded(relative) &&
      (!isPackageManifest(relative) || manifestExcluded(relative))
    ) {
      continue;
    }
    if (normalized.has(relative))
      block(`file inventory contains duplicate path: ${relative}`);
    normalized.set(relative, file.content);
  }
  return normalized;
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

export function discoverWorkspace(realRoot) {
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
