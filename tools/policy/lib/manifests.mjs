import path from "node:path";

import { block } from "./errors.mjs";
import { isWithin } from "./paths.mjs";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

export function parseJson(content, label) {
  try {
    return JSON.parse(content);
  } catch (error) {
    block(`${label} is invalid JSON: ${error.message}`);
  }
}

export function dependencyEntries(manifest) {
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

function unsafeDependencyRange(range) {
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

export function validateDependencyRange({
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
      (selector && unsafeDependencyRange(selector))
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
  if (unsafeDependencyRange(normalized))
    block(
      `dependency must use a registry-resolved range in ${entry.name}: ${dependency}`,
    );
}

export function owningPackage(packages, candidate) {
  return packages.find((entry) => isWithin(entry.path, candidate));
}

export function recordWorkspaceEdge(edges, owner, target) {
  if (!edges || !owner || !target || owner.path === target.path) return;
  let targets = edges.get(owner.path);
  if (!targets) {
    targets = new Set();
    edges.set(owner.path, targets);
  }
  targets.add(target.path);
}
