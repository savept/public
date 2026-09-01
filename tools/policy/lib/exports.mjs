import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

import { block } from "./errors.mjs";
import { isWithin } from "./paths.mjs";

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

export function validateExportsTree(value, packageRoot, repositoryRoot) {
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

export function selectExportEntry(exportsValue, subpath) {
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

export function exportEntryAllows(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return true;
  if (Array.isArray(value)) return value.some(exportEntryAllows);
  if (typeof value === "object")
    return Object.values(value).some(exportEntryAllows);
  return false;
}
